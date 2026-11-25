import mongoose from "mongoose";
import {
  ITEM_STATUS_ARRAY,
  ITEM_APPROVAL_STATUS_ARRAY,
  ITEM_APPROVAL_STATUS,
  ITEM_SOURCE_ARRAY,
  ITEM_CONDITION_ARRAY,
  ITEM_CONDITION,
  REPAIR_TYPE_ARRAY,
  LOST_REASON_ARRAY,
  ITEM_LOCK_TYPE_ARRAY,
  ASSIGNEE_KIND,
  ASSIGNEE_KIND_ARRAY,
} from "../constants/stock.enums.js";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";

// Where the unit first entered the system — written once, never changed (see
// ITEM_SOURCE). `refNumber` is a snapshot so lists never need a join to show
// "INV-221" or "OS-2026-0004".
const sourceSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ITEM_SOURCE_ARRAY, default: null },
    refId: { type: mongoose.Schema.Types.ObjectId, default: null },
    refNumber: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

/*
  This unit's own warranty. Product and vendor only hold a default number of
  months; the unit needs a date, because "is it still under warranty" is asked
  of a unit, years after it arrived.

  endDate null = unknown (old stock nobody has paperwork for). startDate and
  months are kept when known, so a corrected purchase date can be recomputed.
*/
const warrantySchema = new mongoose.Schema(
  {
    startDate: { type: Date, default: null },
    months: { type: Number, default: null, min: 0 },
    endDate: { type: Date, default: null },
  },
  { _id: false }
);

/*
  Who has an ASSIGNED unit. Either a SUBSCRIBER — issued against an Item
  Request, or entered as Opening Issued Stock — or one of our own EMPLOYEES.
  Snapshots, so stock screens never need the People Directory, the website or
  HRMS to say who has it. Cleared when the unit comes back. No `kind` on older
  rows means SUBSCRIBER.
*/
const assignedToSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ASSIGNEE_KIND_ARRAY, default: ASSIGNEE_KIND.SUBSCRIBER },
    // The People Directory record the person was picked from, when they were.
    personId: { type: mongoose.Schema.Types.ObjectId, ref: "directory_people", default: null },
    phone: { type: String, trim: true, default: "" },
    // EMPLOYEE
    employeeUserId: { type: mongoose.Schema.Types.ObjectId, default: null },
    employeeName: { type: String, trim: true, default: "" },
    employeeCode: { type: String, trim: true, default: "" },
    note: { type: String, trim: true, default: "" },
    // SUBSCRIBER
    subscriberId: { type: mongoose.Schema.Types.ObjectId, ref: "subscribers", default: null },
    orderId: { type: String, trim: true, default: "" },
    username: { type: String, trim: true, default: "" },
    serviceType: { type: String, trim: true, default: "" },
    requestId: { type: mongoose.Schema.Types.ObjectId, ref: "item_requests", default: null },
    requestNumber: { type: String, trim: true, default: "" },
    assignedAt: { type: Date, default: null },
  },
  { _id: false }
);

/*
  Why a FAULTY unit is faulty — what the store wrote down when it came back
  broken. Read by the faulty-handling screens (repair / warranty claim / scrap)
  and cleared once the unit is good again.
*/
const faultSchema = new mongoose.Schema(
  {
    reportedAt: { type: Date, default: null },
    note: { type: String, trim: true, default: "" },
    // Where it was found broken — e.g. a return from subscriber ORD-101.
    via: { type: String, trim: true, default: "" },
    requestNumber: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

/*
  The repair an IN_REPAIR unit is out on: WARRANTY (the vendor it was bought
  from), PAID (any vendor) or IN_HOUSE (our own technician — no vendor).
  Cleared when it comes back; the timeline keeps the story and the costs.
*/
const repairSchema = new mongoose.Schema(
  {
    type: { type: String, enum: REPAIR_TYPE_ARRAY, default: null },
    sentAt: { type: Date, default: null },
    note: { type: String, trim: true, default: "" },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: "vendors", default: null },
    vendorName: { type: String, trim: true, default: "" },
    claimRef: { type: String, trim: true, default: "" }, // vendor's docket / RMA number
    estimatedCost: { type: Number, default: null, min: 0 }, // PAID: what it should cost
    inWarranty: { type: Boolean, default: null },            // as judged when it was sent
  },
  { _id: false }
);

/*
  Why a LOST unit is lost, and who said so. Cleared when it is found.
*/
const lostSchema = new mongoose.Schema(
  {
    reason: { type: String, enum: LOST_REASON_ARRAY, default: null },
    note: { type: String, trim: true, default: "" },
    at: { type: Date, default: null },
    // Who had it when it went missing (a copy of assignedTo's name / code).
    holder: { type: String, trim: true, default: "" },
    // The Lost Items entry that made it LOST.
    entryId: { type: mongoose.Schema.Types.ObjectId, default: null },
    entryNumber: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

/*
  Held still while a document decides this unit's fate — a pending Lost Items
  entry. A locked unit cannot be issued, assigned, transferred, repaired or
  put on a debit note; the lock comes off when the entry is approved or
  rejected.
*/
const lockSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ITEM_LOCK_TYPE_ARRAY, default: null },
    refId: { type: mongoose.Schema.Types.ObjectId, default: null },
    refNumber: { type: String, trim: true, default: "" },
    at: { type: Date, default: null },
  },
  { _id: false }
);

/*
  The transfer a unit is travelling on — set while it is IN_TRANSIT, cleared
  once the receiver accepts it or the sender takes it off a rejected transfer.
*/
const transitSchema = new mongoose.Schema(
  {
    transferId: { type: mongoose.Schema.Types.ObjectId, ref: "inventory_transfers", default: null },
    transferNumber: { type: String, trim: true, default: "" },
    toBranchId: { type: mongoose.Schema.Types.ObjectId, ref: "branches", default: null },
    sentAt: { type: Date, default: null },
    // The sender's note on this unit ("box damaged").
    note: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const stockInventoryItemSchema = new mongoose.Schema(
  {
    productDefinitionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "product_definitions", // ← was "stock_product_definitions"
      required: true,
    },
    // Optional — who the stock was received from (Section 8.4 / 9 of spec).
    // Add here now so the vendor delete-guard can be uncommented later.
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "vendors", // ← matches the vendor model's registered name
      default: null,
    },
    // Where this stock physically sits. Nullable for pre-branch-feature
    // records; the invoice-receiving flow always sets it going forward.
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "branches",
      default: null,
    },
    // Set only when this item was created by the invoice-receiving flow —
    // lets Product/Item Inventory trace an item back to the invoice/PO it
    // arrived on, and lets invoice edit/reject bulk-manage its items.
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "invoices",
      default: null,
    },
    // Partial-submit invoices: the entry (embedded in the invoice) this item
    // arrived on — entries are approved one at a time, so approval acts on it.
    invoiceEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    status: {
      type: String,
      enum: ITEM_STATUS_ARRAY,
      default: "AVAILABLE",
    },
    // Independent of `status` above. Defaults APPROVED, which is what opening
    // stock and transfer-created batches want; the invoice-receiving flow is
    // the only caller that explicitly passes PENDING, and only APPROVED items
    // count toward "available quantity".
    approvalStatus: {
      type: String,
      enum: ITEM_APPROVAL_STATUS_ARRAY,
      default: ITEM_APPROVAL_STATUS.APPROVED,
    },
    // True when this unit arrived free-of-cost on an invoice line (never
    // priced, never counted toward that line's ordered-quantity cap).
    isFoc: {
      type: Boolean,
      default: false,
    },
    source: { type: sourceSchema, default: () => ({}) },
    condition: {
      type: String,
      enum: ITEM_CONDITION_ARRAY,
      default: ITEM_CONDITION.NEW,
    },
    warranty: { type: warrantySchema, default: () => ({}) },
    // Per unit (per meter/piece for a batch). Null = not known — old stock may
    // have no paperwork. Optional for now; may become required later.
    purchaseCost: { type: Number, default: null, min: 0 },
    purchaseDate: { type: Date, default: null },
    assignedTo: { type: assignedToSchema, default: null },
    fault: { type: faultSchema, default: null },
    transit: { type: transitSchema, default: null },
    repair: { type: repairSchema, default: null },
    lost: { type: lostSchema, default: null },
    lock: { type: lockSchema, default: null },
    // A vendor swap links both ways: the faulty unit points at the unit sent
    // in its place, and that one (source VENDOR_REPLACEMENT) back at it.
    replacedByItemId: { type: mongoose.Schema.Types.ObjectId, ref: "inventory_items", default: null },
    replacesItemId: { type: mongoose.Schema.Types.ObjectId, ref: "inventory_items", default: null },
    // Why a SCRAPPED unit was written off.
    scrapNote: { type: String, trim: true, default: "" },
    fieldValues: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    /*
      Normalised "code:VALUE" keys of this unit's unique fields (serial, MAC…)
      — see StockItemIdentityService. Individual-tracked units only. Absent
      (never []) when there are none: the unique index below only covers rows
      where the field exists, and an empty array would index as a value and
      collide with every other empty one.
    */
    identifiers: { type: [String], default: undefined },
    quantity: {
      type: Number,
      default: null,
    },
    receivedAt: {
      type: Date,
      required: true,
    },
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
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

stockInventoryItemSchema.index({ productDefinitionId: 1, isActive: 1 });
stockInventoryItemSchema.index({ vendorId: 1 });
stockInventoryItemSchema.index({ status: 1 });
stockInventoryItemSchema.index({ approvalStatus: 1 });
stockInventoryItemSchema.index({ branchId: 1 });
stockInventoryItemSchema.index({ invoiceId: 1 });
stockInventoryItemSchema.index({ invoiceEntryId: 1 }, { sparse: true });
stockInventoryItemSchema.index({ "fieldValues.imei": 1 }, { sparse: true });
stockInventoryItemSchema.index({ "fieldValues.serial_no": 1 }, { sparse: true });
// The serial/MAC guarantee — one live unit per value, enforced by the database.
stockInventoryItemSchema.index(
  { identifiers: 1 },
  { unique: true, partialFilterExpression: { identifiers: { $exists: true } } }
);
stockInventoryItemSchema.index({ "source.type": 1 });
stockInventoryItemSchema.index({ "assignedTo.subscriberId": 1 }, { sparse: true });
stockInventoryItemSchema.index({ "assignedTo.requestId": 1 }, { sparse: true });
stockInventoryItemSchema.index({ "assignedTo.kind": 1, "assignedTo.employeeCode": 1 }, { sparse: true });
stockInventoryItemSchema.index({ "source.refId": 1 });
stockInventoryItemSchema.index({ "transit.transferId": 1 }, { sparse: true });

// 3rd arg pins the collection explicitly — no pluralization guessing.
// who created / last touched this — see the plugin for why it is a hook
stockInventoryItemSchema.plugin(actorStampPlugin);

const StockInventoryItemModel = mongoose.model(
  "inventory_items",
  stockInventoryItemSchema,
  "inventory_items"
);

export default StockInventoryItemModel;