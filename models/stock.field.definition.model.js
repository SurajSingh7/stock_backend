import mongoose from "mongoose";
import { INPUT_TYPES_ARRAY, TRACKING_METHODS_ARRAY } from "../constants/stock.enums.js";

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
    order: {
      type: Number,
      default: 0,
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
    // Whether this field should render as a column on the Item Inventory
    // list (dynamic, per-product — see stock.inventory.item.service.js).
    showList: {
      type: Boolean,
      default: false,
    },
    // Which tracking method(s) this field is offered for on the Product
    // Definition "Applicable Fields" picker (see
    // stock.product.definition.service.js). Defaults to both.
    applicableTrackingMethods: {
      type: [String],
      enum: TRACKING_METHODS_ARRAY,
      default: TRACKING_METHODS_ARRAY,
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length > 0,
        message: "applicableTrackingMethods must have at least one value",
      },
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

// 3rd arg pins the collection explicitly — no pluralization guessing.
const StockFieldDefinitionModel = mongoose.model(
  "field_definitions",
  stockFieldDefinitionSchema,
  "field_definitions"
);

export default StockFieldDefinitionModel;