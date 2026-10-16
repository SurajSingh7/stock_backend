import mongoose from "mongoose";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";

const { Schema } = mongoose;

/**
 * TDS deducted from what we pay a vendor, one rate per BUYER entity.
 *
 * The entity is one of our own companies (WIBRO, GNS, GTEL…) — the internal
 * companies list the Tracking Orders "+ Add Entity" popup reads. Keyed on the
 * alias, not the entity row: that source has one row per company PER STATE,
 * and the rate is the company's, the same in every state.
 *
 * HISTORY IS SAFE, same as GST. An invoice snapshots the rate onto itself the
 * moment it first enters the ledger (invoice.tds), so changing or retiring a
 * row here never moves an invoice that has already been approved.
 */
const tdsRateSchema = new Schema(
  {
    // Upper-cased alias — invoice.entityAlias is upper-cased the same way.
    entityAlias: { type: String, required: true, trim: true, uppercase: true },
    rate: {
      type: Number,
      required: true,
      min: [0, "rate cannot be negative"],
      max: [100, "rate cannot exceed 100"],
    },
    note: { type: String, trim: true, default: "" },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

// One live rate per entity. Partial so a soft-deleted row does not block
// adding the entity again.
tdsRateSchema.index({ entityAlias: 1 }, { unique: true, partialFilterExpression: { isActive: true } });

tdsRateSchema.plugin(actorStampPlugin);

const StockTdsRateModel = mongoose.model("tdsrates", tdsRateSchema, "tdsrates");

export default StockTdsRateModel;
