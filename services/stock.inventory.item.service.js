import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockFieldDefinitionModel from "../models/stock.field.definition.model.js";
import { TRACKING_METHODS, ITEM_STATUS_ARRAY } from "../constants/stock.enums.js";

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
      const { productDefinitionId, fieldValues, quantity, receivedAt, receivedBy } = body;

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
      const { productDefinitionId, items, receivedAt, receivedBy } = body;

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

  static async getAllInventoryItems({ skip, limit, productDefinitionId, status, search, showInactive }) {
    try {
      const filter = showInactive ? {} : { isActive: true };
      if (productDefinitionId) filter.productDefinitionId = productDefinitionId;
      if (status) filter.status = status;
      if (search) {
        filter.$or = [
          { "fieldValues.imei": { $regex: search, $options: "i" } },
          { "fieldValues.serial_no": { $regex: search, $options: "i" } },
        ];
      }

      const [data, total] = await Promise.all([
        StockInventoryItemModel.find(filter)
          .populate({
            path: "productDefinitionId",
            select: "name trackingMethod selectedFields",
            populate: {
              path: "selectedFields.fieldDefId",
              select: "code label inputType optionsSource",
            },
          })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        StockInventoryItemModel.countDocuments(filter),
      ]);

      return { data, total };
    } catch (error) {
      throw error;
    }
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
          select: "name trackingMethod selectedFields categoryId",
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
