import mongoose from "mongoose";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";

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

    // The only on/off: false = deleted (restorable) and never applied to a PO.
    // A separate ACTIVE/INACTIVE status existed until 2026-11-02
    // (scripts/remove-terms-status.js).
    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

stockTermsConditionSchema.index({ isDefault: 1 });
stockTermsConditionSchema.index({ applicableVendors: 1 });
stockTermsConditionSchema.index({ isActive: 1 });

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
// who created / last touched this — see the plugin for why it is a hook
stockTermsConditionSchema.plugin(actorStampPlugin);

const StockTermsConditionModel = mongoose.model(
  "terms_conditions",
  stockTermsConditionSchema,
  "terms_conditions"
);

export default StockTermsConditionModel;
