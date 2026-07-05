import mongoose from "mongoose";
import { INPUT_TYPES_ARRAY } from "../constants/stock.enums.js";

const stockFieldDefinitionSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    order:
    {
      type: Number,
      default: 0
    },
    inputType: {
      type: String,
      enum: INPUT_TYPES_ARRAY,
      required: true,
    },
    optionsSource: {
      type: String,
      default: null,
    },
    isRequired: {
      type: Boolean,
      default: false,
    },
    isFilterable: {
      type: Boolean,
      default: false,
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

stockFieldDefinitionSchema.index({ code: 1 }, { unique: true });
stockFieldDefinitionSchema.index({ isActive: 1 });

const StockFieldDefinitionModel = mongoose.model(
  "stock_field_definitions",
  stockFieldDefinitionSchema
);

export default StockFieldDefinitionModel;
