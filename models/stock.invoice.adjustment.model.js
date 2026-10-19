import mongoose from "mongoose";
import {
  ADJUSTMENT_TYPE,
  ADJUSTMENT_TYPE_ARRAY,
  ADJUSTMENT_DIRECTION_ARRAY,
  DEBIT_NOTE_STATUS_ARRAY,
} from "../constants/stock.enums.js";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";

const { Schema } = mongoose;

/*
  One line of a debit note: which product, which units, and what that comes
  to. The rate is SNAPSHOTTED from the invoice line, not read live from the
  purchase order — a debit note is a claim about a specific delivery at the
  price it was billed at, and that must not move afterwards.

  inventoryItemIds is filled for individual-tracked products (the exact units
  claimed against) and empty for quantity-tracked ones, where a batch has no
  per-unit identity and only the quantity is meaningful.
*/
const adjustmentLineSchema = new Schema(
  {
    productDefinitionId: { type: Schema.Types.ObjectId, ref: "product_definitions", default: null },
    productName: { type: String, trim: true, default: "" },
    quotationItemId: { type: Schema.Types.ObjectId, default: null },
    inventoryItemIds: { type: [Schema.Types.ObjectId], default: [] },

    /*
      For a GROUP line: exactly which batch documents this note drew from, and
      how much from each.

      Without it an edit could not be undone honestly. A group line only knows
      it took "3 meter"; put those 3 back into whichever batch happens to be
      first and the quantity is right while the DELIVERY it belongs to is
      wrong — and a batch this note emptied would stay marked faulty forever.

      Empty for individual lines, where inventoryItemIds already names the
      exact units.
    */
    batchDraws: {
      type: [
        new Schema(
          {
            inventoryItemId: { type: Schema.Types.ObjectId, required: true },
            quantity: { type: Number, default: 0, min: 0 },
            // True when this note took the batch to zero and marked it FAULTY,
            // so undoing knows to set it back to AVAILABLE as well as refill it.
            zeroedOut: { type: Boolean, default: false },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    quantity: { type: Number, default: 0, min: 0 },
    rate: { type: Number, default: 0, min: 0 },

    /*
      A debit note carries GST, exactly as the invoice did.

      The invoice was billed at basic + GST and the payable is the GRAND total,
      so claiming back only the basic under-claims by the whole tax. Return
      3 pieces at 500 with 18% GST and the debit note is for 1,770, not 1,500 —
      settle it at 1,500 and the ledger never reconciles.

      All three are stored rather than derived at read time: the rate can be
      retired and the slab changed years later, and this row has to keep saying
      what was actually debited on the day.
    */
    gstRate: { type: Number, default: 0, min: 0 },
    basicAmount: { type: Number, default: 0, min: 0 },
    gstAmount: { type: Number, default: 0, min: 0 },
    // basicAmount + gstAmount. The number that moves the payable.
    amount: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

/*
  A free row with its own amount — the vendor knocking something off at the
  last moment, transport damage, a handling charge.

  Same {note, amount} shape as the invoice's own extraCharges, but NOT the
  same meaning: there they push the invoice total up, here they follow the
  adjustment's direction. The screens call these "Other deductions" on a
  debit note for exactly that reason — reusing the words "extra charges"
  would have the label saying the opposite of what the row does.
*/
const adjustmentExtraSchema = new Schema(
  {
    note: { type: String, trim: true, default: "" },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

/*
  ── Invoice adjustment ────────────────────────────────────────────────────
  Anything that changes what is actually payable on an approved invoice.

  Its own collection rather than arrays on the invoice, because the kinds of
  adjustment are expected to keep growing: a new kind is a new `type` value
  here, not a new array and a new set of totals everywhere that reads them.

  NOT registered in config/data.scope.registry.js, on purpose. Every read and
  write reaches an adjustment THROUGH its invoice, which is already scoped —
  so the invoice is the single authority on who may see it. Registering this
  collection separately would mean maintaining a second, parallel answer to
  the same question, and the two would eventually disagree.
*/
const invoiceAdjustmentSchema = new Schema(
  {
    invoiceId: { type: Schema.Types.ObjectId, ref: "invoices", required: true },
    // Denormalised for listing and reporting without a join. The invoice
    // remains the scope authority — these are for display and filtering.
    vendorId: { type: Schema.Types.ObjectId, ref: "vendors", default: null },
    vendorName: { type: String, trim: true, default: "" },
    branchId: { type: Schema.Types.ObjectId, ref: "branches", default: null },
    invoiceNumber: { type: String, trim: true, default: "" },

    type: { type: String, enum: ADJUSTMENT_TYPE_ARRAY, required: true },
    direction: { type: String, enum: ADJUSTMENT_DIRECTION_ARRAY, required: true },

    lines: { type: [adjustmentLineSchema], default: [] },
    extras: { type: [adjustmentExtraSchema], default: [] },

    // All server-computed from lines/extras — never taken from the client, so
    // a screen cannot disagree with the database about the money.
    //
    // The basic/GST split is kept at this level too, because the vendor ledger
    // shows debit notes in a GST column of their own and should not have to
    // re-add the lines to find it.
    itemsBasicAmount: { type: Number, default: 0, min: 0 },
    itemsGstAmount: { type: Number, default: 0, min: 0 },
    itemsAmount: { type: Number, default: 0, min: 0 },
    /*
      Free rows carry NO GST, deliberately.

      They are ad-hoc value adjustments — a discount the vendor allowed at the
      last moment, a transport claim — not a supply of anything, so there is no
      slab that belongs to them. Someone entering one types the figure they
      actually agreed with the vendor.
    */
    extrasAmount: { type: Number, default: 0, min: 0 },
    amount: { type: Number, default: 0, min: 0 },

    reason: { type: String, trim: true, default: "" },

    /*
      Debit notes only (null on misc, and on debit notes that predate the
      chain — those count as approved). See DEBIT_NOTE_STATUS for the flow.
    */
    status: { type: String, enum: [...DEBIT_NOTE_STATUS_ARRAY, null], default: null },
    // DN-1, DN-2 … per invoice, so "the second one" is something people can say.
    dnNumber: { type: Number, default: null },
    /*
      Every step of the chain: raised, resubmitted (with what changed), review
      rejected / sent, approved / rejected, withdrawn — who, when, why.
    */
    history: {
      type: [
        new Schema(
          {
            at: { type: Date, default: null },
            by: { type: Schema.Types.ObjectId, default: null },
            byName: { type: String, trim: true, default: "" },
            action: { type: String, trim: true, default: "" },
            note: { type: String, trim: true, default: "" },
            fromAmount: { type: Number, default: null },
            toAmount: { type: Number, default: null },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    /*
      Misc charges are accounts' own and in force at once, so they carry no
      status. Withdrawing one is a soft delete, which isActive already says.
    */
    createdByName: { type: String, trim: true, default: "" },
    createdOn: { type: Date, default: null },

    // Every edit, because editing one moves both money and stock.
    edits: {
      type: [
        new Schema(
          {
            fromAmount: { type: Number, default: 0 },
            toAmount: { type: Number, default: 0 },
            reason: { type: String, trim: true, default: "" },
            by: { type: Schema.Types.ObjectId, default: null },
            byName: { type: String, trim: true, default: "" },
            at: { type: Date, default: null },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedByName: { type: String, trim: true, default: "" },
    deletedReason: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

// Every screen starts from an invoice and asks the same thing: what is on it.
invoiceAdjustmentSchema.index({ invoiceId: 1, isActive: 1 });
invoiceAdjustmentSchema.index({ vendorId: 1, isActive: 1 });
invoiceAdjustmentSchema.index({ type: 1, status: 1, isActive: 1 });

invoiceAdjustmentSchema.plugin(actorStampPlugin);

const StockInvoiceAdjustmentModel = mongoose.model(
  "invoice_adjustments",
  invoiceAdjustmentSchema,
  "invoice_adjustments"
);

export default StockInvoiceAdjustmentModel;
export { ADJUSTMENT_TYPE };
