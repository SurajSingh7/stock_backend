import mongoose from "mongoose";
import { ITEM_STATUS_ARRAY } from "../constants/stock.enums.js";

const stockInventoryItemSchema = new mongoose.Schema(
  {
    productDefinitionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "stock_product_definitions",
      required: true,
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
stockInventoryItemSchema.index({ status: 1 });
stockInventoryItemSchema.index({ "fieldValues.imei": 1 }, { sparse: true });
stockInventoryItemSchema.index({ "fieldValues.serial_no": 1 }, { sparse: true });

const StockInventoryItemModel = mongoose.model(
  "stock_inventory_items",
  stockInventoryItemSchema
);

export default StockInventoryItemModel;
