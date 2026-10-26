import mongoose from "mongoose";
import { actorSnapshot } from "../models/plugins/actor.stamp.plugin.js";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockFieldDefinitionModel from "../models/stock.field.definition.model.js";
import StockCategoryModel from "../models/stock.category.model.js";
import StockCategoryService from "./stock.category.service.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import { applyDataScope, isWithinDataScope, resolveDimensionAllowList } from "../helpers/data.scope.helper.js";

const SCOPE_MODULE_KEY = "inventory-items";
import { paginate } from "../helpers/pagination.helper.js";
import {
  TRACKING_METHODS,
  ITEM_STATUS_ARRAY,
  ITEM_STATUS,
  ITEM_APPROVAL_STATUS,
  ITEM_SOURCE_ARRAY,
  ITEM_CONDITION_ARRAY,
} from "../constants/stock.enums.js";
import StockItemIdentityService from "./stock.item.identity.service.js";
import { AppError } from "../helpers/response.helper.js";
import StockItemMovementService from "./stock.item.movement.service.js";

const ENTITY_TYPE = "inventory-items";

// Guard for every by-id read AND every mutation. Throws the resource's normal
// "not found" rather than a 403 — a 403 would confirm that an item outside the
// caller's branch exists, which is exactly what the scope is meant to hide.
const assertDataScope = (item, dataAccess) => {
  if (!isWithinDataScope(item, dataAccess, SCOPE_MODULE_KEY)) {
    throw new Error("Inventory item not found");
  }
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Free-text search over the fields a person would type in: every unique field
// (serial, MAC…) plus whatever the lists show as columns.
const searchClause = async (search) => {
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

// Statuses only their own flow may set or clear — each carries data that flow
// keeps in step (assignedTo, a debit note's draws, a fault or repair).
// Changing one by hand would leave that data saying something untrue.
const FLOW_OWNED_STATUSES = [
  ITEM_STATUS.ASSIGNED,
  ITEM_STATUS.DEBITED,
  // Repair & Warranty — see StockRepairService.
  ITEM_STATUS.FAULTY,
  ITEM_STATUS.IN_REPAIR,
  ITEM_STATUS.AT_VENDOR,
  ITEM_STATUS.VENDOR_REPLACED,
  ITEM_STATUS.SCRAPPED,
];

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

  // Recomputes a unit's serial/MAC keys from its current field values and
  // checks them against every other live unit. Caller saves.
  static async _rekey(item, session) {
    if (item.quantity !== null && item.quantity !== undefined) return;
    const def = await StockProductDefinitionModel.findById(item.productDefinitionId).session(session).lean();
    const uniqueFields = await StockItemIdentityService.uniqueFieldsFor(def, session);
    StockItemIdentityService.assertHasIdentifier(item.fieldValues, uniqueFields);
    const keys = StockItemIdentityService.identifiersOf(item.fieldValues, uniqueFields);
    await StockItemIdentityService.assertIdentifiersFree(keys, {
      session,
      excludeItemIds: [item._id],
      labelByCode: new Map(uniqueFields.map((f) => [f.code, f.label])),
    });
    item.identifiers = keys.length ? keys : undefined;
  }

  // ─── List items ───────────────────────────────────────────────────────────────

  static async getAllInventoryItems({
    skip,
    limit,
    productDefinitionId,
    categoryId,
    branchId,
    status,
    approvalStatus,
    search,
    showInactive,
    sourceType,
    condition,
  }, dataAccess) {
    try {
      const filter = showInactive ? {} : { isActive: true };
      if (productDefinitionId) filter.productDefinitionId = productDefinitionId;
      if (branchId) filter.branchId = branchId;
      if (status) filter.status = status;
      if (approvalStatus) filter.approvalStatus = approvalStatus;
      applyOriginFilters(filter, { sourceType, condition });
      applyDataScope(filter, dataAccess, SCOPE_MODULE_KEY);

      if (categoryId) {
        const defIds = await StockProductDefinitionModel.find({ categoryId, isActive: true }).distinct("_id");
        filter.productDefinitionId = filter.productDefinitionId
          ? filter.productDefinitionId
          : { $in: defIds };
      }

      if (search) filter.$or = await searchClause(search);

      const [data, total] = await Promise.all([
        StockInventoryItemModel.find(filter)
          .populate({
            path: "productDefinitionId",
            select: "name trackingMethod unit selectedFields categoryId",
            populate: {
              path: "selectedFields.fieldDefId",
              select: "code label inputType optionsSource showList isFilterable",
            },
          })
          .populate({ path: "branchId", select: "name code" })
          .populate({ path: "vendorId", select: "name" })
          .populate({ path: "invoiceId", select: "invoiceNumber receivedByName" })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        StockInventoryItemModel.countDocuments(filter),
      ]);

      // Full category breadcrumb (e.g. "Electronics / Mobile / Poco") — the
      // populated productDefinitionId only carries categoryId, so resolve it
      // here the same way Product Inventory does, once per distinct category.
      const categoryIds = [...new Set(data.map((d) => String(d.productDefinitionId?.categoryId)).filter(Boolean))];
      const categoryDocs = await StockCategoryModel.find({ _id: { $in: categoryIds } }).select("path").lean();
      const pathByCategoryId = new Map(categoryDocs.map((c) => [String(c._id), c.path]));
      const displayPathCache = new Map();
      for (const item of data) {
        const catId = String(item.productDefinitionId?.categoryId || "");
        if (!catId) continue;
        if (!displayPathCache.has(catId)) {
          const path = pathByCategoryId.get(catId);
          displayPathCache.set(catId, path ? await StockCategoryService.buildDisplayPath(path) : "");
        }
        if (item.productDefinitionId) item.productDefinitionId.categoryPath = displayPathCache.get(catId);
      }

      return { data, total };
    } catch (error) {
      throw error;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Item Inventory (card view) — one card per PHYSICAL UNIT for individual- */
  /* tracked products, but exactly one card per (product, branch) for     */
  /* group-tracked products — batches are summed, never shown as separate    */
  /* rows. Fetches broadly (this system's inventory volumes are small) and   */
  /* merges + paginates in memory so a group card's total is never split     */
  /* across pages.                                                           */
  /* ---------------------------------------------------------------------- */

  static async getInventoryCards(
    { skip, limit, search, categoryId, productDefinitionId, branchId, status, sourceType, condition },
    dataAccess
  ) {
    const filter = {
      isActive: true,
      status: LISTABLE_CARD_STATUSES.includes(status) ? status : ITEM_STATUS.AVAILABLE,
      approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
    };
    if (branchId) filter.branchId = branchId;
    if (productDefinitionId) filter.productDefinitionId = productDefinitionId;
    applyOriginFilters(filter, { sourceType, condition });
    applyDataScope(filter, dataAccess, SCOPE_MODULE_KEY);

    if (categoryId) {
      const defIds = await StockProductDefinitionModel.find({ categoryId, isActive: true }).distinct("_id");
      filter.productDefinitionId = filter.productDefinitionId ? filter.productDefinitionId : { $in: defIds };
    }

    if (search) filter.$or = await searchClause(search);

    const items = await StockInventoryItemModel.find(filter)
      .populate({
        path: "productDefinitionId",
        select: "name trackingMethod unit selectedFields categoryId",
        populate: { path: "selectedFields.fieldDefId", select: "code label inputType optionsSource showList isFilterable" },
      })
      .populate({ path: "branchId", select: "name code" })
      .populate({ path: "vendorId", select: "name" })
      .populate({ path: "invoiceId", select: "invoiceNumber receivedByName" })
      .sort({ createdAt: -1 })
      .lean();

    const categoryIds = [...new Set(items.map((it) => String(it.productDefinitionId?.categoryId)).filter(Boolean))];
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

    const individualCards = [];
    const groupCardByKey = new Map();

    for (const item of items) {
      const def = item.productDefinitionId;
      if (!def) continue;
      const categoryPath = await categoryPathFor(def.categoryId);

      if (def.trackingMethod === TRACKING_METHODS.INDIVIDUAL) {
        individualCards.push({
          cardType: "individual",
          _id: item._id,
          productDefinitionId: { ...def, categoryPath },
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
          sortAt: item.createdAt || item.receivedAt,
        });
      } else {
        const key = `${def._id}::${item.branchId?._id || "none"}`;
        if (!groupCardByKey.has(key)) {
          groupCardByKey.set(key, {
            cardType: "group",
            _id: key,
            productDefinitionId: { ...def, categoryPath },
            branchId: item.branchId,
            totalQty: 0,
            batchCount: 0,
            latestReceivedAt: null,
            sortAt: null,
            // Filled in after the loop from _valuesByCode below.
            fieldValues: {},
            variedFields: [],
            _valuesByCode: new Map(),
          });
        }
        const card = groupCardByKey.get(key);
        card.totalQty += item.quantity || 0;
        card.batchCount += 1;
        // A group card rolls up every batch of this product at this branch, and
        // each batch carries its own tracked values — two deliveries can hold
        // two different unique numbers. So a code is only shown on the card
        // when EVERY batch agrees on it; the rest are reported as varying, and
        // the per-batch numbers stay in the batch breakdown where they belong.
        Object.entries(item.fieldValues || {}).forEach(([code, val]) => {
          if (val === undefined || val === null || val === "") return;
          if (!card._valuesByCode.has(code)) card._valuesByCode.set(code, new Set());
          card._valuesByCode.get(code).add(String(val));
        });
        const at = item.receivedAt || item.createdAt;
        if (!card.latestReceivedAt || new Date(at) > new Date(card.latestReceivedAt)) {
          card.latestReceivedAt = at;
          card.sortAt = item.createdAt || item.receivedAt;
        }
      }
    }

    for (const card of groupCardByKey.values()) {
      for (const [code, values] of card._valuesByCode) {
        if (values.size === 1) card.fieldValues[code] = [...values][0];
        else card.variedFields.push(code);
      }
      delete card._valuesByCode;
    }

    const combined = [...individualCards, ...groupCardByKey.values()].sort(
      (a, b) => new Date(b.sortAt || 0) - new Date(a.sortAt || 0)
    );

    const total = combined.length;
    const data = combined.slice(skip, skip + limit);
    return { data, total };
  }

  /* ---------------------------------------------------------------------- */
  /* Product Inventory — one row per product, aggregated available quantity  */
  /* (individual-tracked: count of AVAILABLE+APPROVED docs; quantity-tracked: */
  /* sum of their `quantity`). Powers Feature 3 (Product Inventory page).    */
  /* ---------------------------------------------------------------------- */

  static async getProductInventorySummary({
    skip,
    limit,
    search,
    categoryId,
    productDefinitionId,
    branchId,
    stockStatus,
  }, dataAccess) {
    const productMatch = { isActive: true };
    if (categoryId) productMatch.categoryId = new mongoose.Types.ObjectId(categoryId);
    if (productDefinitionId) productMatch._id = new mongoose.Types.ObjectId(productDefinitionId);
    if (search) productMatch.name = { $regex: search, $options: "i" };

    const stockMatchExpr = [
      { $eq: ["$productDefinitionId", "$$pid"] },
      { $eq: ["$isActive", true] },
      { $eq: ["$status", ITEM_STATUS.AVAILABLE] },
      { $eq: ["$approvalStatus", ITEM_APPROVAL_STATUS.APPROVED] },
    ];
    if (branchId) {
      stockMatchExpr.push({ $eq: ["$branchId", new mongoose.Types.ObjectId(branchId)] });
    }
    const scopedBranchIds = resolveDimensionAllowList(dataAccess, "branch");
    if (scopedBranchIds !== null) {
      stockMatchExpr.push({ $in: ["$branchId", scopedBranchIds.map((id) => new mongoose.Types.ObjectId(id))] });
    }

    const pipeline = [
      { $match: productMatch },
      {
        $lookup: {
          from: "inventory_items",
          let: { pid: "$_id" },
          pipeline: [
            { $match: { $expr: { $and: stockMatchExpr } } },
            { $group: { _id: null, qty: { $sum: { $ifNull: ["$quantity", 1] } } } },
          ],
          as: "stock",
        },
      },
      {
        $addFields: {
          availableQty: { $ifNull: [{ $arrayElemAt: ["$stock.qty", 0] }, 0] },
        },
      },
    ];

    if (stockStatus === "OUT_OF_STOCK") pipeline.push({ $match: { availableQty: { $lte: 0 } } });
    if (stockStatus === "IN_STOCK") pipeline.push({ $match: { availableQty: { $gt: 0 } } });

    pipeline.push({ $sort: { name: 1 } });
    pipeline.push({ $project: { name: 1, categoryId: 1, availableQty: 1, trackingMethod: 1, unit: 1 } });

    const [countResult, rows] = await Promise.all([
      StockProductDefinitionModel.aggregate([...pipeline, { $count: "total" }]),
      StockProductDefinitionModel.aggregate([...pipeline, { $skip: skip }, { $limit: limit }]),
    ]);
    const total = countResult[0]?.total || 0;

    const categories = await StockCategoryModel.find({
      _id: { $in: rows.map((r) => r.categoryId) },
    })
      .select("path")
      .lean();
    const pathByCategoryId = new Map(categories.map((c) => [String(c._id), c.path]));
    const displayPathCache = new Map();
    const data = [];
    for (const r of rows) {
      const catId = String(r.categoryId);
      if (!displayPathCache.has(catId)) {
        const path = pathByCategoryId.get(catId);
        displayPathCache.set(catId, path ? await StockCategoryService.buildDisplayPath(path) : "");
      }
      data.push({
        productDefinitionId: r._id,
        productName: r.name,
        categoryId: r.categoryId,
        categoryPath: displayPathCache.get(catId),
        availableQty: r.availableQty,
        trackingMethod: r.trackingMethod,
        unit: r.unit,
      });
    }

    return { data, total };
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

  static async getItemTimeline(id, dataAccess) {
    const item = await StockInventoryItemModel.findOne({ _id: id })
      .populate({ path: "productDefinitionId", select: "name trackingMethod unit" })
      .populate({ path: "branchId", select: "name" })
      .populate({ path: "vendorId", select: "name" })
      .lean();
    if (!item || !isWithinDataScope(item, dataAccess, SCOPE_MODULE_KEY)) throw new Error("Inventory item not found");

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

  // ─── Get single item ──────────────────────────────────────────────────────────

  static async getInventoryItemById(id, dataAccess) {
    try {
      const item = await StockInventoryItemModel.findOne({
        _id: id,
        isActive: true,
      })
        .populate({
          path: "productDefinitionId",
          select: "name trackingMethod unit selectedFields categoryId",
          populate: {
            path: "selectedFields.fieldDefId",
            select: "code label inputType optionsSource",
          },
        })
        .lean();
      if (!item || !isWithinDataScope(item, dataAccess, SCOPE_MODULE_KEY)) {
        throw new Error("Inventory item not found");
      }
      return item;
    } catch (error) {
      throw error;
    }
  }

  // ─── Stock summary ────────────────────────────────────────────────────────────

  static async getStockSummary(defId, dataAccess) {
    try {
      const def = await StockProductDefinitionModel.findOne({
        _id: defId,
        isActive: true,
      }).lean();
      if (!def) throw new Error("Product definition not found");

      if (def.trackingMethod === TRACKING_METHODS.INDIVIDUAL) {
        // Counted per status in one pass, over EVERY status in ITEM_STATUS —
        // the hardcoded list this replaces silently dropped debited units from
        // the total, and would drop any status added later too.
        const rows = await StockInventoryItemModel.aggregate([
          {
            $match: applyDataScope(
              { productDefinitionId: def._id, isActive: true },
              dataAccess,
              SCOPE_MODULE_KEY
            ),
          },
          { $group: { _id: "$status", n: { $sum: 1 } } },
        ]);
        const byStatus = Object.fromEntries(ITEM_STATUS_ARRAY.map((s) => [s, 0]));
        rows.forEach((r) => (byStatus[r._id] = r.n));
        return {
          trackingMethod: "individual",
          total: Object.values(byStatus).reduce((a, b) => a + b, 0),
          available: byStatus.AVAILABLE,
          assigned: byStatus.ASSIGNED,
          inRepair: byStatus.IN_REPAIR,
          scrapped: byStatus.SCRAPPED,
          inTransit: byStatus.IN_TRANSIT,
          debited: byStatus.DEBITED,
        };
      } else {
        // quantity mode — aggregate
        const pipeline = [
          {
            $match: applyDataScope(
              { productDefinitionId: def._id, isActive: true },
              dataAccess,
              SCOPE_MODULE_KEY
            ),
          },
          {
            $group: {
              _id: "$status",
              total: { $sum: "$quantity" },
            },
          },
        ];
        const result = await StockInventoryItemModel.aggregate(pipeline);
        const byStatus = {};
        result.forEach((r) => (byStatus[r._id] = r.total));

        return {
          trackingMethod: "quantity",
          totalQuantity: Object.values(byStatus).reduce((a, b) => a + b, 0),
          availableQty: byStatus["AVAILABLE"] ?? 0,
          assignedQty: byStatus["ASSIGNED"] ?? 0,
          inRepairQty: byStatus["IN_REPAIR"] ?? 0,
          scrappedQty: byStatus["SCRAPPED"] ?? 0,
          inTransitQty: byStatus["IN_TRANSIT"] ?? 0,
          debitedQty: byStatus["DEBITED"] ?? 0,
        };
      }
    } catch (error) {
      throw error;
    }
  }

  // ─── Update field values ──────────────────────────────────────────────────────

  static async updateInventoryItem(id, body, actor, session, dataAccess) {
    try {
      const item = await StockInventoryItemModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!item) throw new Error("Inventory item not found");
      assertDataScope(item, dataAccess);
      const before = item.toObject();

      if (body.fieldValues !== undefined) item.fieldValues = body.fieldValues;
      if (body.quantity !== undefined) item.quantity = body.quantity;

      // Editing a serial is editing what the unit is known by — same two rules
      // as when it arrived (at least one, and nobody else's).
      if (body.fieldValues !== undefined && item.approvalStatus !== ITEM_APPROVAL_STATUS.REJECTED) {
        await StockInventoryItemService._rekey(item, session);
      }

      await item.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: item._id, action: "UPDATE", actor, before, after: item.toObject(),
      });
      return item;
    } catch (error) {
      throw error;
    }
  }

  // ─── Update status ────────────────────────────────────────────────────────────

  static async updateItemStatus(id, status, actor, session, dataAccess) {
    try {
      if (!ITEM_STATUS_ARRAY.includes(status))
        throw new Error(`Invalid status: ${status}`);

      const item = await StockInventoryItemModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!item) throw new Error("Inventory item not found");
      assertDataScope(item, dataAccess);
      if (FLOW_OWNED_STATUSES.includes(status) || FLOW_OWNED_STATUSES.includes(item.status)) {
        const change = item.status === status ? status : `${item.status} → ${status}`;
        throw new AppError(`Invalid: ${change} can only be changed through its own flow (issue, opening stock, debit note)`, 400);
      }
      const before = item.toObject();

      item.status = status;
      await item.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: item._id, action: "UPDATE_STATUS", actor, before, after: item.toObject(),
      });
      return item;
    } catch (error) {
      throw error;
    }
  }

  // ─── Soft delete ──────────────────────────────────────────────────────────────

  static async softDeleteInventoryItem(id, actor, session, dataAccess) {
    try {
      const item = await StockInventoryItemModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!item) throw new Error("Inventory item not found");
      assertDataScope(item, dataAccess);
      const before = item.toObject();

      item.isActive = false;
      item.deletedAt = new Date();
      item.deletedBy = actorSnapshot(actor);
      // A deleted unit no longer holds its serial — see restore for the way back.
      item.identifiers = undefined;
      await item.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: item._id, action: "DELETE", actor, before, after: item.toObject(),
      });
      return item;
    } catch (error) {
      throw error;
    }
  }

  // ─── Restore ──────────────────────────────────────────────────────────────────

  static async restoreInventoryItem(id, actor, session, dataAccess) {
    try {
      const item = await StockInventoryItemModel.findOne({ _id: id }).session(session);
      if (!item) throw new Error("Inventory item not found");
      assertDataScope(item, dataAccess);
      if (item.isActive) throw new Error("Inventory item is already active");
      const before = item.toObject();

      item.isActive = true;
      item.deletedAt = null;
      item.deletedBy = null;
      // The serial may have been re-entered on another unit since the delete —
      // in that case the restore is refused and names that unit.
      if (item.approvalStatus !== ITEM_APPROVAL_STATUS.REJECTED) {
        await StockInventoryItemService._rekey(item, session);
      }
      await item.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: item._id, action: "RESTORE", actor, before, after: item.toObject(),
      });
      return item;
    } catch (error) {
      throw error;
    }
  }
}
