import mongoose from "mongoose";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";
import {
  TRACKING_METHODS_ARRAY,
  UNIT_TYPES_ARRAY,
  TRANSFER_REQUEST_STATUS,
  TRANSFER_REQUEST_STATUS_ARRAY,
} from "../constants/stock.enums.js";

const { Schema } = mongoose;

const transferRequestLineSchema = new Schema(
  {
    productDefinitionId: { type: Schema.Types.ObjectId, ref: "product_definitions", required: true },
    // Snapshots — survive product edits/deletes, same convention as invoice lines.
    // trackingMethod and unit are independent (see constants/stock.enums.js).
    productName: { type: String, trim: true, default: "" },
    trackingMethod: { type: String, enum: TRACKING_METHODS_ARRAY, required: true },
    unit: { type: String, enum: UNIT_TYPES_ARRAY, default: null },

    requestedQty: { type: Number, required: true, min: 1 },
    transferredQty: { type: Number, default: 0, min: 0 },
    rejectedQty: { type: Number, default: 0, min: 0 },

    transferredInventoryItemIds: { type: [Schema.Types.ObjectId], ref: "inventory_items", default: [] },
  },
  { _id: true }
);

const transferRequestSchema = new Schema(
  {
    requestNumber: { type: String, trim: true, uppercase: true, required: true },

    // Branch A — wants the stock, raised the request.
    requestingBranchId: { type: Schema.Types.ObjectId, ref: "branches", required: true },
    // Branch B — chosen at creation time as the branch the request is sent to.
    sourceBranchId: { type: Schema.Types.ObjectId, ref: "branches", required: true },

    lines: { type: [transferRequestLineSchema], default: [] },

    status: {
      type: String,
      enum: TRANSFER_REQUEST_STATUS_ARRAY,
      default: TRANSFER_REQUEST_STATUS.PENDING,
    },

    remarks: { type: String, trim: true, default: "" },
    // Shortfall / rejection reason — set whenever the request closes with
    // anything less than full fulfilment.
    reason: { type: String, trim: true, default: "" },

    requestedBy: { type: Schema.Types.ObjectId, ref: "users", default: null },
    requestedByName: { type: String, trim: true, default: "" },
    requestedAt: { type: Date, default: Date.now },

    // Whoever closed the request — the source branch processing or
    // rejecting it.
    processedBy: { type: Schema.Types.ObjectId, ref: "users", default: null },
    processedByName: { type: String, trim: true, default: "" },
    processedAt: { type: Date, default: null },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

transferRequestSchema.index({ requestNumber: 1 }, { unique: true });
transferRequestSchema.index({ requestingBranchId: 1 });
transferRequestSchema.index({ sourceBranchId: 1 });
transferRequestSchema.index({ status: 1 });


// who created / last touched this — see the plugin for why it is a hook
transferRequestSchema.plugin(actorStampPlugin);

const StockTransferRequestModel = mongoose.model(
  "inventory_transfer_requests",
  transferRequestSchema,
  "inventory_transfer_requests"
);

export default StockTransferRequestModel;
