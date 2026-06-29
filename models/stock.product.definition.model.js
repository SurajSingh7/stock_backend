import mongoose from "mongoose";
import {
  TRACKING_METHODS_ARRAY,
  PRODUCT_DEF_STATUS_ARRAY,
} from "../constants/stock.enums.js";

const selectedFieldSchema = new mongoose.Schema(
  {
    fieldDefId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "stock_field_definitions",
      required: true,
    },
    isRequired: {
      type: Boolean,
      default: false,
    },
    order: {
      type: Number,
      required: true,
    },
  },
  { _id: false }
);

const stockProductDefinitionSchema = new mongoose.Schema(
  {
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "stock_categories",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    trackingMethod: {
      type: String,
      enum: TRACKING_METHODS_ARRAY,
      required: true,
    },
    selectedFields: {
      type: [selectedFieldSchema],
      default: [],
    },
    status: {
      type: String,
      enum: PRODUCT_DEF_STATUS_ARRAY,
      default: "ACTIVE",
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

stockProductDefinitionSchema.index({ categoryId: 1, isActive: 1 });
stockProductDefinitionSchema.index({ trackingMethod: 1 });
stockProductDefinitionSchema.index({ name: 1 });

const StockProductDefinitionModel = mongoose.model(
  "stock_product_definitions",
  stockProductDefinitionSchema
);

export default StockProductDefinitionModel;
