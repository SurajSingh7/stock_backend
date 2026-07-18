import mongoose from "mongoose";
import { TERMS_STATUS_ARRAY } from "../constants/stock.enums.js";

const { Schema } = mongoose;

const stockTermsConditionSchema = new Schema(
  {
    termName: { type: String, required: true, trim: true },

    // Exactly one ACTIVE default term may exist at a time (enforced in the
    // service — auto-demotes the previous default — and backstopped by the
    // partial unique index below).
    isDefault: { type: Boolean, default: false },

    // Required (non-empty) when isDefault is false; ignored/cleared when true.
    applicableVendors: [{ type: Schema.Types.ObjectId, ref: "vendors" }],

    // Rich text (HTML) authored via the master's formatting toolbar.
    termsContent: { type: String, required: true },

    status: {
      type: String,
      enum: TERMS_STATUS_ARRAY,
      default: "ACTIVE",
    },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

stockTermsConditionSchema.index({ isDefault: 1 });
stockTermsConditionSchema.index({ applicableVendors: 1 });
stockTermsConditionSchema.index({ isActive: 1, status: 1 });

// DB-level guard alongside the service-layer "auto-demote previous default"
// logic — only one ACTIVE document can have isDefault: true.
stockTermsConditionSchema.index(
  { isDefault: 1 },
  {
    unique: true,
    partialFilterExpression: { isDefault: true, isActive: true },
    name: "uniq_active_default_term",
  }
);

// 3rd arg pins the collection explicitly — no pluralization guessing.
const StockTermsConditionModel = mongoose.model(
  "terms_conditions",
  stockTermsConditionSchema,
  "terms_conditions"
);

export default StockTermsConditionModel;
