import mongoose from "mongoose";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockFieldDefinitionModel from "../models/stock.field.definition.model.js";
import StockCategoryModel from "../models/stock.category.model.js";
import StockCategoryService from "./stock.category.service.js";
import { applyDataScope, isWithinDataScope } from "../helpers/data.scope.helper.js";
import {
  ITEM_CONDITION,
  TRACKING_METHODS,
  ITEM_STATUS,
  ITEM_APPROVAL_STATUS,
  ITEM_SOURCE_ARRAY,
  ITEM_CONDITION_ARRAY,
} from "../constants/stock.enums.js";
import StockItemMovementService from "./stock.item.movement.service.js";

// The Available Item page's module — its branch scope limits these reads.
const SCOPE_MODULE_KEY = "available-items";

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Free-text search over the fields a person would type in: every unique field
// (serial, MAC…) plus whatever the lists show as columns.
export const searchClause = async (search) => {
  const fields = await StockFieldDefinitionModel.find({
    isActive: true,
    $or: [{ isUnique: true }, { isFilterable: true }, { showList: true }],
  })
    .select("code")
    .lean();
  const codes = new Set(fields.map((f) => f.code));
  codes.add("imei");
  codes.add("serial_no");
  const rx = { $regex: escapeRegex(search), $options: "i" };
  return [...codes].map((code) => ({ [`fieldValues.${code}`]: rx }));
};

// Filters every list shares: where the unit came from and what state it is in.
const applyOriginFilters = (filter, { sourceType, condition }) => {
  if (sourceType && ITEM_SOURCE_ARRAY.includes(sourceType)) filter["source.type"] = sourceType;
  if (condition && ITEM_CONDITION_ARRAY.includes(condition)) filter.condition = condition;
};

// The statuses Item Inventory lists as tabs: what can be handed out, and what
// is with someone (a subscriber or an employee).
const LISTABLE_CARD_STATUSES = [ITEM_STATUS.AVAILABLE, ITEM_STATUS.ASSIGNED];

export default class StockInventoryItemService {
  // ─── Validate fieldValues against productDefinition ──────────────────────────

  static async _validateFieldValues(productDef, fieldValues) {
    // Check required fields
    for (const sf of productDef.selectedFields) {
      if (sf.isRequired) {
        const fieldDef = await StockFieldDefinitionModel.findById(sf.fieldDefId).lean();
        if (!fieldDef) continue;
        const val = fieldValues[fieldDef.code];
        if (val === undefined || val === null || val === "")
          throw new Error(`Required field "${fieldDef.code}" is missing in fieldValues`);
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Item Inventory — one row per PHYSICAL UNIT for individual-tracked      */
  /* products, and one row per (product, branch) for batch-tracked ones,    */
  /* their batches summed. Grouped and paged in the database, so the page   */
  /* stays quick with tens of thousands of units.                           */
  /*                                                                        */
  /* meta.listFields: the "Show in list" fields used by any product in the  */
  /* whole result — the screen gives each its own column, the same on every */
  /* page.                                                                  */
  /* ---------------------------------------------------------------------- */

  static async getInventoryCards(
    { skip, limit, search, categoryId, productDefinitionId, branchId, status, sourceType, condition, vendorId, warranty, from, to },
    dataAccess
  ) {
    const filter = {
      isActive: true,
      status: LISTABLE_CARD_STATUSES.includes(status) ? status : ITEM_STATUS.AVAILABLE,
      approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
    };
    if (branchId) filter.branchId = branchId;
    if (productDefinitionId) filter.productDefinitionId = productDefinitionId;
    if (vendorId && mongoose.isValidObjectId(vendorId)) filter.vendorId = vendorId;
    applyOriginFilters(filter, { sourceType, condition });

    // Warranty: ACTIVE beyond 30 days, ENDING within 30, EXPIRED, NONE recorded.
    const now = new Date();
    const soon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    if (warranty === "ACTIVE") filter["warranty.endDate"] = { $gt: soon };
    else if (warranty === "ENDING") filter["warranty.endDate"] = { $gte: now, $lte: soon };
    else if (warranty === "EXPIRED") filter["warranty.endDate"] = { $lt: now };
    else if (warranty === "NONE") filter["warranty.endDate"] = null;

    if (from || to) {
      filter.receivedAt = {};
      if (from) filter.receivedAt.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23, 59, 59, 999); filter.receivedAt.$lte = d; }
    }

    if (categoryId) {
      const defIds = await StockProductDefinitionModel.find({ categoryId, isActive: true }).distinct("_id");
      filter.productDefinitionId = filter.productDefinitionId ? filter.productDefinitionId : { $in: defIds };
    }

    // Serial, MAC and the other identity fields — or the product's name.
    if (search) {
      const byName = await StockProductDefinitionModel.find({ name: { $regex: escapeRegex(search), $options: "i" } }).distinct("_id");
      filter.$or = [...(await searchClause(search)), ...(byName.length ? [{ productDefinitionId: { $in: byName } }] : [])];
    }

    applyDataScope(filter, dataAccess, SCOPE_MODULE_KEY);
    // aggregate() does not cast like find() does.
    const match = StockInventoryItemModel.find(filter).cast();

    const batchDefIds = await StockProductDefinitionModel.find({ trackingMethod: TRACKING_METHODS.QUANTITY }).distinct("_id");
    const isBatch = { $in: ["$productDefinitionId", batchDefIds] };

    // Header cards: quantity, used and warranty-ending, per product (a unit
    // counts 1, a batch its quantity) — turned into per-unit totals below.
    const qtyExpr = { $ifNull: ["$quantity", 1] };
    const [[grouped], usedDefIds, totalsByDef] = await Promise.all([
      StockInventoryItemModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              $cond: [
                isBatch,
                { $concat: [{ $toString: "$productDefinitionId" }, "::", { $toString: { $ifNull: ["$branchId", "none"] } }] },
                { $toString: "$_id" },
              ],
            },
            doc: { $first: "$$ROOT" },
            batch: { $max: isBatch },
            totalQty: { $sum: { $ifNull: ["$quantity", 0] } },
            batchCount: { $sum: 1 },
            latestReceivedAt: { $max: "$receivedAt" },
            sortAt: { $max: { $ifNull: ["$createdAt", "$receivedAt"] } },
            values: { $push: "$fieldValues" },
          },
        },
        { $sort: { sortAt: -1, _id: 1 } },
        { $facet: { rows: [{ $skip: skip }, { $limit: limit }], total: [{ $count: "n" }] } },
      ]),
      StockInventoryItemModel.distinct("productDefinitionId", match),
      StockInventoryItemModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: "$productDefinitionId",
            quantity: { $sum: qtyExpr },
            used: { $sum: { $cond: [{ $eq: ["$condition", ITEM_CONDITION.USED] }, qtyExpr, 0] } },
            warrantyEnding: {
              $sum: { $cond: [{ $and: [{ $gte: ["$warranty.endDate", now] }, { $lte: ["$warranty.endDate", soon] }] }, qtyExpr, 0] },
            },
          },
        },
      ]),
    ]);
    const rows = grouped?.rows || [];
    const total = grouped?.total?.[0]?.n || 0;

    // The columns: every "Show in list" field any product in the result uses.
    const usedDefs = await StockProductDefinitionModel.find({ _id: { $in: usedDefIds } })
      .select("selectedFields unit")
      .populate({ path: "selectedFields.fieldDefId", select: "code label showList" })
      .lean();

    // Each total per unit of measure — pieces and metres are never added.
    const unitOf = new Map(usedDefs.map((d) => [String(d._id), d.unit || "pieces"]));
    const perUnit = (key) => {
      const by = new Map();
      for (const t of totalsByDef) {
        if (!t[key]) continue;
        const u = unitOf.get(String(t._id)) || "pieces";
        by.set(u, Math.round(((by.get(u) || 0) + t[key]) * 1000) / 1000);
      }
      return [...by.entries()].map(([unit, quantity]) => ({ unit, quantity }));
    };
    const totals = { quantity: perUnit("quantity"), used: perUnit("used"), warrantyEnding: perUnit("warrantyEnding") };
    const listFields = [];
    const seen = new Set();
    for (const d of usedDefs) {
      for (const sf of d.selectedFields || []) {
        const fd = sf.fieldDefId;
        if (fd?.showList && !seen.has(fd.code)) { seen.add(fd.code); listFields.push({ code: fd.code, label: fd.label }); }
      }
    }

    const docs = rows.map((r) => r.doc);
    await StockInventoryItemModel.populate(docs, [
      {
        path: "productDefinitionId",
        select: "name trackingMethod unit selectedFields categoryId",
        options: { lean: true },
        populate: { path: "selectedFields.fieldDefId", select: "code label inputType optionsSource showList isFilterable" },
      },
      { path: "branchId", select: "name code", options: { lean: true } },
      { path: "vendorId", select: "name", options: { lean: true } },
      { path: "invoiceId", select: "invoiceNumber receivedByName", options: { lean: true } },
    ]);

    const categoryIds = [...new Set(docs.map((it) => String(it.productDefinitionId?.categoryId)).filter(Boolean))];
    const categoryDocs = await StockCategoryModel.find({ _id: { $in: categoryIds } }).select("path").lean();
    const pathByCategoryId = new Map(categoryDocs.map((c) => [String(c._id), c.path]));
    const displayPathCache = new Map();
    const categoryPathFor = async (catId) => {
      const key = String(catId || "");
      if (!key) return "";
      if (!displayPathCache.has(key)) {
        const path = pathByCategoryId.get(key);
        displayPathCache.set(key, path ? await StockCategoryService.buildDisplayPath(path) : "");
      }
      return displayPathCache.get(key);
    };

    const data = [];
    for (const r of rows) {
      const item = r.doc;
      const def = item.productDefinitionId;
      if (!def) continue;
      const productDefinitionId = { ...def, categoryPath: await categoryPathFor(def.categoryId) };

      if (!r.batch) {
        data.push({
          cardType: "individual",
          _id: item._id,
          productDefinitionId,
          branchId: item.branchId,
          vendorId: item.vendorId,
          invoiceId: item.invoiceId,
          fieldValues: item.fieldValues,
          status: item.status,
          approvalStatus: item.approvalStatus,
          source: item.source,
          condition: item.condition,
          warranty: item.warranty,
          purchaseCost: item.purchaseCost,
          purchaseDate: item.purchaseDate,
          assignedTo: item.assignedTo,
          receivedAt: item.receivedAt,
          createdAt: item.createdAt,
        });
        continue;
      }

      // A batch row rolls up every batch of this product at this branch, and
      // each batch carries its own tracked values — so a code is shown only
      // when every batch agrees; the rest are reported as varying.
      const valuesByCode = new Map();
      for (const fv of r.values) {
        Object.entries(fv || {}).forEach(([code, val]) => {
          if (val === undefined || val === null || val === "") return;
          if (!valuesByCode.has(code)) valuesByCode.set(code, new Set());
          valuesByCode.get(code).add(String(val));
        });
      }
      const fieldValues = {};
      const variedFields = [];
      for (const [code, values] of valuesByCode) {
        if (values.size === 1) fieldValues[code] = [...values][0];
        else variedFields.push(code);
      }
      data.push({
        cardType: "group",
        _id: r._id,
        productDefinitionId,
        branchId: item.branchId,
        totalQty: r.totalQty,
        batchCount: r.batchCount,
        latestReceivedAt: r.latestReceivedAt,
        receivedAt: r.latestReceivedAt,
        condition: item.condition,
        fieldValues,
        variedFields,
      });
    }

    return { data, total, listFields, totals };
  }

  /* ---------------------------------------------------------------------- */
  /* Receiving history — one row per receipt (invoice or opening stock entry) */
  /* that still has available stock of this product here. Powers the batch  */
  /* breakdown on a Group card.                                             */
  /* ---------------------------------------------------------------------- */

  static async getReceivingHistory(productDefinitionId, { branchId, status } = {}, dataAccess) {
    const match = {
      productDefinitionId: new mongoose.Types.ObjectId(productDefinitionId),
      isActive: true,
      // Same two statuses Item Inventory lists — a Reserved card breaks down
      // into its reserved batches, not the available ones.
      status: LISTABLE_CARD_STATUSES.includes(status) ? status : ITEM_STATUS.AVAILABLE,
      approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
      // Individual units (quantity null) count as one each; a batch emptied by
      // a transfer is left with 0 and has nothing to show.
      $or: [{ quantity: null }, { quantity: { $gt: 0 } }],
    };
    if (branchId) match.branchId = new mongoose.Types.ObjectId(branchId);
    // Aggregation $match does not auto-cast, so the helper is handed an
    // already-cast filter — see toObjectIds() inside it.
    applyDataScope(match, dataAccess, SCOPE_MODULE_KEY);

    // Grouped by the receipt, not by batch document: a transfer splits one
    // receipt's stock into several documents, and paid/FOC halves of one
    // invoice line are two — all of them are still one lot from one receipt.
    const grouped = await StockInventoryItemModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$source.refId",
          sourceType: { $first: "$source.type" },
          refNumber: { $first: "$source.refNumber" },
          receivedAt: { $min: "$receivedAt" },
          qty: { $sum: { $ifNull: ["$quantity", 1] } },
          // One receipt line shares the lot's values, so $first is the lot's
          // values rather than an arbitrary pick.
          fieldValues: { $first: "$fieldValues" },
          condition: { $first: "$condition" },
          warrantyEndDate: { $first: "$warranty.endDate" },
        },
      },
      { $sort: { receivedAt: -1 } },
    ]);

    return grouped.map((g) => ({
      refId: g._id,
      sourceType: g.sourceType || null,
      refNumber: g.refNumber || "",
      receivedAt: g.receivedAt || null,
      quantity: g.qty,
      fieldValues: g.fieldValues || {},
      condition: g.condition || null,
      warrantyEndDate: g.warrantyEndDate || null,
    }));
  }

  /* ---------------------------------------------------------------------- */
  /* One unit's story: what it is, where it came from, and every movement   */
  /* since. The pre-system note (old stock) comes back separately so the    */
  /* screen can show it above the real history.                             */
  /* ---------------------------------------------------------------------- */

  // moduleKey: whose branch scope applies — Available Item, or Item Summary.
  static async getItemTimeline(id, dataAccess, moduleKey = SCOPE_MODULE_KEY) {
    const item = await StockInventoryItemModel.findOne({ _id: id })
      .populate({ path: "productDefinitionId", select: "name trackingMethod unit" })
      .populate({ path: "branchId", select: "name" })
      .populate({ path: "vendorId", select: "name" })
      .lean();
    if (!item || !isWithinDataScope(item, dataAccess, moduleKey)) throw new Error("Inventory item not found");

    const movements = await StockItemMovementService.timelineOf(item._id);
    return {
      item: {
        _id: item._id,
        product: item.productDefinitionId,
        branch: item.branchId,
        vendor: item.vendorId,
        status: item.status,
        condition: item.condition,
        source: item.source,
        warranty: item.warranty,
        purchaseCost: item.purchaseCost,
        purchaseDate: item.purchaseDate,
        assignedTo: item.assignedTo,
        fieldValues: item.fieldValues,
        quantity: item.quantity,
        receivedAt: item.receivedAt,
      },
      movements,
    };
  }
}
