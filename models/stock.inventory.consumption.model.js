import mongoose from "mongoose";
import { CONSUMPTION_REF_TYPE_ARRAY } from "../constants/stock.enums.js";

const { Schema } = mongoose;

/*
  inventory_consumptions — FUTURE SCHEMA SCAFFOLD, NOT WIRED UP.

  No service/controller/route/UI reads or writes this collection yet. It
  exists now so future "item used in project/job/work order" consumption
  tracking can be built without a breaking schema change, per the explicit
  "design now, build later" requirement.
*/

const consumedForSchema = new Schema(
  {
    type: { type: String, enum: CONSUMPTION_REF_TYPE_ARRAY, default: null },
    refId: { type: Schema.Types.ObjectId, default: null },
    refLabel: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const inventoryConsumptionSchema = new Schema(
  {
    inventoryItemId: { type: Schema.Types.ObjectId, ref: "inventory_items", default: null }, // individual-tracked
    productDefinitionId: { type: Schema.Types.ObjectId, ref: "product_definitions", required: true },
    quantity: { type: Number, required: true, min: 0 }, // quantity-tracked
    branchId: { type: Schema.Types.ObjectId, ref: "branches", default: null },

    consumedFor: { type: consumedForSchema, default: () => ({}) },

    consumedBy: { type: Schema.Types.ObjectId, ref: "users", default: null },
    consumedByName: { type: String, trim: true, default: "" },
    consumedAt: { type: Date, default: Date.now },
    notes: { type: String, trim: true, default: "" },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

inventoryConsumptionSchema.index({ productDefinitionId: 1 });
inventoryConsumptionSchema.index({ inventoryItemId: 1 });
inventoryConsumptionSchema.index({ branchId: 1 });

const StockInventoryConsumptionModel = mongoose.model(
  "inventory_consumptions",
  inventoryConsumptionSchema,
  "inventory_consumptions"
);

export default StockInventoryConsumptionModel;
