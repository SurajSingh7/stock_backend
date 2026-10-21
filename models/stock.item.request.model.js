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

// What happened to the request, newest last — shown as its own timeline.
const historySchema = new Schema(
  {
    action: { type: String, trim: true, required: true }, // CREATED, ISSUED, REJECTED, RESENT, SHORT_CLOSED, COMPLETED
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

    // One LEAF category per request.
    categoryId: { type: Schema.Types.ObjectId, ref: "categories", required: true },
    categoryPath: { type: String, trim: true, default: "" },
    // What a quantity of this category means: units (individual products) or
    // metres/pieces off batches. Every active product of the category shares
    // both, or the category cannot be requested at all (see _categoryKind).
    trackingMethod: { type: String, enum: TRACKING_METHODS_ARRAY, required: true },
    unit: { type: String, enum: UNIT_TYPES_ARRAY, default: null },
    requestedQty: { type: Number, required: true, min: 0 },
    issuedQty: { type: Number, default: 0, min: 0 },

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

itemRequestSchema.plugin(actorStampPlugin);

const StockItemRequestModel = mongoose.model("item_requests", itemRequestSchema, "item_requests");

export const OPEN_REQUEST_STATUSES = [ITEM_REQUEST_STATUS.PENDING, ITEM_REQUEST_STATUS.PARTIAL];
export default StockItemRequestModel;
