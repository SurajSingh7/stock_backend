import mongoose from "mongoose";
import { CATEGORY_TYPES_ARRAY } from "../constants/stock.enums.js";

const stockCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: CATEGORY_TYPES_ARRAY,
      required: true,
    },
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "stock_categories",
      default: null,
    },
    path: {
      type: String,
      required: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
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

stockCategorySchema.index({ parentId: 1 });
stockCategorySchema.index({ path: 1 });
stockCategorySchema.index({ isActive: 1, type: 1 });

const StockCategoryModel = mongoose.model("stock_categories", stockCategorySchema);

export default StockCategoryModel;
