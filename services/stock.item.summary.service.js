import mongoose from "mongoose";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockCategoryModel from "../models/stock.category.model.js";
import StockInvoiceAdjustmentModel from "../models/stock.invoice.adjustment.model.js";
import StockCategoryService from "./stock.category.service.js";
import { searchClause } from "./stock.inventory.item.service.js";
import { applyDataScope } from "../helpers/data.scope.helper.js";
import {
  ITEM_STATUS,
  ITEM_APPROVAL_STATUS,
  ITEM_SOURCE_ARRAY,
  ASSIGNEE_KIND,
  TRACKING_METHODS,
  ADJUSTMENT_TYPE,
} from "../constants/stock.enums.js";

/*
  Item Summary — every unit we hold, wherever it is: in the store, with a
  subscriber or an employee, out for repair, on the way to another branch,
  debited back to the vendor, or scrapped. Read-only; the companion of
  Product Summary, which gives the same story as numbers per product.

  Each unit falls in one bucket (the page's status chips):
    AVAILABLE    status AVAILABLE
    SUBSCRIBERS  ASSIGNED to a subscriber (no kind on old rows = subscriber)
    EMPLOYEES    ASSIGNED to an employee
    REPAIR       FAULTY, IN_REPAIR or AT_VENDOR
    ON_THE_WAY   IN_TRANSIT
    DEBITED      DEBITED (money taken back on a debit note)
    SCRAPPED     SCRAPPED
  VENDOR_REPLACED units are left out — the vendor kept them, they are no
  longer ours; the replacement is its own unit.

  A row is one serial-tracked unit, or for batch stock one product + branch +
  bucket + holder (40 m in the store, 15 m with Ramesh…).
*/

export const SCOPE_MODULE_KEY = "item-summary";

export const SUMMARY_BUCKET = {
  AVAILABLE: "AVAILABLE",
  SUBSCRIBERS: "SUBSCRIBERS",
  EMPLOYEES: "EMPLOYEES",
  REPAIR: "REPAIR",
  ON_THE_WAY: "ON_THE_WAY",
  DEBITED: "DEBITED",
  SCRAPPED: "SCRAPPED",
};
const BUCKETS = Object.values(SUMMARY_BUCKET);

const LISTED_STATUSES = [
  ITEM_STATUS.AVAILABLE,
  ITEM_STATUS.ASSIGNED,
  ITEM_STATUS.FAULTY,
  ITEM_STATUS.IN_REPAIR,
  ITEM_STATUS.AT_VENDOR,
  ITEM_STATUS.IN_TRANSIT,
  ITEM_STATUS.DEBITED,
  ITEM_STATUS.SCRAPPED,
];

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

const bucketExpr = {
  $switch: {
    branches: [
      { case: { $eq: ["$status", ITEM_STATUS.AVAILABLE] }, then: SUMMARY_BUCKET.AVAILABLE },
      {
        case: { $and: [{ $eq: ["$status", ITEM_STATUS.ASSIGNED] }, { $eq: ["$assignedTo.kind", ASSIGNEE_KIND.EMPLOYEE] }] },
        then: SUMMARY_BUCKET.EMPLOYEES,
      },
      { case: { $eq: ["$status", ITEM_STATUS.ASSIGNED] }, then: SUMMARY_BUCKET.SUBSCRIBERS },
      { case: { $in: ["$status", [ITEM_STATUS.FAULTY, ITEM_STATUS.IN_REPAIR, ITEM_STATUS.AT_VENDOR]] }, then: SUMMARY_BUCKET.REPAIR },
      { case: { $eq: ["$status", ITEM_STATUS.IN_TRANSIT] }, then: SUMMARY_BUCKET.ON_THE_WAY },
      { case: { $eq: ["$status", ITEM_STATUS.DEBITED] }, then: SUMMARY_BUCKET.DEBITED },
    ],
    default: SUMMARY_BUCKET.SCRAPPED,
  },
};

// Since when the unit is where it is.
const sinceExpr = {
  $switch: {
    branches: [
      { case: { $eq: ["$status", ITEM_STATUS.ASSIGNED] }, then: { $ifNull: ["$assignedTo.assignedAt", "$updatedAt"] } },
      { case: { $eq: ["$status", ITEM_STATUS.FAULTY] }, then: { $ifNull: ["$fault.reportedAt", "$updatedAt"] } },
      { case: { $in: ["$status", [ITEM_STATUS.IN_REPAIR, ITEM_STATUS.AT_VENDOR]] }, then: { $ifNull: ["$repair.sentAt", "$updatedAt"] } },
      { case: { $eq: ["$status", ITEM_STATUS.IN_TRANSIT] }, then: { $ifNull: ["$transit.sentAt", "$updatedAt"] } },
      { case: { $eq: ["$status", ITEM_STATUS.AVAILABLE] }, then: "$receivedAt" },
    ],
    default: "$updatedAt",
  },
};

const str = (path) => ({ $toString: { $ifNull: [path, ""] } });

export default class StockItemSummaryService {
  static async list(query = {}, dataAccess) {
    const { search, categoryId, productDefinitionId, branchId, vendorId, sourceType, bucket, from, to } = query;
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 10));

    const filter = {
      isActive: true,
      approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
      status: { $in: LISTED_STATUSES },
    };
    if (branchId && mongoose.isValidObjectId(branchId)) filter.branchId = branchId;
    if (productDefinitionId && mongoose.isValidObjectId(productDefinitionId)) filter.productDefinitionId = productDefinitionId;
    if (vendorId && mongoose.isValidObjectId(vendorId)) filter.vendorId = vendorId;
    if (sourceType && ITEM_SOURCE_ARRAY.includes(sourceType)) filter["source.type"] = sourceType;
    if (from || to) {
      filter.receivedAt = {};
      if (from) filter.receivedAt.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23, 59, 59, 999); filter.receivedAt.$lte = d; }
    }
    if (categoryId && mongoose.isValidObjectId(categoryId)) {
      const defIds = await StockProductDefinitionModel.find({ categoryId, isActive: true }).distinct("_id");
      if (!filter.productDefinitionId) filter.productDefinitionId = { $in: defIds };
    }
    // Serial, MAC… the product's name, or who has it.
    if (search && String(search).trim()) {
      const q = String(search).trim();
      const rx = { $regex: escapeRegex(q), $options: "i" };
      const byName = await StockProductDefinitionModel.find({ name: rx }).distinct("_id");
      filter.$or = [
        ...(await searchClause(q)),
        ...(byName.length ? [{ productDefinitionId: { $in: byName } }] : []),
        { "assignedTo.orderId": rx },
        { "assignedTo.username": rx },
        { "assignedTo.phone": rx },
        { "assignedTo.employeeName": rx },
        { "assignedTo.employeeCode": rx },
        { "assignedTo.requestNumber": rx },
        { "transit.transferNumber": rx },
      ];
    }
    applyDataScope(filter, dataAccess, SCOPE_MODULE_KEY);
    const match = StockInventoryItemModel.find(filter).cast();

    const batchDefIds = await StockProductDefinitionModel.find({ trackingMethod: TRACKING_METHODS.QUANTITY }).distinct("_id");
    const isBatch = { $in: ["$productDefinitionId", batchDefIds] };
    const wantBucket = BUCKETS.includes(bucket) ? bucket : null;

    const [[res], usedDefIds] = await Promise.all([
      StockInventoryItemModel.aggregate([
        { $match: match },
        { $addFields: { _bucket: bucketExpr, _since: sinceExpr, _qty: { $ifNull: ["$quantity", 1] } } },
        // A batch drawn down to nothing (a debit note took it all) is not stock.
        { $match: { _qty: { $gt: 0 } } },
        {
          $group: {
            _id: {
              $cond: [
                isBatch,
                {
                  $concat: [
                    str("$productDefinitionId"), "::", str("$branchId"), "::", "$_bucket", "::", { $ifNull: ["$status", ""] }, "::",
                    { $ifNull: ["$assignedTo.employeeCode", ""] }, "::", { $ifNull: ["$assignedTo.orderId", ""] }, "::",
                    { $ifNull: ["$assignedTo.requestNumber", ""] }, "::", str("$transit.transferId"),
                  ],
                },
                { $toString: "$_id" },
              ],
            },
            doc: { $first: "$$ROOT" },
            batch: { $max: isBatch },
            bucket: { $first: "$_bucket" },
            quantity: { $sum: "$_qty" },
            pieces: { $sum: 1 },
            since: { $max: "$_since" },
            ids: { $push: "$_id" },
            productDefinitionId: { $first: "$productDefinitionId" },
          },
        },
        {
          $facet: {
            counts: [{ $group: { _id: "$bucket", n: { $sum: 1 } } }],
            totals: [{ $group: { _id: { product: "$productDefinitionId", bucket: "$bucket" }, quantity: { $sum: "$quantity" } } }],
            rows: [
              ...(wantBucket ? [{ $match: { bucket: wantBucket } }] : []),
              { $sort: { since: -1, _id: 1 } },
              { $skip: (page - 1) * limit },
              { $limit: limit },
            ],
            total: [...(wantBucket ? [{ $match: { bucket: wantBucket } }] : []), { $count: "n" }],
          },
        },
      ]),
      StockInventoryItemModel.distinct("productDefinitionId", match),
    ]);

    // Columns: every "Show in list" field any product in the result uses.
    const usedDefs = await StockProductDefinitionModel.find({ _id: { $in: usedDefIds } })
      .select("selectedFields unit")
      .populate({ path: "selectedFields.fieldDefId", select: "code label showList" })
      .lean();
    const listFields = [];
    const seen = new Set();
    for (const d of usedDefs) {
      for (const sf of d.selectedFields || []) {
        const fd = sf.fieldDefId;
        if (fd?.showList && !seen.has(fd.code)) { seen.add(fd.code); listFields.push({ code: fd.code, label: fd.label }); }
      }
    }

    // Chip counts (rows) and header totals (quantity per unit of measure).
    const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
    for (const c of res?.counts || []) counts[c._id] = c.n;
    counts.ALL = BUCKETS.reduce((s, b) => s + counts[b], 0);

    const unitOf = new Map(usedDefs.map((d) => [String(d._id), d.unit || "pieces"]));
    const sums = {}; // { bucket: Map(unit → qty) }
    for (const t of res?.totals || []) {
      const u = unitOf.get(String(t._id.product)) || "pieces";
      for (const key of [t._id.bucket, "ALL"]) {
        sums[key] = sums[key] || new Map();
        sums[key].set(u, round3((sums[key].get(u) || 0) + t.quantity));
      }
    }
    const asList = (keys) => {
      const m = new Map();
      for (const k of keys) for (const [u, q] of sums[k] || []) m.set(u, round3((m.get(u) || 0) + q));
      return [...m.entries()].map(([unit, quantity]) => ({ unit, quantity }));
    };
    const totals = {
      total: asList(["ALL"]),
      available: asList([SUMMARY_BUCKET.AVAILABLE]),
      inUse: asList([SUMMARY_BUCKET.SUBSCRIBERS, SUMMARY_BUCKET.EMPLOYEES]),
      repair: asList([SUMMARY_BUCKET.REPAIR]),
      debited: asList([SUMMARY_BUCKET.DEBITED]),
    };

    const rows = res?.rows || [];
    const docs = rows.map((r) => r.doc);
    await StockInventoryItemModel.populate(docs, [
      {
        path: "productDefinitionId",
        select: "name trackingMethod unit selectedFields categoryId",
        options: { lean: true },
        populate: { path: "selectedFields.fieldDefId", select: "code label inputType showList" },
      },
      { path: "branchId", select: "name code", options: { lean: true } },
      { path: "vendorId", select: "name", options: { lean: true } },
      { path: "invoiceId", select: "invoiceNumber receivedByName", options: { lean: true } },
      { path: "transit.toBranchId", model: "branches", select: "name", options: { lean: true } },
    ]);

    // Debit note numbers for the debited rows on this page.
    const debitedIds = rows.filter((r) => r.bucket === SUMMARY_BUCKET.DEBITED).flatMap((r) => r.ids);
    const dnBy = new Map();
    if (debitedIds.length) {
      const notes = await StockInvoiceAdjustmentModel.find({
        type: ADJUSTMENT_TYPE.DEBIT_NOTE,
        isActive: true,
        $or: [{ "lines.inventoryItemIds": { $in: debitedIds } }, { "lines.batchDraws.inventoryItemId": { $in: debitedIds } }],
      })
        .select("dnNumber lines.inventoryItemIds lines.batchDraws.inventoryItemId")
        .lean();
      for (const n of notes) {
        for (const l of n.lines || []) {
          for (const id of l.inventoryItemIds || []) dnBy.set(String(id), n.dnNumber);
          for (const d of l.batchDraws || []) dnBy.set(String(d.inventoryItemId), n.dnNumber);
        }
      }
    }

    // Category breadcrumbs, built once per category.
    const catIds = [...new Set(docs.map((d) => String(d.productDefinitionId?.categoryId || "")).filter(Boolean))];
    const cats = await StockCategoryModel.find({ _id: { $in: catIds } }).select("path name").lean();
    const pathBy = new Map();
    for (const c of cats) pathBy.set(String(c._id), (await StockCategoryService.buildDisplayPath(c.path || "")) || c.name);

    const data = rows
      .filter((r) => r.doc.productDefinitionId)
      .map((r) => {
        const it = r.doc;
        const def = it.productDefinitionId;
        const dnNumbers = [...new Set(r.ids.map((id) => dnBy.get(String(id))).filter(Boolean))];
        return {
          _id: r._id,
          itemId: r.batch ? null : it._id,
          cardType: r.batch ? "group" : "individual",
          productDefinitionId: { ...def, categoryPath: pathBy.get(String(def.categoryId)) || "" },
          branchId: it.branchId,
          vendorId: it.vendorId,
          invoiceId: it.invoiceId,
          source: it.source,
          bucket: r.bucket,
          status: it.status,
          quantity: round3(r.quantity),
          batchCount: r.pieces,
          since: r.since,
          condition: it.condition,
          warranty: it.warranty,
          purchaseCost: it.purchaseCost,
          purchaseDate: it.purchaseDate,
          receivedAt: it.receivedAt,
          fieldValues: r.batch ? {} : it.fieldValues,
          assignedTo: it.assignedTo,
          fault: it.fault,
          repair: it.repair,
          transit: it.transit,
          scrapNote: it.scrapNote,
          dnNumbers,
        };
      });

    return { data, total: res?.total?.[0]?.n || 0, page, limit, counts, totals, listFields };
  }
}
