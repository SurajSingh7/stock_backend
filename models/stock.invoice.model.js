import mongoose from "mongoose";
import {
  INVOICE_STATUS,
  INVOICE_STATUS_ARRAY,
  INVOICE_ENTRY_STATUS,
  INVOICE_ENTRY_STATUS_ARRAY,
  PAYMENT_APPROVAL_STATUS_ARRAY,
  PAYMENT_MODE_ARRAY,
  PAYMENT_STATE_OVERRIDE_ARRAY,
} from "../constants/stock.enums.js";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";

const { Schema } = mongoose;

const extraChargeSchema = new Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    note: { type: String, trim: true, default: "" },
    // false = recorded on the invoice as a note only (e.g. transport paid to
    // someone else in cash) — never added to `amount`, so it stays out of
    // billing, the vendor ledger, outstanding and payments. Defaults true so
    // charges saved before this flag existed keep billing exactly as before.
    includeInBilling: { type: Boolean, default: true },
  },
  { timestamps: false }
);

const ratingSchema = new Schema(
  {
    rating: { type: Number, min: 0, max: 5, default: null },
    notes: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

// One line = one PO line item (product) this invoice is receiving against.
// `quotationItemId` is the stable correlation key the PO copied from the
// quotation — used to sum received quantity per product across invoices.
const invoiceLineSchema = new Schema(
  {
    quotationItemId: { type: Schema.Types.ObjectId, default: null },
    categoryId: { type: Schema.Types.ObjectId, ref: "categories", default: null },
    categoryName: { type: String, trim: true, default: "" },
    productDefinitionId: {
      type: Schema.Types.ObjectId,
      ref: "product_definitions",
      default: null,
    },
    productName: { type: String, trim: true, default: "" },

    // Snapshotted from the PO line at invoice-create time — never re-read
    // from the PO later, same immutable-snapshot convention as everywhere else.
    unitPrice: { type: Number, default: 0 },

    // How many the vendor's invoice says — set when the invoice is added.
    // Items can only be submitted once receivedQuantity has reached it.
    invoiceQuantity: { type: Number, default: 0, min: 0 },

    // How many have been entered (serial rows / batch quantity) so far.
    // With partial submit ON this is the APPROVED total instead — the units
    // being typed in live on the invoice's draft entry (see `entries`).
    receivedQuantity: { type: Number, default: 0, min: 0 },

    // Free-of-cost units received alongside the paid receivedQuantity —
    // never counted against the PO line's ordered quantity (that guard only
    // ever looks at receivedQuantity) and never priced into `amount`.
    focQuantity: { type: Number, default: 0, min: 0 },

    // One entry per generated Serial/MAC row (individual-tracked products
    // only; empty for quantity-tracked products, which just set
    // receivedQuantity/focQuantity directly). `isFoc` splits paid vs free
    // rows within the same array so the UI/order stays stable.
    rows: {
      type: [{ fieldValues: Schema.Types.Mixed, isFoc: { type: Boolean, default: false } }],
      default: [],
    },

    createdInventoryItemIds: { type: [Schema.Types.ObjectId], ref: "inventory_items", default: [] },

    rating: { type: ratingSchema, default: null },
  },
  { _id: true }
);

/*
  One entry of a partial-submit invoice: what was entered and submitted in one
  go ("20 routers today"), approved or rejected on its own. Embedded — an
  entry only ever exists inside its invoice.
*/
const entryLineSchema = new Schema(
  {
    quotationItemId: { type: Schema.Types.ObjectId, default: null },
    productDefinitionId: { type: Schema.Types.ObjectId, ref: "product_definitions", default: null },
    productName: { type: String, trim: true, default: "" },
    receivedQuantity: { type: Number, default: 0, min: 0 },
    focQuantity: { type: Number, default: 0, min: 0 },
    rows: {
      type: [{ fieldValues: Schema.Types.Mixed, isFoc: { type: Boolean, default: false } }],
      default: [],
    },
    createdInventoryItemIds: { type: [Schema.Types.ObjectId], ref: "inventory_items", default: [] },
  },
  { _id: false }
);

const invoiceEntrySchema = new Schema(
  {
    entryNumber: { type: Number, required: true, min: 1 },
    status: { type: String, enum: INVOICE_ENTRY_STATUS_ARRAY, default: INVOICE_ENTRY_STATUS.DRAFT },
    lines: { type: [entryLineSchema], default: [] },
    submittedAt: { type: Date, default: null },
    submittedByName: { type: String, trim: true, default: "" },
    rejectedReason: { type: String, trim: true, default: "" },
    reviewedBy: { type: Schema.Types.ObjectId, default: null },
    reviewedByName: { type: String, trim: true, default: "" },
    reviewedAt: { type: Date, default: null },
  },
  { _id: true, timestamps: true }
);

const invoiceSchema = new Schema(
  {
    trackingOrderId: { type: Schema.Types.ObjectId, ref: "tracking_orders", required: true },
    poId: { type: Schema.Types.ObjectId, ref: "purchase_orders", default: null },

    // Copied from the tracking order at create time purely so this collection
    // can be entity-scoped without joining tracking_orders on every list read.
    // Only the alias — the full buyerEntity snapshot already lives on the
    // tracking order and the PO, and nothing here displays it.
    entityAlias: { type: String, trim: true, uppercase: true, default: "" },

    vendorId: { type: Schema.Types.ObjectId, ref: "vendors", default: null },
    vendorName: { type: String, trim: true, default: "" },

    invoiceNumber: { type: String, trim: true, required: true },
    // invoiceNumber upper-cased with spaces removed — "inv-01" and "INV 01"
    // are the same bill. Only ever compared, never shown.
    invoiceNumberKey: { type: String, trim: true, default: "" },
    // "2026-27" (April–March) of invoiceDate. The duplicate rule is one
    // vendor, one invoice number, once per financial year.
    financialYear: { type: String, trim: true, default: "" },
    invoiceDate: { type: Date, required: true },
    invoiceFile: { type: String, trim: true, default: "" }, // relative public path

    branchId: { type: Schema.Types.ObjectId, ref: "branches", default: null },

    // String snapshot (no real user-linking system on the frontend yet) —
    // same convention as createdByName/reviewedByName elsewhere.
    receivedByName: { type: String, trim: true, default: "" },

    // Free-text remarks from whoever received the goods.
    notes: { type: String, trim: true, default: "" },

    extraCharges: { type: [extraChargeSchema], default: [] },
    lines: { type: [invoiceLineSchema], default: [] },

    // Server-computed: sum(receivedQuantity*unitPrice) + sum(billed extraCharges.amount)
    amount: { type: Number, default: 0 },

    // The total as written on the vendor's invoice (filled from the upload,
    // corrected by hand). Shown beside the computed amount so a mismatch is
    // visible; the ledger still runs on the computed one.
    invoiceAmount: { type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: INVOICE_STATUS_ARRAY,
      default: INVOICE_STATUS.ADDED,
    },

    /*
      Partial submit (turned on per invoice, by permission): items can be
      submitted a part at a time, each part an entry approved on its own.
      Off by default — then the invoice is submitted once, complete.
    */
    partialSubmit: { type: Boolean, default: false },
    entries: { type: [invoiceEntrySchema], default: [] },

    /*
      The invoice counts in the vendor ledger / outstanding / payments list.
      Set when it is approved — or, with partial submit, when its FIRST entry
      is approved (the whole invoice amount counts from then on). Payment
      itself still waits for status APPROVED.
    */
    inLedger: { type: Boolean, default: false },

    /*
      TDS, snapshotted the moment the invoice first enters the ledger (approval,
      or with partial submit its first approved entry) from Master > TDS Rates
      for entityAlias. Only the RATE is stored; the amount is rate × basic,
      worked out on read, so an admin correcting a price moves it too. Null on
      invoices approved before TDS existed — those carry no TDS.
    */
    tds: {
      type: new Schema(
        {
          rate: { type: Number, default: 0, min: 0 },
          entityAlias: { type: String, trim: true, default: "" },
          note: { type: String, trim: true, default: "" },
          appliedAt: { type: Date, default: null },
        },
        { _id: false }
      ),
      default: null,
    },

    /*
      Who entered what, and when — one row per "Save as Draft" / "Submit".
      Several people can carry the same invoice forward, so this is how
      "who put in the first 20 routers" stays answerable.
    */
    entryLog: {
      type: [
        new Schema(
          {
            at: { type: Date, default: null },
            by: { type: Schema.Types.ObjectId, default: null },
            byName: { type: String, trim: true, default: "" },
            action: { type: String, enum: ["DRAFT", "SUBMIT"], default: "DRAFT" },
            // Partial submit: which entry this save belonged to.
            entryNumber: { type: Number, default: null },
            // Change in entered quantity per product on this save (+20, +30 …)
            items: {
              type: [
                new Schema(
                  {
                    productName: { type: String, trim: true, default: "" },
                    quantity: { type: Number, default: 0 },
                    focQuantity: { type: Number, default: 0 },
                  },
                  { _id: false }
                ),
              ],
              default: [],
            },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    // Every change made through "Edit invoice": who, when, field before/after.
    editHistory: {
      type: [
        new Schema(
          {
            at: { type: Date, default: null },
            by: { type: Schema.Types.ObjectId, default: null },
            byName: { type: String, trim: true, default: "" },
            changes: {
              type: [
                new Schema(
                  {
                    field: { type: String, trim: true, default: "" },
                    from: { type: Schema.Types.Mixed, default: null },
                    to: { type: Schema.Types.Mixed, default: null },
                  },
                  { _id: false }
                ),
              ],
              default: [],
            },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    rejectedReason: { type: String, trim: true, default: "" },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "users", default: null },
    reviewedByName: { type: String, trim: true, default: "" },
    reviewedAt: { type: Date, default: null },

    /*
      ── Payment side ──────────────────────────────────────────────────────
      Everything below belongs to the payment lifecycle, which is separate
      from `status` above: that one says whether the goods were accepted,
      these say whether they have been paid for.

      Embedded rather than given its own collection because one invoice has
      exactly one payment journey, and every screen that shows the journey is
      already looking at the invoice.
    */

    /*
      When WE decided to pay this, when that is not simply when it falls due.

      The due date itself is never stored: it is invoiceDate + the term's days,
      fixed by the contract, and it is what the vendor's own books say. This
      field overrides only when the invoice enters the account team's payable
      queue — earlier when a vendor asks to be paid ahead of terms, later when
      the money is not there yet.

          Net 90, billed 1 Aug   ->  due 30 Oct, always
          scheduled 25 Aug        ->  payable from 25 Aug   (early)
          scheduled 9 Nov         ->  payable from 9 Nov    (deferred)

      Null means "on the due date", which is the normal case — so an invoice
      nobody has touched behaves exactly as the terms say without anything
      being written here.

      Locked once the invoice is payable and once an approval has been asked
      for: after either, moving it would pull work out from under somebody.
    */
    paymentScheduledOn: { type: Date, default: null },

    /*
      Every change to that date. An array, not a "changedAt" stamp, because
      this field decides when money leaves — "who moved this, and to what"
      has to stay answerable however many times it moves.
    */
    paymentScheduleHistory: {
      type: [
        new Schema(
          {
            from: { type: Date, default: null },
            to: { type: Date, default: null },
            by: { type: Schema.Types.ObjectId, default: null },
            byName: { type: String, trim: true, default: "" },
            at: { type: Date, default: null },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    /*
      Whether this invoice has been cleared to pay — and ONLY that.

      How much has been paid is a separate question, answered by summing
      `payments` below, and "not due"/"due" is a third, worked out from
      invoiceDate + termDays. Keeping all three apart is what lets the
      Payments screen show "Approved" and "Partly paid" at the same time;
      one combined field could only ever say one of them.

      Null until somebody asks for approval.
    */
    paymentApprovalStatus: {
      type: String,
      enum: [...PAYMENT_APPROVAL_STATUS_ARRAY, null],
      default: null,
    },

    /*
      The approval round trip: accounts ask, the approval team decides.

      One object, not an array, because only one request is ever open. A
      rejection leaves paymentApprovalStatus on REJECTED rather than clearing
      it — "was sent back, and why" is a different fact from "has never been
      sent", and the Payments screen shows both differently. rejectedReason is
      what the next attempt has to answer, so it is kept until that next
      request overwrites it.
    */
    paymentApproval: {
      type: new Schema(
        {
          sentBy: { type: Schema.Types.ObjectId, default: null },
          sentByName: { type: String, trim: true, default: "" },
          sentAt: { type: Date, default: null },
          // The payable AS SENT. The approval team agreed to a number, and
          // that number has to stay readable even though adjustments could
          // later change what is computed.
          payableAtRequest: { type: Number, default: 0 },
          reviewedBy: { type: Schema.Types.ObjectId, default: null },
          reviewedByName: { type: String, trim: true, default: "" },
          reviewedAt: { type: Date, default: null },
          rejectedReason: { type: String, trim: true, default: "" },
        },
        { _id: false }
      ),
      default: null,
    },

    /*
      Overriding what the amounts say the state is.

      Normally "paid" or "partly paid" is simply paidTotal against payable, and
      needs no field. But a real settlement breaks that arithmetic: the vendor
      agrees to take 44,000 on a 45,000 invoice, so it is PAID with 1,000 still
      outstanding. That is a decision, not a sum, and only a stored value can
      carry it.

      Null means "whatever the amounts say", which is the normal case.

      The reason is not optional when this is set. Somebody will ask why an
      invoice closed 1,000 short, and the answer has to be here rather than in
      whoever remembers the phone call.
    */
    paymentStateOverride: {
      type: String,
      enum: [...PAYMENT_STATE_OVERRIDE_ARRAY, null],
      default: null,
    },
    paymentOverrideReason: { type: String, trim: true, default: "" },
    paymentOverrideByName: { type: String, trim: true, default: "" },
    paymentOverrideAt: { type: Date, default: null },

    /*
      What has actually been paid. An ARRAY because a bill can be settled in
      instalments, and because ONE settlement can arrive down several routes —
      30,000 by NEFT and 15,000 by UPI on the same day are two bank entries
      with two references and two receipts, so they are two rows here.

      A single paidAmount would lose all of that, and turning it into an array
      later would mean migrating every paid invoice.

      paidTotal is never stored: it is the sum of these, worked out on read,
      so it cannot drift away from the rows it is meant to total.
    */
    payments: {
      type: [
        new Schema(
          {
            amount: { type: Number, required: true, min: 0 },
            mode: { type: String, enum: PAYMENT_MODE_ARRAY, required: true },
            paidOn: { type: Date, required: true },
            refNo: { type: String, trim: true, default: "" },
            remarks: { type: String, trim: true, default: "" },
            // Relative public paths, same convention as invoiceFile above.
            // An array because one payment can need more than one proof —
            // a cheque photo and the bank slip for the same transfer.
            proofs: { type: [String], default: [] },
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
  },
  { timestamps: true }
);

invoiceSchema.index({ trackingOrderId: 1, status: 1 });
invoiceSchema.index({ poId: 1 });
invoiceSchema.index({ vendorId: 1 });
invoiceSchema.index({ status: 1, isActive: 1 });
// The Invoice List reads approved invoices ordered by when payment is due.
invoiceSchema.index({ status: 1, isActive: 1, paymentScheduledOn: 1 });
// Duplicate-invoice backstop — the service checks first for a readable message.
invoiceSchema.index(
  { vendorId: 1, invoiceNumberKey: 1, financialYear: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);


// who created / last touched this — see the plugin for why it is a hook
invoiceSchema.plugin(actorStampPlugin);

const StockInvoiceModel = mongoose.model("invoices", invoiceSchema, "invoices");

export default StockInvoiceModel;
