import mongoose from "mongoose";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";
import {
  TRACKING_METHODS_ARRAY,
  UNIT_TYPES_ARRAY,
  ITEM_REQUEST_TYPE,
  ITEM_REQUEST_TYPE_ARRAY,
  ITEM_REQUEST_STATUS,
  ITEM_REQUEST_STATUS_ARRAY,
  ITEM_REQUEST_CHANNEL_ARRAY,
  RETURN_CONDITION_ARRAY,
} from "../constants/stock.enums.js";

const { Schema } = mongoose;

/*
  item_requests — a subscriber's request for stock, raised on the NOC /
  broadband website (or the test simulator) and fulfilled here by the store,
  possibly over several visits ("2 today, 3 later").

  The requester asks for a CATEGORY and a quantity ("5 × Wireless ONT / Single
  Band"), never a product: which product goes out is the store's call, and one
  request may be filled from several products of that category. The request
  never changes once sent, except by the requester resending a REJECTED one.
  What the store has handed over is `issues` — one entry per visit, naming each
  product and unit — and issuedQty is their sum.
*/

const personSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, default: null },
    employeeCode: { type: String, trim: true, default: "" },
    name: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

// One product's share of a handover. `units` names each unit given (by its
// serial/MAC, snapshotted so the record still reads after the unit moves on);
// a batch product records the documents it drew from instead.
const issueLineSchema = new Schema(
  {
    productDefinitionId: { type: Schema.Types.ObjectId, ref: "product_definitions", default: null },
    productName: { type: String, trim: true, default: "" },
    quantity: { type: Number, required: true, min: 0 },
    units: {
      type: [
        new Schema(
          {
            inventoryItemId: { type: Schema.Types.ObjectId, ref: "inventory_items", required: true },
            label: { type: String, trim: true, default: "" },
            quantity: { type: Number, default: null },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { _id: false }
);

const issueSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: personSchema, default: () => ({}) },
    lines: { type: [issueLineSchema], default: [] },
  },
  { _id: true }
);

/*
  RETURN / REPLACE: one thing the subscriber is giving back — a unit, or a
  quantity off one of the batches they hold. Named by the requester from what
  the subscriber holds; received by the store, possibly a bit at a time.
*/
const returnLineSchema = new Schema(
  {
    // The ASSIGNED unit / batch with the subscriber.
    inventoryItemId: { type: Schema.Types.ObjectId, ref: "inventory_items", required: true },
    productDefinitionId: { type: Schema.Types.ObjectId, ref: "product_definitions", required: true },
    productName: { type: String, trim: true, default: "" },
    categoryId: { type: Schema.Types.ObjectId, ref: "categories", default: null },
    trackingMethod: { type: String, enum: TRACKING_METHODS_ARRAY, required: true },
    unit: { type: String, enum: UNIT_TYPES_ARRAY, default: null },
    label: { type: String, trim: true, default: "" },
    requestedQty: { type: Number, required: true, min: 0 },
    receivedQty: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

// One visit's worth of things coming back, each with the condition it came
// back in. `inventoryItemId` is where the returned stock now is — the same
// unit, or (for part of a batch) the new batch split off for it.
const receiptSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: personSchema, default: () => ({}) },
    lines: {
      type: [
        new Schema(
          {
            returnLineId: { type: Schema.Types.ObjectId, required: true },
            productName: { type: String, trim: true, default: "" },
            label: { type: String, trim: true, default: "" },
            quantity: { type: Number, required: true, min: 0 },
            condition: { type: String, enum: RETURN_CONDITION_ARRAY, required: true },
            note: { type: String, trim: true, default: "" },
            inventoryItemId: { type: Schema.Types.ObjectId, ref: "inventory_items", default: null },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { _id: true }
);

// What happened to the request, newest last — shown as its own timeline.
const historySchema = new Schema(
  {
    action: { type: String, trim: true, required: true }, // CREATED, ISSUED, RECEIVED, REJECTED, RESENT, SHORT_CLOSED, COMPLETED
    at: { type: Date, default: Date.now },
    byName: { type: String, trim: true, default: "" },
    note: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const decisionSchema = new Schema(
  {
    reason: { type: String, trim: true, default: "" },
    by: { type: personSchema, default: () => ({}) },
    at: { type: Date, default: null },
  },
  { _id: false }
);

const itemRequestSchema = new Schema(
  {
    requestNumber: { type: String, trim: true, uppercase: true, required: true },
    type: { type: String, enum: ITEM_REQUEST_TYPE_ARRAY, default: ITEM_REQUEST_TYPE.ISSUE },
    status: { type: String, enum: ITEM_REQUEST_STATUS_ARRAY, default: ITEM_REQUEST_STATUS.PENDING },
    channel: { type: String, enum: ITEM_REQUEST_CHANNEL_ARRAY, required: true },

    // Chosen by the requester; only this branch's stock can be issued.
    branchId: { type: Schema.Types.ObjectId, ref: "branches", required: true },

    subscriberId: { type: Schema.Types.ObjectId, ref: "subscribers", required: true },
    // As it was when the request was (re)sent.
    subscriber: {
      type: new Schema(
        {
          orderId: { type: String, trim: true, default: "" },
          username: { type: String, trim: true, default: "" },
          serviceType: { type: String, trim: true, default: "" },
          extraFields: { type: Schema.Types.Mixed, default: {} },
        },
        { _id: false }
      ),
      default: () => ({}),
    },

    /*
      The OUTGOING half — ISSUE, and the new units of a REPLACE. One LEAF
      category. Required by the service for those types, not by the schema,
      because a plain RETURN has no outgoing half at all.
    */
    categoryId: { type: Schema.Types.ObjectId, ref: "categories", default: null },
    categoryPath: { type: String, trim: true, default: "" },
    // What a quantity of this category means: units (individual products) or
    // metres/pieces off batches. Every active product of the category shares
    // both, or the category cannot be requested at all (see _categoryKind).
    trackingMethod: { type: String, enum: TRACKING_METHODS_ARRAY, default: null },
    unit: { type: String, enum: UNIT_TYPES_ARRAY, default: null },
    requestedQty: { type: Number, default: 0, min: 0 },
    issuedQty: { type: Number, default: 0, min: 0 },

    // The INCOMING half — RETURN, and the old units of a REPLACE.
    returnLines: { type: [returnLineSchema], default: [] },
    returnRequestedQty: { type: Number, default: 0, min: 0 },
    returnReceivedQty: { type: Number, default: 0, min: 0 },
    receipts: { type: [receiptSchema], default: [] },

    // The person on the requesting website — not an HRMS user.
    requestedBy: {
      type: new Schema(
        {
          externalUserId: { type: String, trim: true, default: "" },
          name: { type: String, trim: true, default: "" },
        },
        { _id: false }
      ),
      default: () => ({}),
    },
    remarks: { type: String, trim: true, default: "" },

    issues: { type: [issueSchema], default: [] },
    rejection: { type: decisionSchema, default: null },
    closure: { type: decisionSchema, default: null },
    // 1 when first sent; +1 each time a rejected request is resent.
    revision: { type: Number, default: 1 },
    history: { type: [historySchema], default: [] },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

itemRequestSchema.index({ requestNumber: 1 }, { unique: true });
itemRequestSchema.index({ branchId: 1, status: 1 });
itemRequestSchema.index({ subscriberId: 1, createdAt: -1 });
itemRequestSchema.index({ channel: 1, status: 1 });
itemRequestSchema.index({ createdAt: -1 });
// "Is this unit already on an open return?" — checked on every return/replace.
itemRequestSchema.index({ "returnLines.inventoryItemId": 1 });

itemRequestSchema.plugin(actorStampPlugin);

const StockItemRequestModel = mongoose.model("item_requests", itemRequestSchema, "item_requests");

export const OPEN_REQUEST_STATUSES = [ITEM_REQUEST_STATUS.PENDING, ITEM_REQUEST_STATUS.PARTIAL];
export default StockItemRequestModel;
