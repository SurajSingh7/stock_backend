import mongoose from "mongoose";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockFieldDefinitionModel from "../models/stock.field.definition.model.js";
import StockCategoryModel from "../models/stock.category.model.js";
import StockInvoiceModel from "../models/stock.invoice.model.js";
import StockCategoryService from "./stock.category.service.js";
import { paginate } from "../helpers/pagination.helper.js";
import {
  TRACKING_METHODS,
  ITEM_STATUS_ARRAY,
  ITEM_STATUS,
  ITEM_APPROVAL_STATUS,
} from "../constants/stock.enums.js";

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

  // ─── Create single item ───────────────────────────────────────────────────────

  static async createInventoryItem(body, session) {
    try {
      const { productDefinitionId, fieldValues, quantity, receivedAt, receivedBy, warehouseId, vendorId } = body;

      const def = await StockProductDefinitionModel.findOne({
        _id: productDefinitionId,
        isActive: true,
      }).lean();
      if (!def) throw new Error("Product definition not found");

      if (def.trackingMethod === TRACKING_METHODS.QUANTITY && !quantity)
        throw new Error("quantity is required for quantity-tracked products");

      await StockInventoryItemService._validateFieldValues(def, fieldValues || {});

      const item = new StockInventoryItemModel({
        productDefinitionId,
        vendorId: vendorId ?? null,
        warehouseId: warehouseId ?? null,
        fieldValues: fieldValues || {},
        quantity: def.trackingMethod === TRACKING_METHODS.QUANTITY ? quantity : null,
        receivedAt,
        receivedBy: receivedBy ?? null,
      });

      await item.save({ session });
      return item;
    } catch (error) {
      throw error;
    }
  }

  // ─── Bulk create (individual mode) ───────────────────────────────────────────

  static async bulkCreateInventoryItems(body, session) {
    try {
      const { productDefinitionId, items, receivedAt, receivedBy, warehouseId, vendorId } = body;

      const def = await StockProductDefinitionModel.findOne({
        _id: productDefinitionId,
        isActive: true,
      }).lean();
      if (!def) throw new Error("Product definition not found");

      if (def.trackingMethod !== TRACKING_METHODS.INDIVIDUAL)
        throw new Error("Bulk create is only for individual-tracked products");

      const docs = [];
      const errors = [];

      for (let i = 0; i < items.length; i++) {
        try {
          await StockInventoryItemService._validateFieldValues(def, items[i].fieldValues || {});
          docs.push({
            productDefinitionId,
            vendorId: vendorId ?? null,
            warehouseId: warehouseId ?? null,
            fieldValues: items[i].fieldValues || {},
            quantity: null,
            receivedAt,
            receivedBy: receivedBy ?? null,
          });
        } catch (err) {
          errors.push({ index: i, error: err.message });
        }
      }

      let created = 0;
      if (docs.length > 0) {
        const result = await StockInventoryItemModel.insertMany(docs, { session });
        created = result.length;
      }

      return { created, errors };
    } catch (error) {
      throw error;
    }
  }

  // ─── List items ───────────────────────────────────────────────────────────────

  static async getAllInventoryItems({
    skip,
    limit,
    productDefinitionId,
    categoryId,
    warehouseId,
    status,
    approvalStatus,
    search,
    showInactive,
  }) {
    try {
      const filter = showInactive ? {} : { isActive: true };
      if (productDefinitionId) filter.productDefinitionId = productDefinitionId;
      if (warehouseId) filter.warehouseId = warehouseId;
      if (status) filter.status = status;
      if (approvalStatus) filter.approvalStatus = approvalStatus;

      if (categoryId) {
        const defIds = await StockProductDefinitionModel.find({ categoryId, isActive: true }).distinct("_id");
        filter.productDefinitionId = filter.productDefinitionId
          ? filter.productDefinitionId
          : { $in: defIds };
      }

      if (search) {
        // Generalized beyond the original hardcoded imei/serial_no: any field
        // definition marked isFilterable or showList is searchable, since
        // that's exactly the set of columns the Item Inventory list renders.
        const searchableFields = await StockFieldDefinitionModel.find({
          isActive: true,
          $or: [{ isFilterable: true }, { showList: true }],
        })
          .select("code")
          .lean();
        const codes = new Set(searchableFields.map((f) => f.code));
        codes.add("imei");
        codes.add("serial_no");
        filter.$or = [...codes].map((code) => ({
          [`fieldValues.${code}`]: { $regex: search, $options: "i" },
        }));
      }

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
          .populate({ path: "warehouseId", select: "name code" })
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
  /* tracked products, but exactly one card per (product, warehouse) for     */
  /* group-tracked products — batches are summed, never shown as separate    */
  /* rows. Fetches broadly (this system's inventory volumes are small) and   */
  /* merges + paginates in memory so a group card's total is never split     */
  /* across pages.                                                           */
  /* ---------------------------------------------------------------------- */

  static async getInventoryCards({ skip, limit, search, categoryId, productDefinitionId, warehouseId }) {
    const filter = { isActive: true, status: ITEM_STATUS.AVAILABLE, approvalStatus: ITEM_APPROVAL_STATUS.APPROVED };
    if (warehouseId) filter.warehouseId = warehouseId;
    if (productDefinitionId) filter.productDefinitionId = productDefinitionId;

    if (categoryId) {
      const defIds = await StockProductDefinitionModel.find({ categoryId, isActive: true }).distinct("_id");
      filter.productDefinitionId = filter.productDefinitionId ? filter.productDefinitionId : { $in: defIds };
    }

    if (search) {
      const searchableFields = await StockFieldDefinitionModel.find({
        isActive: true,
        $or: [{ isFilterable: true }, { showList: true }],
      })
        .select("code")
        .lean();
      const codes = new Set(searchableFields.map((f) => f.code));
      codes.add("imei");
      codes.add("serial_no");
      filter.$or = [...codes].map((code) => ({ [`fieldValues.${code}`]: { $regex: search, $options: "i" } }));
    }

    const items = await StockInventoryItemModel.find(filter)
      .populate({
        path: "productDefinitionId",
        select: "name trackingMethod unit selectedFields categoryId",
        populate: { path: "selectedFields.fieldDefId", select: "code label inputType optionsSource showList isFilterable" },
      })
      .populate({ path: "warehouseId", select: "name code" })
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
          warehouseId: item.warehouseId,
          vendorId: item.vendorId,
          invoiceId: item.invoiceId,
          fieldValues: item.fieldValues,
          status: item.status,
          approvalStatus: item.approvalStatus,
          receivedAt: item.receivedAt,
          createdAt: item.createdAt,
          sortAt: item.createdAt || item.receivedAt,
        });
      } else {
        const key = `${def._id}::${item.warehouseId?._id || "none"}`;
        if (!groupCardByKey.has(key)) {
          groupCardByKey.set(key, {
            cardType: "group",
            _id: key,
            productDefinitionId: { ...def, categoryPath },
            warehouseId: item.warehouseId,
            totalQty: 0,
            batchCount: 0,
            latestReceivedAt: null,
            sortAt: null,
          });
        }
        const card = groupCardByKey.get(key);
        card.totalQty += item.quantity || 0;
        card.batchCount += 1;
        const at = item.receivedAt || item.createdAt;
        if (!card.latestReceivedAt || new Date(at) > new Date(card.latestReceivedAt)) {
          card.latestReceivedAt = at;
          card.sortAt = item.createdAt || item.receivedAt;
        }
      }
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
    warehouseId,
    stockStatus,
  }) {
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
    if (warehouseId) {
      stockMatchExpr.push({ $eq: ["$warehouseId", new mongoose.Types.ObjectId(warehouseId)] });
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
  /* Receiving history — one row per invoice that contributed approved stock */
  /* for this product. Powers Feature 3's History screen.                    */
  /* ---------------------------------------------------------------------- */

  static async getReceivingHistory(productDefinitionId, { warehouseId } = {}) {
    const match = {
      productDefinitionId: new mongoose.Types.ObjectId(productDefinitionId),
      isActive: true,
      status: ITEM_STATUS.AVAILABLE,
      approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
      invoiceId: { $ne: null },
    };
    if (warehouseId) match.warehouseId = new mongoose.Types.ObjectId(warehouseId);

    const grouped = await StockInventoryItemModel.aggregate([
      { $match: match },
      { $group: { _id: "$invoiceId", qty: { $sum: { $ifNull: ["$quantity", 1] } } } },
    ]);

    const invoiceIds = grouped.map((g) => g._id);
    const invoices = await StockInvoiceModel.find({ _id: { $in: invoiceIds } })
      .select("invoiceNumber invoiceDate")
      .lean();
    const invoiceMap = new Map(invoices.map((inv) => [String(inv._id), inv]));

    return grouped
      .map((g) => ({
        invoiceId: g._id,
        invoiceNumber: invoiceMap.get(String(g._id))?.invoiceNumber || "",
        invoiceDate: invoiceMap.get(String(g._id))?.invoiceDate || null,
        quantity: g.qty,
      }))
      .sort((a, b) => new Date(b.invoiceDate || 0) - new Date(a.invoiceDate || 0));
  }

  // ─── Get single item ──────────────────────────────────────────────────────────

  static async getInventoryItemById(id) {
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
      if (!item) throw new Error("Inventory item not found");
      return item;
    } catch (error) {
      throw error;
    }
  }

  // ─── Stock summary ────────────────────────────────────────────────────────────

  static async getStockSummary(defId) {
    try {
      const def = await StockProductDefinitionModel.findOne({
        _id: defId,
        isActive: true,
      }).lean();
      if (!def) throw new Error("Product definition not found");

      if (def.trackingMethod === TRACKING_METHODS.INDIVIDUAL) {
        const statuses = ["AVAILABLE", "ALLOCATED", "IN_REPAIR", "SCRAPPED", "IN_TRANSIT"];
        const counts = await Promise.all(
          statuses.map((s) =>
            StockInventoryItemModel.countDocuments({
              productDefinitionId: defId,
              isActive: true,
              status: s,
            })
          )
        );
        const total = counts.reduce((a, b) => a + b, 0);
        return {
          trackingMethod: "individual",
          total,
          available: counts[0],
          allocated: counts[1],
          inRepair: counts[2],
          scrapped: counts[3],
          inTransit: counts[4],
        };
      } else {
        // quantity mode — aggregate
        const pipeline = [
          { $match: { productDefinitionId: def._id, isActive: true } },
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
          allocatedQty: byStatus["ALLOCATED"] ?? 0,
          inRepairQty: byStatus["IN_REPAIR"] ?? 0,
          scrappedQty: byStatus["SCRAPPED"] ?? 0,
          inTransitQty: byStatus["IN_TRANSIT"] ?? 0,
        };
      }
    } catch (error) {
      throw error;
    }
  }

  // ─── Update field values ──────────────────────────────────────────────────────

  static async updateInventoryItem(id, body, session) {
    try {
      const item = await StockInventoryItemModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!item) throw new Error("Inventory item not found");

      if (body.fieldValues !== undefined) item.fieldValues = body.fieldValues;
      if (body.quantity !== undefined) item.quantity = body.quantity;

      await item.save({ session });
      return item;
    } catch (error) {
      throw error;
    }
  }

  // ─── Update status ────────────────────────────────────────────────────────────

  static async updateItemStatus(id, status, session) {
    try {
      if (!ITEM_STATUS_ARRAY.includes(status))
        throw new Error(`Invalid status: ${status}`);

      const item = await StockInventoryItemModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!item) throw new Error("Inventory item not found");

      item.status = status;
      await item.save({ session });
      return item;
    } catch (error) {
      throw error;
    }
  }

  // ─── Soft delete ──────────────────────────────────────────────────────────────

  static async softDeleteInventoryItem(id, deletedBy, session) {
    try {
      const item = await StockInventoryItemModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!item) throw new Error("Inventory item not found");

      item.isActive = false;
      item.deletedAt = new Date();
      item.deletedBy = deletedBy ?? null;
      await item.save({ session });
      return item;
    } catch (error) {
      throw error;
    }
  }

  // ─── Restore ──────────────────────────────────────────────────────────────────

  static async restoreInventoryItem(id, session) {
    try {
      const item = await StockInventoryItemModel.findOne({ _id: id }).session(session);
      if (!item) throw new Error("Inventory item not found");
      if (item.isActive) throw new Error("Inventory item is already active");

      item.isActive = true;
      item.deletedAt = null;
      item.deletedBy = null;
      await item.save({ session });
      return item;
    } catch (error) {
      throw error;
    }
  }
}
