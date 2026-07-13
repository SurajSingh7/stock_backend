import mongoose from "mongoose";

import StockQuotationModel from "../models/stock.quotation.model.js";
import StockVendorModel from "../models/stock.vendor.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
// Side-effect imports so populate never hits an unregistered model (Section 20 #7)
import "../models/stock.category.model.js";
import StockVendorPurchaseHistoryModel from "../models/stock.vendor.purchase.history.model.js";
import StockVendorReviewModel from "../models/stock.vendor.review.model.js";

import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import {
  QUOTATION_STATUS,
  CATEGORY_APPROVAL_STATUS,
} from "../constants/stock.enums.js";

const log = getLogger(import.meta.url);

const escapeRegex = (str = "") =>
  String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export default class StockQuotationService {
  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                 */
  /* ---------------------------------------------------------------------- */

  static async generateQuotationNumber(session) {
    const year = new Date().getFullYear();
    const prefix = `QTN-${year}-`;
    const count = await StockQuotationModel.countDocuments({
      quotationNumber: new RegExp(`^${prefix}`),
    }).session(session);
    const next = String(count + 1).padStart(4, "0");
    return `${prefix}${next}`;
  }

  static async getPreviousPurchase(vendorId, productDefinitionId, session) {
    const last = await StockVendorPurchaseHistoryModel.findOne({
      vendorId,
      productDefinitionId,
      isActive: true,
    })
      .sort({ purchaseDate: -1 })
      .session(session)
      .lean();
    return {
      previousQuantity: last ? last.receivedQuantity : null,
      previousPrice: last ? last.purchasePrice : null,
    };
  }

  static async getAverageRating(vendorId, productDefinitionId, session) {
    const result = await StockVendorReviewModel.aggregate([
      {
        $match: {
          vendorId: new mongoose.Types.ObjectId(vendorId),
          productDefinitionId: new mongoose.Types.ObjectId(productDefinitionId),
          isActive: true,
        },
      },
      { $group: { _id: null, avg: { $avg: "$rating" } } },
    ]).session(session);
    return result.length ? round2(result[0].avg) : null;
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

  /*
    Shared item builder (create + update). Rebuilds the priced offer pool:
      - re-fetches vendors + products (never trusts client names/gst)
      - enforces the vendor↔product assignment rule (Postman cannot bypass)
      - clamps quantity (>=1) and unitPrice (>0)
      - snapshots previousQty/Price + averageRating
      - computes totals server-side

    NOTE: All queries below that pass `.session(session)` are awaited
    sequentially, not via Promise.all. The MongoDB driver does not support
    running multiple concurrent operations on the same ClientSession inside
    a transaction — doing so intermittently throws:
      "Given transaction number X does not match any in-progress transactions"
    Promise.all is safe again once a query does NOT share this session.

    Returns { items, categoryIds }.
  */
  static async buildItems(rawItems, session) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new Error("At least one product must be selected");
    }

    const vendorIds = [...new Set(rawItems.map((i) => String(i.vendorId)))];
    const productIds = [
      ...new Set(rawItems.map((i) => String(i.productDefinitionId))),
    ];

    const vendors = await StockVendorModel.find({
      _id: { $in: vendorIds },
      isActive: true,
    })
      .session(session)
      .lean();
    const products = await StockProductDefinitionModel.find({
      _id: { $in: productIds },
      isActive: true,
    })
      .session(session)
      .lean();

    const vendorMap = new Map(vendors.map((v) => [String(v._id), v]));
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    const categoryIdSet = new Set();
    const items = [];
    const seenPairs = new Set();

    for (const raw of rawItems) {
      const vendor = vendorMap.get(String(raw.vendorId));
      const product = productMap.get(String(raw.productDefinitionId));

      if (!vendor) throw new Error(`Vendor not found or inactive: ${raw.vendorId}`);
      if (!product)
        throw new Error(`Product not found or inactive: ${raw.productDefinitionId}`);

      const pairKey = `${raw.vendorId}::${raw.productDefinitionId}`;
      if (seenPairs.has(pairKey)) {
        throw new Error(`Duplicate item: ${product.name} for vendor ${vendor.name}`);
      }
      seenPairs.add(pairKey);

      const isAssigned = (vendor.assignedProducts || []).some((ap) =>
        (ap.productIds || []).some(
          (pid) => String(pid) === String(raw.productDefinitionId)
        )
      );
      if (!isAssigned) {
        throw new Error(
          `${product.name} is not an approved product for vendor ${vendor.name}`
        );
      }

      const quantity = Math.max(1, Math.floor(Number(raw.quantity) || 0));
      const unitPrice = Math.max(0, Number(raw.unitPrice) || 0);
      if (unitPrice <= 0) throw new Error(`Enter a valid price for ${product.name}`);

      const gstRate =
        typeof product.gstRate === "number"
          ? product.gstRate
          : Number(product.gstRate) || 0;

      const { baseAmount, gstAmount, lineTotal } =
        StockQuotationService.computeTotals(quantity, unitPrice, gstRate);

      const { previousQuantity, previousPrice } =
        await StockQuotationService.getPreviousPurchase(
          raw.vendorId,
          raw.productDefinitionId,
          session
        );
      const averageRating = await StockQuotationService.getAverageRating(
        raw.vendorId,
        raw.productDefinitionId,
        session
      );

      categoryIdSet.add(String(raw.categoryId));

      items.push({
        productDefinitionId: raw.productDefinitionId,
        vendorId: raw.vendorId,
        categoryId: raw.categoryId,
        productName: product.name || "",
        vendorName: vendor.name || "",
        categoryName: raw.categoryName || "",
        quantity,
        unitPrice,
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

    return { items, categoryIds: [...categoryIdSet] };
  }

  /* ---------------------------------------------------------------------- */
  /* Create / Update (both PENDING-only)                                     */
  /* ---------------------------------------------------------------------- */

  static async createQuotation(body, user, session) {
    const { items, categoryIds } = await StockQuotationService.buildItems(
      body.items,
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
          createdBy: user?.id || user?._id || null,
          createdByName: user?.name || "",
        },
      ],
      { session }
    );

    log.info(`Quotation created: ${quotationNumber}`);
    return quotation;
  }

  static async updateQuotation(id, body, user, session) {
    const quotation = await StockQuotationModel.findOne({
      _id: id,
      isActive: true,
    }).session(session);
    if (!quotation) throw new Error("Quotation not found");

    if (quotation.status !== QUOTATION_STATUS.PENDING) {
      throw new Error("Only pending quotations can be edited");
    }
    if (Object.prototype.hasOwnProperty.call(body, "quotationNumber")) {
      throw new Error("quotationNumber cannot be changed");
    }
    if (Object.prototype.hasOwnProperty.call(body, "status")) {
      throw new Error("status cannot be changed here — use the review endpoint");
    }

    if (Array.isArray(body.items) && body.items.length > 0) {
      const { items, categoryIds } = await StockQuotationService.buildItems(
        body.items,
        session
      );
      quotation.items = items;
      quotation.categoryIds = categoryIds;
    }
    if (typeof body.notes === "string") quotation.notes = body.notes;

    quotation.updatedBy = user?.id || user?._id || null;
    quotation.updatedByName = user?.name || "";
    await quotation.save({ session });
    return quotation;
  }

  /* ---------------------------------------------------------------------- */
  /* Review — one decision PER CATEGORY, all at once                         */
  /* ---------------------------------------------------------------------- */

  static async reviewQuotation(id, decisions, user, session) {
    const quotation = await StockQuotationModel.findOne({
      _id: id,
      isActive: true,
    }).session(session);
    if (!quotation) throw new Error("Quotation not found");

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
    quotation.updatedBy = actorId;
    quotation.updatedByName = actorName;
    await quotation.save({ session });

    log.info(
      `Quotation reviewed: ${quotation.quotationNumber} -> ${quotation.status}`
    );
    return quotation;
  }

  /* ---------------------------------------------------------------------- */
  /* Read                                                                    */
  /* ---------------------------------------------------------------------- */

  static async getAllQuotations(query) {
    const { search, status, categoryId, vendorId, productId, dateFrom, dateTo } = query;
    const { skip, limit, page } = paginate(query);

    const filter = { isActive: true };
    if (status) filter.status = status;
    if (categoryId) filter.categoryIds = categoryId;
    if (vendorId) filter["items.vendorId"] = vendorId;
    if (productId) filter["items.productDefinitionId"] = productId;
    if (search) {
      const regex = new RegExp(escapeRegex(search.trim()), "i");
      filter.$or = [
        { quotationNumber: regex },
        { "items.vendorName": regex },
        { createdByName: regex },
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
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StockQuotationModel.countDocuments(filter),
    ]);

    return paginateReturn(data, total, page, limit);
  }

  static async getStatusSummary() {
    const rows = await StockQuotationModel.aggregate([
      { $match: { isActive: true } },
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

  static async getQuotationById(id) {
    const quotation = await StockQuotationModel.findOne({ _id: id, isActive: true })
      .populate("items.productDefinitionId", "name trackingMethod")
      .populate("items.vendorId", "name")
      .populate("items.categoryId", "name")
      .lean();
    if (!quotation) throw new Error("Quotation not found");
    return quotation;
  }

  /* ---------------------------------------------------------------------- */
  /* Soft delete / restore                                                   */
  /* ---------------------------------------------------------------------- */

  static async softDeleteQuotation(id, user, session) {
    const quotation = await StockQuotationModel.findOne({
      _id: id,
      isActive: true,
    }).session(session);
    if (!quotation) throw new Error("Quotation not found");

    // Protect the financial trail — block once anything has been approved.
    if (
      quotation.status === QUOTATION_STATUS.APPROVED ||
      quotation.status === QUOTATION_STATUS.PARTIALLY_APPROVED
    ) {
      throw new Error("Cannot delete — this quotation has approved categories");
    }

    quotation.isActive = false;
    quotation.deletedAt = new Date();
    quotation.deletedBy = user?.id || user?._id || null;
    await quotation.save({ session });
    return quotation;
  }

  static async restoreQuotation(id, session) {
    const quotation = await StockQuotationModel.findOne({
      _id: id,
      isActive: false,
    }).session(session);
    if (!quotation) throw new Error("Inactive quotation not found");

    quotation.isActive = true;
    quotation.deletedAt = null;
    quotation.deletedBy = null;
    await quotation.save({ session });
    return quotation;
  }

  /* ---------------------------------------------------------------------- */
  /* Form-builder read: vendors + products for a leaf category               */
  /* ---------------------------------------------------------------------- */

  static async getVendorsForCategory(categoryId) {
    const vendors = await StockVendorModel.find({
      isActive: true,
      "assignedProducts.categoryId": categoryId,
    })
      .select("name assignedProducts")
      .lean();

    const allProductIds = new Set();
    const vendorProductMap = vendors.map((v) => {
      const entry = (v.assignedProducts || []).find(
        (ap) => String(ap.categoryId) === String(categoryId)
      );
      const productIds = (entry?.productIds || []).map(String);
      productIds.forEach((pid) => allProductIds.add(pid));
      return { vendorId: v._id, vendorName: v.name, productIds };
    });

    const products = await StockProductDefinitionModel.find({
      _id: { $in: [...allProductIds] },
      isActive: true,
    })
      .select("name gstRate trackingMethod")
      .lean();
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    return vendorProductMap
      .map((vp) => ({
        vendorId: vp.vendorId,
        vendorName: vp.vendorName,
        products: vp.productIds
          .map((pid) => productMap.get(pid))
          .filter(Boolean)
          .map((p) => ({
            productDefinitionId: p._id,
            name: p.name,
            gstRate:
              typeof p.gstRate === "number" ? p.gstRate : Number(p.gstRate) || 0,
          })),
      }))
      .filter((vp) => vp.products.length > 0);
  }
}