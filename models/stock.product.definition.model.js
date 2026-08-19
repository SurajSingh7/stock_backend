import mongoose from "mongoose";
import {
  TRACKING_METHODS_ARRAY,
  PRODUCT_DEF_STATUS_ARRAY,
  UNIT_TYPES_ARRAY,
  GST_RATES_ARRAY,
} from "../constants/stock.enums.js";

const selectedFieldSchema = new mongoose.Schema(
  {
    fieldDefId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "field_definitions", // ← was "stock_field_definitions"
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
      ref: "categories", // ← was "stock_categories"
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

    // ── FIELDS added earlier for billing/GST/unit UI ──
    gstRate: {
      type: String,
      enum: GST_RATES_ARRAY,
      default: null,
    },
    // Independent of trackingMethod — both are explicit client choices
    // (e.g. Group+Pieces for bottles, Individual+Meter for a serialized
    // reel are both valid). Never derive one from the other.
    unit: {
      type: String,
      enum: UNIT_TYPES_ARRAY,
      required: true,
    },
    stockAlertThreshold: {
      type: Number,
      default: null,
      min: 0,
    },
    // Default warranty (years) for this product — vendors may override this
    // per assignment (see Vendor.assignedProducts.overrides.warrantyYears),
    // and that override is snapshotted onto quotation items.
    //
    // Deliberately NOT `required: true` here: Mongoose re-validates the whole
    // document on every .save() (soft-delete, restore, unrelated field edits
    // — not just create), so a schema-level `required` would permanently
    // block those operations on any product saved before this field existed.
    // "Required" is enforced instead at the API layer for create/update
    // (validateProductDefinitionExtras in stock.validator.js).
    warrantyYears: {
      type: Number,
      default: null,
      min: 1,
    },
    // ───────────────────────────────────────────────────

    // ── Product image ──
    // Stores a relative public path (e.g. "/uploads/stock/products/product_xxx.jpg"),
    // set by the controller after multer saves the file to disk. Never store an
    // absolute filesystem path here — see stock.upload.helper.js.
    image: {
      type: String,
      default: null,
    },
    // ──────────────────────────

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

// 3rd arg pins the collection explicitly — no pluralization guessing.
const StockProductDefinitionModel = mongoose.model(
  "product_definitions",
  stockProductDefinitionSchema,
  "product_definitions"
);

export default StockProductDefinitionModel;