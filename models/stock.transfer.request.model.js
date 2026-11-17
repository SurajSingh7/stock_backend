import mongoose from "mongoose";
import { actorStampPlugin, actorSchema } from "./plugins/actor.stamp.plugin.js";
import {
  TRACKING_METHODS_ARRAY,
  UNIT_TYPES_ARRAY,
  TRANSFER_REQUEST_STATUS,
  TRANSFER_REQUEST_STATUS_ARRAY,
} from "../constants/stock.enums.js";

const { Schema } = mongoose;

/*
  inventory_transfer_requests — one branch asking another for stock (SR-…),
  and the status both branches follow until it is done (see
  TRANSFER_REQUEST_STATUS). Every transfer starts from a request.

  The stock that actually travels is a transfer (inventory_transfers, TRF-…),
  created when the source branch sends; the request points at it through
  transferId. My Requests and Requests to Us show every status; Transfer
  History lists the finished ones (RECEIVED / DECLINED) from both sides.

  Like a subscriber's Item Request, the ask is for CATEGORIES and quantities
  ("10 × ONT / Dual Band", "50 m × Drop Cable"), never a product: which
  product goes out is the sending store's call, and a line may be filled from
  several products of its category. Only a leaf category whose products are
  all counted the same way can be asked for (StockItemRequestService._line).
*/
const transferRequestLineSchema = new Schema(
  {
    categoryId: { type: Schema.Types.ObjectId, ref: "categories", required: true },
    // Snapshot — the request reads the same after the category is renamed.
    categoryPath: { type: String, trim: true, default: "" },
    trackingMethod: { type: String, enum: TRACKING_METHODS_ARRAY, required: true },
    unit: { type: String, enum: UNIT_TYPES_ARRAY, default: null },

    requestedQty: { type: Number, required: true, min: 0 },
    // What is on the transfer for this line, across every product chosen —
    // lowered when Correct & Resend takes something off. requestedQty − sentQty
    // was closed with the request's reason; a still-needed rest is a new request.
    sentQty: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const transferRequestSchema = new Schema(
  {
    requestNumber: { type: String, trim: true, uppercase: true, required: true },

    // Wants the stock, raised the request.
    requestingBranchId: { type: Schema.Types.ObjectId, ref: "branches", required: true },
    // Asked for it — sends or declines.
    sourceBranchId: { type: Schema.Types.ObjectId, ref: "branches", required: true },

    lines: { type: [transferRequestLineSchema], default: [] },

    status: {
      type: String,
      enum: TRANSFER_REQUEST_STATUS_ARRAY,
      default: TRANSFER_REQUEST_STATUS.PENDING,
    },

    remarks: { type: String, trim: true, default: "" },
    // Why it was declined, or why less than asked was sent.
    reason: { type: String, trim: true, default: "" },

    requestedBy: { type: Schema.Types.ObjectId, ref: "users", default: null },
    requestedByName: { type: String, trim: true, default: "" },
    requestedAt: { type: Date, default: Date.now },

    // The source branch's answer: who sent or declined it.
    processedBy: { type: Schema.Types.ObjectId, ref: "users", default: null },
    processedByName: { type: String, trim: true, default: "" },
    processedAt: { type: Date, default: null },

    // The transfer that carries what was sent.
    transferId: { type: Schema.Types.ObjectId, ref: "inventory_transfers", default: null },
    transferNumber: { type: String, trim: true, default: "" },

    // When and by whom it was finished — All Received (the asking branch) or
    // Decline (the branch asked). A snapshot like createdBy: employee code,
    // name, role, phone, email and the person's own branch at the time.
    closedAt: { type: Date, default: null },
    closedBy: { type: actorSchema, default: null },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

transferRequestSchema.index({ requestNumber: 1 }, { unique: true });
transferRequestSchema.index({ requestingBranchId: 1, status: 1 });
transferRequestSchema.index({ sourceBranchId: 1, status: 1 });
transferRequestSchema.index({ "lines.categoryId": 1 });
transferRequestSchema.index({ status: 1, closedAt: -1 });

// who created / last touched this — see the plugin for why it is a hook
transferRequestSchema.plugin(actorStampPlugin);

const StockTransferRequestModel = mongoose.model(
  "inventory_transfer_requests",
  transferRequestSchema,
  "inventory_transfer_requests"
);

export default StockTransferRequestModel;
