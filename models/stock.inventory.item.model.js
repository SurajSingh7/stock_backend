import mongoose from "mongoose";
import { ITEM_STATUS_ARRAY } from "../constants/stock.enums.js";

const stockInventoryItemSchema = new mongoose.Schema(
  {
    productDefinitionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "product_definitions", // ← was "stock_product_definitions"
      required: true,
    },
    // Optional — who the stock was received from (Section 8.4 / 9 of spec).
    // Add here now so the vendor delete-guard can be uncommented later.
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "vendors", // ← matches the vendor model's registered name
      default: null,
    },
    status: {
      type: String,
      enum: ITEM_STATUS_ARRAY,
      default: "AVAILABLE",
    },
    fieldValues: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    quantity: {
      type: Number,
      default: null,
    },
    receivedAt: {
      type: Date,
      required: true,
    },
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
  },
  { timestamps: true }
);

stockInventoryItemSchema.index({ productDefinitionId: 1, isActive: 1 });
stockInventoryItemSchema.index({ vendorId: 1 });
stockInventoryItemSchema.index({ status: 1 });
stockInventoryItemSchema.index({ "fieldValues.imei": 1 }, { sparse: true });
stockInventoryItemSchema.index({ "fieldValues.serial_no": 1 }, { sparse: true });

// 3rd arg pins the collection explicitly — no pluralization guessing.
const StockInventoryItemModel = mongoose.model(
  "inventory_items",
  stockInventoryItemSchema,
  "inventory_items"
);

export default StockInventoryItemModel;