import mongoose from "mongoose";
import { STOCK_LEVEL_ARRAY } from "../constants/stock.enums.js";

const { Schema } = mongoose;

/*
  What one low-stock alert was about: the products in one branch that went
  LOW or OUT in the same check. It is the record the LOW_STOCK alert event
  points at, so the Message Log can show what was sent and why, after the
  stock has long since moved on.
*/
const noticeItemSchema = new Schema(
  {
    productDefinitionId: { type: Schema.Types.ObjectId, ref: "product_definitions", required: true },
    productName: { type: String, trim: true, default: "" },
    unit: { type: String, trim: true, default: "" },
    available: { type: Number, default: 0 },
    threshold: { type: Number, default: 0 },
    level: { type: String, enum: STOCK_LEVEL_ARRAY, required: true },
  },
  { _id: false }
);

const lowStockNoticeSchema = new Schema(
  {
    branchId: { type: Schema.Types.ObjectId, ref: "branches", required: true },
    branchName: { type: String, trim: true, default: "" },
    items: { type: [noticeItemSchema], default: [] },
  },
  { timestamps: true }
);

lowStockNoticeSchema.index({ branchId: 1, createdAt: -1 });

const StockLowStockNoticeModel = mongoose.model("low_stock_notices", lowStockNoticeSchema, "low_stock_notices");

export default StockLowStockNoticeModel;
