import mongoose from "mongoose";
import { actorStampPlugin, actorSchema } from "./plugins/actor.stamp.plugin.js";
import {
  TRACKING_METHODS_ARRAY,
  UNIT_TYPES_ARRAY,
  ITEM_STATUS_ARRAY,
  ASSIGNEE_KIND_ARRAY,
  LOST_REASON_ARRAY,
  LOST_ENTRY_TYPE_ARRAY,
  LOST_ENTRY_STATUS,
  LOST_ENTRY_STATUS_ARRAY,
  WORKING_STATE_ARRAY,
} from "../constants/stock.enums.js";

const { Schema } = mongoose;

/*
  Lost Items / Dead Items (type DEAD) share this document and its flow.

  Lost Items — one entry reports units LOST (from the store, a subscriber or
  an employee), or brings lost units back as FOUND. Every entry waits for
  approval; nothing happens to stock until it is APPROVED.

    PENDING ──approve──► APPROVED   (units → LOST, or back to stock)
       │
       └──reject (reason)──► REJECTED ──edit + resend (creator)──► PENDING

  While PENDING, every individual unit on it carries a lock (see the item's
  `lock`), so it cannot be issued, moved or repaired in the meantime. A batch
  line names where the quantity is (store / a subscriber's share / an
  employee's share) and is drawn when approved.
*/

// Who had it when it went missing — a snapshot, readable after they change.
const holderSchema = new Schema(
  {
    kind: { type: String, enum: [...ASSIGNEE_KIND_ARRAY, "STORE"], default: "STORE" },
    name: { type: String, trim: true, default: "" },     // subscriber username / employee name
    code: { type: String, trim: true, default: "" },     // employee code
    orderId: { type: String, trim: true, default: "" },
    requestNumber: { type: String, trim: true, default: "" },
    subscriberId: { type: Schema.Types.ObjectId, default: null },
  },
  { _id: false }
);

const lostLineSchema = new Schema({
  productDefinitionId: { type: Schema.Types.ObjectId, ref: "product_definitions", required: true },
  productName: { type: String, trim: true, default: "" },
  trackingMethod: { type: String, enum: TRACKING_METHODS_ARRAY, required: true },
  unit: { type: String, enum: UNIT_TYPES_ARRAY, default: null },

  // Individual: the unit itself. Batch: null — `source` + `quantity` say what.
  inventoryItemId: { type: Schema.Types.ObjectId, ref: "inventory_items", default: null },
  label: { type: String, trim: true, default: "" }, // serial / MAC, for reading
  quantity: { type: Number, default: null, min: 0 }, // batch only

  // Where it was when reported (LOST), as the entry was made.
  fromStatus: { type: String, enum: ITEM_STATUS_ARRAY, default: null },
  holder: { type: holderSchema, default: () => ({}) },
  reason: { type: String, enum: LOST_REASON_ARRAY, default: null },

  // FOUND only: how it turned up, and which Lost entry it was on.
  foundState: { type: String, enum: [...WORKING_STATE_ARRAY, null], default: null },
  foundNote: { type: String, trim: true, default: "" },
  lostEntryNumber: { type: String, trim: true, default: "" },

  // DEAD only: why this unit is dead (the entry's note covers the rest).
  deadNote: { type: String, trim: true, default: "" },
});

const historySchema = new Schema(
  {
    action: { type: String, enum: ["CREATED", "RESUBMITTED", "APPROVED", "REJECTED"], required: true },
    at: { type: Date, default: Date.now },
    by: { type: actorSchema, default: null },
    note: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const lostEntrySchema = new Schema(
  {
    entryNumber: { type: String, required: true, unique: true, trim: true },
    type: { type: String, enum: LOST_ENTRY_TYPE_ARRAY, required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "branches", required: true },
    note: { type: String, trim: true, default: "" },
    lines: { type: [lostLineSchema], default: [] },
    status: { type: String, enum: LOST_ENTRY_STATUS_ARRAY, default: LOST_ENTRY_STATUS.PENDING },

    submittedAt: { type: Date, default: null },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: actorSchema, default: null },
    rejectReason: { type: String, trim: true, default: "" },
    history: { type: [historySchema], default: [] },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

lostEntrySchema.plugin(actorStampPlugin);
lostEntrySchema.index({ status: 1, createdAt: -1 });
lostEntrySchema.index({ branchId: 1, status: 1 });
lostEntrySchema.index({ "lines.inventoryItemId": 1 });

const StockLostEntryModel = mongoose.model("lost_entries", lostEntrySchema, "lost_entries");
export default StockLostEntryModel;
