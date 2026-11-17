import mongoose from "mongoose";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";
import { TRACKING_METHODS_ARRAY, UNIT_TYPES_ARRAY, TRANSFER_EVENT_ARRAY } from "../constants/stock.enums.js";

const { Schema } = mongoose;

/*
  inventory_transfers — the stock a request sent (TRF-…), one per request.

  Created when the source branch presses Send. Its stock is IN_TRANSIT on the
  sending branch until the requester presses All Received. The request owns
  the status; the transfer holds what is on it NOW (lines) and every Report
  Problem / Correct & Resend along the way (history).
*/

// One individual-tracked unit on the transfer.
const transferUnitSchema = new Schema(
  {
    inventoryItemId: { type: Schema.Types.ObjectId, ref: "inventory_items", required: true },
    // Serial / MAC at send time, so the transfer reads the same later.
    label: { type: String, trim: true, default: "" },
    // Sender's note on this unit.
    note: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

// The batch rows a quantity-tracked line travels as.
const transferBatchSchema = new Schema(
  {
    inventoryItemId: { type: Schema.Types.ObjectId, ref: "inventory_items", required: true },
    quantity: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const transferLineSchema = new Schema(
  {
    productDefinitionId: { type: Schema.Types.ObjectId, ref: "product_definitions", required: true },
    productName: { type: String, trim: true, default: "" },
    trackingMethod: { type: String, enum: TRACKING_METHODS_ARRAY, required: true },
    unit: { type: String, enum: UNIT_TYPES_ARRAY, default: null },
    // The request line (a category) this fills.
    requestLineId: { type: Schema.Types.ObjectId, default: null },
    sentQty: { type: Number, required: true, min: 0 },
    units: { type: [transferUnitSchema], default: [] },
    batches: { type: [transferBatchSchema], default: [] },
  },
  { _id: true }
);

// What Correct & Resend took off — read-only, for the history.
const removedSchema = new Schema(
  {
    productName: { type: String, trim: true, default: "" },
    unit: { type: String, enum: UNIT_TYPES_ARRAY, default: null },
    quantity: { type: Number, default: 0, min: 0 },
    // Individual: the serial / MAC of each unit taken off.
    labels: { type: [String], default: [] },
  },
  { _id: false }
);

// One Report Problem (requester) or Correct & Resend (sender).
const transferEventSchema = new Schema(
  {
    type: { type: String, enum: TRANSFER_EVENT_ARRAY, required: true },
    note: { type: String, trim: true, default: "" },
    removed: { type: [removedSchema], default: [] },
    by: { type: Schema.Types.ObjectId, default: null },
    byName: { type: String, trim: true, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const transferSchema = new Schema(
  {
    transferNumber: { type: String, trim: true, uppercase: true, required: true },

    fromBranchId: { type: Schema.Types.ObjectId, ref: "branches", required: true },
    toBranchId: { type: Schema.Types.ObjectId, ref: "branches", required: true },

    requestId: { type: Schema.Types.ObjectId, ref: "inventory_transfer_requests", required: true },
    requestNumber: { type: String, trim: true, default: "" },

    lines: { type: [transferLineSchema], default: [] },

    note: { type: String, trim: true, default: "" },
    sentBy: { type: Schema.Types.ObjectId, default: null },
    sentByName: { type: String, trim: true, default: "" },
    sentAt: { type: Date, default: Date.now },

    // The latest Report Problem note — what the sender has to fix while the
    // request MISMATCH; cleared on Correct & Resend.
    problemNote: { type: String, trim: true, default: "" },
    history: { type: [transferEventSchema], default: [] },

    receivedBy: { type: Schema.Types.ObjectId, default: null },
    receivedByName: { type: String, trim: true, default: "" },
    receivedAt: { type: Date, default: null },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

transferSchema.index({ transferNumber: 1 }, { unique: true });
transferSchema.index({ requestId: 1 });

transferSchema.plugin(actorStampPlugin);

const StockTransferModel = mongoose.model("inventory_transfers", transferSchema, "inventory_transfers");

export default StockTransferModel;
