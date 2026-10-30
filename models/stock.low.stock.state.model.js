import mongoose from "mongoose";
import { STOCK_LEVEL, STOCK_LEVEL_ARRAY } from "../constants/stock.enums.js";

const { Schema } = mongoose;

/*
  One row per product × branch that is currently below its threshold — the
  memory that stops the low-stock check from repeating itself. A row exists
  only while the pair is LOW or OUT; back above the threshold, it is deleted,
  so the next drop is news again.

    level          where it stands now
    notifiedLevel  the worst level people were told about in this dip — an
                   alert goes out only when level gets worse than this. Set
                   only when an alert actually went out, so switching the
                   rule on later still reports what is already low.
    since          when this dip began (the Low Stock page's "Low since")
*/
const lowStockStateSchema = new Schema(
  {
    productDefinitionId: { type: Schema.Types.ObjectId, ref: "product_definitions", required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "branches", required: true },
    level: { type: String, enum: STOCK_LEVEL_ARRAY.filter((l) => l !== STOCK_LEVEL.OK), required: true },
    // null = nobody has been told yet (no LOW_STOCK rule was on when it dipped)
    notifiedLevel: { type: String, enum: [...STOCK_LEVEL_ARRAY.filter((l) => l !== STOCK_LEVEL.OK), null], default: null },
    available: { type: Number, default: 0 },
    threshold: { type: Number, default: 0 },
    since: { type: Date, required: true },
  },
  { timestamps: true }
);

// The unique pair is also what makes two overlapping checks safe: only one
// of them can insert the row, so only one sends the alert.
lowStockStateSchema.index({ productDefinitionId: 1, branchId: 1 }, { unique: true });
lowStockStateSchema.index({ branchId: 1 });

const StockLowStockStateModel = mongoose.model("low_stock_states", lowStockStateSchema, "low_stock_states");

export default StockLowStockStateModel;
