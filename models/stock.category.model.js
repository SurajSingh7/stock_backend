import mongoose from "mongoose";
import { CATEGORY_TYPES_ARRAY } from "../constants/stock.enums.js";

const stockCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
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

// 🔒 DB-level duplicate-name guard — works alongside the service-layer check.
// Case-insensitive (collation strength 2), scoped to ACTIVE categories only
// via partialFilterExpression. Inactive (soft-deleted) categories are
// deliberately excluded from this constraint — they're expected to be
// purged automatically after a retention window, so a stale inactive name
// should never block creating a new active category with the same name.
stockCategorySchema.index(
  { name: 1 },
  {
    unique: true,
    collation: { locale: "en", strength: 2 },
    partialFilterExpression: { isActive: true },
    name: "uniq_active_category_name_ci",
  }
);

const StockCategoryModel = mongoose.model("stock_categories", stockCategorySchema);

export default StockCategoryModel;