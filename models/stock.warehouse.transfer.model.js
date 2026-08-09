import mongoose from "mongoose";
import { TRANSFER_STATUS, TRANSFER_STATUS_ARRAY } from "../constants/stock.enums.js";

const { Schema } = mongoose;

/*
  warehouse_transfers — FUTURE SCHEMA SCAFFOLD, NOT WIRED UP.

  No service/controller/route/UI reads or writes this collection yet. It
  exists now so `inventory_items.warehouseId` (already added) can support
  Warehouse A -> Warehouse B -> Warehouse C movement later without a
  breaking schema change, per the explicit "design now, build later"
  requirement for the Warehouse feature.
*/

const transferItemSchema = new Schema(
  {
    productDefinitionId: { type: Schema.Types.ObjectId, ref: "product_definitions", required: true },
    inventoryItemId: { type: Schema.Types.ObjectId, ref: "inventory_items", default: null }, // individual-tracked
    quantity: { type: Number, required: true, min: 0 }, // quantity-tracked
  },
  { _id: false }
);

const warehouseTransferSchema = new Schema(
  {
    sourceWarehouseId: { type: Schema.Types.ObjectId, ref: "warehouses", required: true },
    destinationWarehouseId: { type: Schema.Types.ObjectId, ref: "warehouses", required: true },
    items: { type: [transferItemSchema], default: [] },

    status: {
      type: String,
      enum: TRANSFER_STATUS_ARRAY,
      default: TRANSFER_STATUS.PENDING,
    },

    requestedBy: { type: Schema.Types.ObjectId, ref: "users", default: null },
    requestedByName: { type: String, trim: true, default: "" },
    notes: { type: String, trim: true, default: "" },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

warehouseTransferSchema.index({ sourceWarehouseId: 1 });
warehouseTransferSchema.index({ destinationWarehouseId: 1 });
warehouseTransferSchema.index({ status: 1 });

const StockWarehouseTransferModel = mongoose.model(
  "warehouse_transfers",
  warehouseTransferSchema,
  "warehouse_transfers"
);

export default StockWarehouseTransferModel;
