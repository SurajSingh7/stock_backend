import mongoose from "mongoose";
import { actorSnapshot } from "../models/plugins/actor.stamp.plugin.js";

import StockQuotationModel from "../models/stock.quotation.model.js";
import StockVendorModel from "../models/stock.vendor.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockCategoryModel from "../models/stock.category.model.js";
import StockCounterModel from "../models/stock.counter.model.js";
import StockVendorPurchaseHistoryModel from "../models/stock.vendor.purchase.history.model.js";
import StockVendorReviewModel from "../models/stock.vendor.review.model.js";
import StockTrackingOrderService from "./stock.tracking.order.service.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import StockCategoryService from "./stock.category.service.js";

import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import {
  applyDataScope,
  isWithinDataScope,
  resolveDimensionAllowList,
} from "../helpers/data.scope.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import {
  QUOTATION_STATUS,
  CATEGORY_APPROVAL_STATUS,
} from "../constants/stock.enums.js";

const log = getLogger(import.meta.url);
const ENTITY_TYPE = "quotations";

const escapeRegex = (str = "") =>
  String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const SCOPE_MODULE_KEY = "quotations";

// Guard for every by-id read AND every mutation. Throws the resource's normal
// "not found" rather than a 403 — a 403 would confirm that a quotation the
// caller may not see exists, which is what the scope is meant to hide.
const assertDataScope = (quotation, dataAccess) => {
  if (!isWithinDataScope(quotation, dataAccess, SCOPE_MODULE_KEY)) {
    throw new Error("Quotation not found");
  }
};

// Vendors a user may quote follow their BRANCH scope on the Quotations module
// (ALL → every branch's vendors, OWN → their branch, SELECTED → those
// branches; admin bypasses). Applied on the form reads AND on save, so a
// crafted request cannot price a vendor the form would never have shown.
const vendorScopeFilter = (dataAccess) => {
  const allowed = resolveDimensionAllowList(dataAccess, "branch");
  return allowed === null ? {} : { branchId: { $in: allowed } };
};

const pairKey = (vendorId, productId) => `${vendorId}::${productId}`;
const EMPTY_HISTORY = Object.freeze({ previousQuantity: null, previousPrice: null, averageRating: null });

// A vendor's own warranty for a product: its assignment override, else the
// product's default. Null when the vendor does not supply the product.
const vendorAssignment = (vendor, productId) =>
  (vendor.assignedProducts || [])
    .flatMap((ap) => ap.products || [])
    .find((p) => String(p.productId) === String(productId)) || null;

const defaultWarrantyOf = (assignment, product) =>
  assignment?.overrides?.warrantyMonths ?? product.warrantyMonths ?? null;

const gstOf = (product) =>
  typeof product.gstRate === "number" ? product.gstRate : Number(product.gstRate) || 0;

export default class StockQuotationService {
  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                 */
  /* ---------------------------------------------------------------------- */

  // Atomic: a single $inc on this year's counter row, so two concurrent
  // submits can never draw the same number (counting existing quotations and
  // adding one — the old scheme — gave both the same value). The first number
  // of a year seeds the row from the highest number already issued, so the
  // switch-over never re-issues one.
  static async generateQuotationNumber(session) {
    const year = new Date().getFullYear();
    const prefix = `QTN-${year}-`;
    const key = `QTN-${year}`;

    const bumped = await StockCounterModel.findOneAndUpdate(
      { _id: key },
      { $inc: { seq: 1 } },
      { new: true, session }
    ).lean();
    let seq = bumped?.seq;

    if (seq === undefined) {
      const [top] = await StockQuotationModel.aggregate([
        { $match: { quotationNumber: { $regex: `^${prefix}\\d+$` } } },
        {
          $group: {
            _id: null,
            max: { $max: { $toInt: { $substrCP: ["$quotationNumber", prefix.length, 12] } } },
          },
        },
      ]).session(session);
      const start = top?.max || 0;
      const seeded = await StockCounterModel.findOneAndUpdate(
        { _id: key },
        [{ $set: { seq: { $add: [{ $ifNull: ["$seq", start] }, 1] } } }],
        { new: true, upsert: true, session }
      ).lean();
      seq = seeded.seq;
    }

    return `${prefix}${String(seq).padStart(4, "0")}`;
  }

  // Latest purchase (qty + price) and average rating for every (vendor,
  // product) pair among the given ids — two queries in total, not two per
  // pair. Returns Map pairKey -> { previousQuantity, previousPrice, averageRating };
  // pairs with no history are simply absent (use EMPTY_HISTORY).
  //
  // Awaited one after the other, not Promise.all: with a transaction session
  // the driver rejects concurrent operations (see buildItems).
  static async getOfferHistory(vendorIds, productIds, session = null) {
    const history = new Map();
    if (!vendorIds.length || !productIds.length) return history;

    const toIds = (ids) => [...new Set(ids.map(String))].map((id) => new mongoose.Types.ObjectId(id));
    const match = {
      vendorId: { $in: toIds(vendorIds) },
      productDefinitionId: { $in: toIds(productIds) },
      isActive: true,
    };
    const groupId = { vendorId: "$vendorId", productDefinitionId: "$productDefinitionId" };
    const entry = ({ vendorId, productDefinitionId }) => {
      const key = pairKey(vendorId, productDefinitionId);
      if (!history.has(key)) history.set(key, { ...EMPTY_HISTORY });
      return history.get(key);
    };

    const purchases = await StockVendorPurchaseHistoryModel.aggregate([
      { $match: match },
      { $sort: { purchaseDate: -1 } },
      {
        $group: {
          _id: groupId,
          receivedQuantity: { $first: "$receivedQuantity" },
          purchasePrice: { $first: "$purchasePrice" },
        },
      },
    ]).session(session);
    purchases.forEach((r) => {
      const e = entry(r._id);
      e.previousQuantity = r.receivedQuantity;
      e.previousPrice = r.purchasePrice;
    });

    const ratings = await StockVendorReviewModel.aggregate([
      { $match: match },
      { $group: { _id: groupId, avg: { $avg: "$rating" } } },
    ]).session(session);
    ratings.forEach((r) => {
      entry(r._id).averageRating = round2(r.avg);
    });

    return history;
  }

  static computeTotals(quantity, unitPrice, gstRate) {
    const baseAmount = round2(quantity * unitPrice);
    const gstAmount = round2((baseAmount * (gstRate || 0)) / 100);
    const lineTotal = round2(baseAmount + gstAmount);
    return { baseAmount, gstAmount, lineTotal };
  }

  // Roll category decisions up into the stored document status.
  static computeDocStatus(categoryApprovals = []) {
    if (!categoryApprovals.length) return QUOTATION_STATUS.PENDING;
    const anyApproved = categoryApprovals.some(
      (c) => c.status === CATEGORY_APPROVAL_STATUS.APPROVED
    );
    const anyRejected = categoryApprovals.some(
      (c) => c.status === CATEGORY_APPROVAL_STATUS.REJECTED
    );
    if (anyApproved && anyRejected) return QUOTATION_STATUS.PARTIALLY_APPROVED;
    if (anyApproved) return QUOTATION_STATUS.APPROVED;
    return QUOTATION_STATUS.REJECTED;
  }

  // Active categories by id -> { name: display path ("A / B / Leaf") }.
  // Throws when any is missing or soft-deleted.
  static async resolveCategoryNames(categoryIds, session = null) {
    const ids = [...new Set(categoryIds.map(String))];
    const categories = await StockCategoryModel.find({ _id: { $in: ids }, isActive: true })
      .select("name path")
      .session(session)
      .lean();
    if (categories.length !== ids.length) throw new Error("Category not found or inactive");

    const names = new Map();
    for (const c of categories) {
      const displayPath = c.path ? await StockCategoryService.buildDisplayPath(c.path, session) : "";
      names.set(String(c._id), displayPath || c.name);
    }
    return names;
  }

  /*
    Item builder for create. Turns the product-level payload
    (see validateQuotationPayload) into the flat items[] the quotation stores —
    one line per (product, vendor) offer — so review, PO, tracking and invoice
    keep reading the same shape. The client supplies only what a person typed:
    which products and vendors, one quantity per product, prices, and an
    optional warranty override. Everything else is resolved here:
      - product must be active; its category (and the category's display path)
        comes from the product itself, never from the client
      - vendor must be active AND inside the caller's branch scope, and must
        supply the product (Postman cannot bypass either)
      - GST from the product; default warranty from the vendor's assignment
        override, else the product; a sent warrantyMonths overrides it for
        this quotation only
      - previous qty/price and average rating, batched
      - totals

    NOTE: All queries below that pass `.session(session)` are awaited
    sequentially, not via Promise.all. The MongoDB driver does not support
    running multiple concurrent operations on the same ClientSession inside
    a transaction — doing so intermittently throws:
      "Given transaction number X does not match any in-progress transactions"
    Promise.all is safe again once a query does NOT share this session.

    Returns { items, categoryIds }.
  */
  static async buildItems(rawProducts, dataAccess, session) {
    if (!Array.isArray(rawProducts) || rawProducts.length === 0) {
      throw new Error("At least one product must be selected");
    }

    const productIds = rawProducts.map((p) => String(p.productDefinitionId));
    const vendorIds = [...new Set(rawProducts.flatMap((p) => p.offers.map((o) => String(o.vendorId))))];

    const products = await StockProductDefinitionModel.find({ _id: { $in: productIds }, isActive: true })
      .select("name categoryId gstRate warrantyMonths")
      .session(session)
      .lean();
    const vendors = await StockVendorModel.find({
      _id: { $in: vendorIds },
      isActive: true,
      ...vendorScopeFilter(dataAccess),
    })
      .select("name assignedProducts")
      .session(session)
      .lean();

    const productMap = new Map(products.map((p) => [String(p._id), p]));
    const vendorMap = new Map(vendors.map((v) => [String(v._id), v]));

    const missingProduct = productIds.find((id) => !productMap.has(id));
    if (missingProduct) throw new Error(`Product not found or inactive: ${missingProduct}`);
    // Same message for "inactive" and "outside your branch scope" — the
    // difference is not the caller's business.
    const missingVendor = vendorIds.find((id) => !vendorMap.has(id));
    if (missingVendor) throw new Error(`Vendor not found or inactive: ${missingVendor}`);

    const categoryNames = await StockQuotationService.resolveCategoryNames(
      products.map((p) => p.categoryId),
      session
    );
    const history = await StockQuotationService.getOfferHistory(vendorIds, productIds, session);

    const items = [];
    for (const raw of rawProducts) {
      const product = productMap.get(String(raw.productDefinitionId));
      const categoryId = String(product.categoryId);
      const gstRate = gstOf(product);
      const quantity = raw.quantity;

      for (const offer of raw.offers) {
        const vendor = vendorMap.get(String(offer.vendorId));
        const assignment = vendorAssignment(vendor, product._id);
        if (!assignment) {
          throw new Error(`${product.name} is not an approved product for vendor ${vendor.name}`);
        }

        const defaultWarrantyMonths = defaultWarrantyOf(assignment, product);
        const warrantyMonths = offer.warrantyMonths ?? defaultWarrantyMonths;
        const unitPrice = Number(offer.unitPrice);
        const { baseAmount, gstAmount, lineTotal } =
          StockQuotationService.computeTotals(quantity, unitPrice, gstRate);
        const { previousQuantity, previousPrice, averageRating } =
          history.get(pairKey(vendor._id, product._id)) || EMPTY_HISTORY;

        items.push({
          productDefinitionId: product._id,
          vendorId: vendor._id,
          categoryId: product.categoryId,
          productName: product.name || "",
          vendorName: vendor.name || "",
          categoryName: categoryNames.get(categoryId) || "",
          quantity,
          unitPrice,
          warrantyMonths,
          defaultWarrantyMonths,
          gstRate,
          baseAmount,
          gstAmount,
          lineTotal,
          previousQuantity,
          previousPrice,
          averageRating,
          isApproved: false,
        });
      }
    }

    return { items, categoryIds: [...categoryNames.keys()] };
  }

  /* ---------------------------------------------------------------------- */
  /* Create — there is no update: a quotation is never edited. A mistake is  */
  /* rejected at review and entered again as a new quotation.                */
  /* ---------------------------------------------------------------------- */

  static async createQuotation(body, user, session, dataAccess) {
    const { items, categoryIds } = await StockQuotationService.buildItems(
      body.products,
      dataAccess,
      session
    );
    const quotationNumber =
      await StockQuotationService.generateQuotationNumber(session);

    const [quotation] = await StockQuotationModel.create(
      [
        {
          quotationNumber,
          status: QUOTATION_STATUS.PENDING,
          categoryIds,
          items,
          categoryApprovals: [],
          notes: typeof body.notes === "string" ? body.notes : "",
        },
      ],
      { session }
    );

    log.info(`Quotation created: ${quotationNumber}`);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: quotation._id, action: "CREATE", actor: user, before: null, after: quotation.toObject(),
    });
    return quotation;
  }

  /* ---------------------------------------------------------------------- */
  /* Review — one decision PER CATEGORY, all at once                         */
  /* ---------------------------------------------------------------------- */

  static async reviewQuotation(id, decisions, user, session, dataAccess) {
    const quotation = await StockQuotationModel.findOne({
      _id: id,
      isActive: true,
    }).session(session);
    if (!quotation) throw new Error("Quotation not found");
    assertDataScope(quotation, dataAccess);
    const before = quotation.toObject();

    if (quotation.status !== QUOTATION_STATUS.PENDING) {
      throw new Error("This quotation has already been reviewed");
    }

    const quotationCatIds = new Set(quotation.categoryIds.map((c) => String(c)));

    // Every category on the quotation must be decided exactly once — no
    // pending categories, no extras, no duplicates.
    const decidedIds = decisions.map((d) => String(d.categoryId));
    const uniqueDecided = new Set(decidedIds);
    if (uniqueDecided.size !== decidedIds.length) {
      throw new Error("Each category can be decided only once");
    }
    decidedIds.forEach((cid) => {
      if (!quotationCatIds.has(cid)) {
        throw new Error("A decision references a category not on this quotation");
      }
    });
    if (uniqueDecided.size !== quotationCatIds.size) {
      throw new Error("Every category must be approved or rejected before submitting");
    }

    const now = new Date();
    const actorId = user?.id || user?._id || null;
    const actorName = user?.name || "";

    // reset any stale approval flags, then re-set on the winners
    quotation.items.forEach((it) => {
      it.isApproved = false;
    });

    const categoryApprovals = decisions.map((decision) => {
      const catId = String(decision.categoryId);
      const catItems = quotation.items.filter(
        (it) => String(it.categoryId) === catId
      );
      const categoryName = catItems[0]?.categoryName || "";

      if (decision.status === CATEGORY_APPROVAL_STATUS.REJECTED) {
        return {
          categoryId: decision.categoryId,
          categoryName,
          status: CATEGORY_APPROVAL_STATUS.REJECTED,
          remarks: typeof decision.remarks === "string" ? decision.remarks : "",
          selections: [],
          decidedBy: actorId,
          decidedByName: actorName,
          decidedAt: now,
        };
      }

      // APPROVED — exactly one (product, vendor) selection (enforced here too,
      // so a crafted request can't approve a category with none or many).
      const sel = decision.selection;
      if (!sel || !sel.productDefinitionId || !sel.vendorId) {
        throw new Error(
          `Select one product and vendor to approve ${categoryName || "this category"}`
        );
      }

      const item = catItems.find(
        (it) =>
          String(it.productDefinitionId) === String(sel.productDefinitionId) &&
          String(it.vendorId) === String(sel.vendorId)
      );
      if (!item) {
        throw new Error(
          `The selected product/vendor is not part of ${categoryName || "this category"}`
        );
      }

      item.isApproved = true;

      return {
        categoryId: decision.categoryId,
        categoryName,
        status: CATEGORY_APPROVAL_STATUS.APPROVED,
        remarks: typeof decision.remarks === "string" ? decision.remarks : "",
        selections: [
          {
            itemId: item._id,
            productDefinitionId: item.productDefinitionId,
            productName: item.productName,
            vendorId: item.vendorId,
            vendorName: item.vendorName,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            warrantyMonths: item.warrantyMonths,
            gstRate: item.gstRate,
            baseAmount: item.baseAmount,
            gstAmount: item.gstAmount,
            lineTotal: item.lineTotal,
          },
        ],
        decidedBy: actorId,
        decidedByName: actorName,
        decidedAt: now,
      };
    });

    quotation.categoryApprovals = categoryApprovals;
    quotation.status = StockQuotationService.computeDocStatus(categoryApprovals);
    await quotation.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: quotation._id, action: "REVIEW", actor: user, before, after: quotation.toObject(),
      reason: `-> ${quotation.status}`,
    });

    // Approved/partially-approved → one Tracking Order per winning vendor,
    // so Entity/State assignment (and the rest of the workflow) starts there
    // instead of directly at PO creation.
    if (
      quotation.status === QUOTATION_STATUS.APPROVED ||
      quotation.status === QUOTATION_STATUS.PARTIALLY_APPROVED
    ) {
      const vendorIds = [
        ...new Set(
          categoryApprovals
            .filter((ca) => ca.status === CATEGORY_APPROVAL_STATUS.APPROVED)
            .flatMap((ca) => ca.selections.map((s) => String(s.vendorId)))
        ),
      ];
      await StockTrackingOrderService.createForQuotationVendors(quotation, vendorIds, session);
    }

    log.info(
      `Quotation reviewed: ${quotation.quotationNumber} -> ${quotation.status}`
    );
    return quotation;
  }

  /* ---------------------------------------------------------------------- */
  /* Read                                                                    */
  /* ---------------------------------------------------------------------- */

  static async getAllQuotations(query, dataAccess) {
    const { search, status, categoryId, vendorId, productId, dateFrom, dateTo } = query;
    const { skip, limit, page } = paginate(query);

    const filter = { isActive: true };
    if (status) filter.status = status;
    if (categoryId) filter.categoryIds = categoryId;
    if (vendorId) filter["items.vendorId"] = vendorId;
    if (productId) filter["items.productDefinitionId"] = productId;
    applyDataScope(filter, dataAccess, SCOPE_MODULE_KEY);
    if (search) {
      const regex = new RegExp(escapeRegex(search.trim()), "i");
      filter.$or = [
        { quotationNumber: regex },
        { "items.vendorName": regex },
        { "createdBy.name": regex },
      ];
    }

    // status-wise date range: Pending/All → submission date (createdAt);
    // Approved/Partial/Rejected → decision date (updatedAt, stamped by /review)
    if (dateFrom || dateTo) {
      const decided = status && status !== QUOTATION_STATUS.PENDING;
      const dateField = decided ? "updatedAt" : "createdAt";
      filter[dateField] = {};
      if (dateFrom) filter[dateField].$gte = new Date(dateFrom);
      if (dateTo) filter[dateField].$lte = new Date(dateTo + "T23:59:59.999");
    }

    const [data, total] = await Promise.all([
      StockQuotationModel.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StockQuotationModel.countDocuments(filter),
    ]);

    return paginateReturn(data, total, page, limit);
  }

  static async getStatusSummary(dataAccess) {
    const rows = await StockQuotationModel.aggregate([
      { $match: applyDataScope({ isActive: true }, dataAccess, SCOPE_MODULE_KEY) },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const summary = {
      PENDING: 0,
      APPROVED: 0,
      PARTIALLY_APPROVED: 0,
      REJECTED: 0,
      ALL: 0,
    };
    rows.forEach((r) => {
      if (summary[r._id] !== undefined) summary[r._id] = r.count;
      summary.ALL += r.count;
    });
    return summary;
  }

  static async getQuotationById(id, dataAccess) {
    const quotation = await StockQuotationModel.findOne({ _id: id, isActive: true })
      .populate("items.productDefinitionId", "name trackingMethod unit")
      .populate("items.vendorId", "name")
      .populate("items.categoryId", "name")
      .lean();
    if (!quotation || !isWithinDataScope(quotation, dataAccess, SCOPE_MODULE_KEY)) {
      throw new Error("Quotation not found");
    }
    return quotation;
  }

  /* ---------------------------------------------------------------------- */
  /* Soft delete / restore                                                   */
  /* ---------------------------------------------------------------------- */

  static async softDeleteQuotation(id, user, session, dataAccess) {
    const quotation = await StockQuotationModel.findOne({
      _id: id,
      isActive: true,
    }).session(session);
    if (!quotation) throw new Error("Quotation not found");
    assertDataScope(quotation, dataAccess);
    const before = quotation.toObject();

    // Protect the financial trail — block once anything has been approved.
    if (
      quotation.status === QUOTATION_STATUS.APPROVED ||
      quotation.status === QUOTATION_STATUS.PARTIALLY_APPROVED
    ) {
      throw new Error("Cannot delete — this quotation has approved categories");
    }

    quotation.isActive = false;
    quotation.deletedAt = new Date();
    quotation.deletedBy = actorSnapshot(user);
    await quotation.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: quotation._id, action: "DELETE", actor: user, before, after: quotation.toObject(),
    });
    return quotation;
  }

  static async restoreQuotation(id, actor, session, dataAccess) {
    const quotation = await StockQuotationModel.findOne({
      _id: id,
      isActive: false,
    }).session(session);
    if (!quotation) throw new Error("Inactive quotation not found");
    assertDataScope(quotation, dataAccess);
    const before = quotation.toObject();

    quotation.isActive = true;
    quotation.deletedAt = null;
    quotation.deletedBy = null;
    await quotation.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: quotation._id, action: "RESTORE", actor, before, after: quotation.toObject(),
    });
    return quotation;
  }


  static async getVendorsForCategory(categoryId, dataAccess) {
    const names = await StockQuotationService.resolveCategoryNames([categoryId]);
    const byName = { locale: "en", strength: 2 };
    const products = await StockProductDefinitionModel.find({ categoryId, isActive: true })
      .select("name trackingMethod unit gstRate warrantyMonths")
      .collation(byName)
      .sort({ name: 1 })
      .lean();
    const productIds = products.map((p) => p._id);

    const vendors = productIds.length
      ? await StockVendorModel.find({
          isActive: true,
          "assignedProducts.products.productId": { $in: productIds },
          ...vendorScopeFilter(dataAccess),
        })
          .select("name assignedProducts")
          .collation(byName)
          .sort({ name: 1 })
          .lean()
      : [];

    const history = await StockQuotationService.getOfferHistory(
      vendors.map((v) => v._id),
      productIds
    );

    return {
      categoryId,
      categoryName: names.get(String(categoryId)),
      products: products
        .map((product) => ({
          productDefinitionId: product._id,
          name: product.name,
          trackingMethod: product.trackingMethod,
          unit: product.unit,
          gstRate: gstOf(product),
          vendors: vendors
            .map((vendor) => {
              const assignment = vendorAssignment(vendor, product._id);
              if (!assignment) return null;
              return {
                vendorId: vendor._id,
                vendorName: vendor.name,
                defaultWarrantyMonths: defaultWarrantyOf(assignment, product),
                ...(history.get(pairKey(vendor._id, product._id)) || EMPTY_HISTORY),
              };
            })
            .filter(Boolean),
        }))
        .filter((p) => p.vendors.length > 0),
    };
  }
}