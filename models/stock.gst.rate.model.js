import mongoose from "mongoose";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";

const { Schema } = mongoose;

/**
 * GST slabs, as data rather than a hardcoded enum.
 *
 * This used to be `GST_RATES_ARRAY = ["0","5","12","18","28"]` in
 * constants/stock.enums.js. That array went stale the moment the slabs were
 * revised and needed a code deploy to correct — a rate change is a finance
 * event, not an engineering one, so it belongs to the admin.
 *
 * HISTORY IS SAFE. Nothing references a rate row by id: quotations, purchase
 * orders and product definitions all persist the *number*. Deactivating the
 * 12% row therefore leaves every document ever priced at 12% priced at 12%,
 * which is what accounting and the law both require. Never turn `gstRate` on
 * those models into a ref — that is the whole reason this is safe.
 */
const gstRateSchema = new Schema(
  {
    // The percentage itself, and the only thing other collections ever store.
    // Number (not String) to match how quotations and purchase orders have
    // always held it — the old product-definition String was the odd one out.
    rate: {
      type: Number,
      required: true,
      min: [0, "rate cannot be negative"],
      max: [100, "rate cannot exceed 100"],
    },
    // What dropdowns show. Defaults to "18%" but stays editable, because a
    // slab is sometimes better named than numbered ("40% (Demerit)").
    label: { type: String, trim: true, default: "" },
    // Free text for whoever maintains this later — "standard rate", "sin and
    // luxury goods", a circular number.
    description: { type: String, trim: true, default: "" },

    // Display sequence in pickers. Rates are read as a ladder, so an explicit
    // order beats sorting by createdAt.
    order: { type: Number, default: 0 },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

// One row per slab. Partial so a soft-deleted 12% does not block re-creating
// it — the intended path is Restore, but a hard block here would be a dead end.
gstRateSchema.index({ rate: 1 }, { unique: true, partialFilterExpression: { isActive: true } });
gstRateSchema.index({ isActive: 1, order: 1 });

// Fill the label from the rate when the admin leaves it blank, so the common
// case needs one field and the label is never empty in a dropdown.
gstRateSchema.pre("validate", function fillLabel(next) {
  if (!this.label && this.rate !== undefined && this.rate !== null) {
    this.label = `${this.rate}%`;
  }
  next();
});

// who created / last touched this — see the plugin for why it is a hook
gstRateSchema.plugin(actorStampPlugin);

const StockGstRateModel = mongoose.model("gstrates", gstRateSchema, "gstrates");

export default StockGstRateModel;
