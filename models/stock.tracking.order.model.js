import mongoose from "mongoose";
import { TRACKING_STATUS, TRACKING_STATUS_ARRAY, MAIL_MODE_ARRAY } from "../constants/stock.enums.js";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";

const { Schema } = mongoose;

// Same shape as StockPurchaseOrderModel.buyerEntity — snapshotted from the
// internal-companies source at "+ Add Entity" time on the Tracking Orders page.
const buyerEntitySchema = new Schema(
  {
    entityId: { type: Schema.Types.ObjectId, default: null },
    name: { type: String, trim: true, default: "" },
    alias: { type: String, trim: true, default: "" },
    gstNumber: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    stateCode: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const mailResultSchema = new Schema(
  {
    mode: { type: String, enum: MAIL_MODE_ARRAY, default: null },
    channel: { type: String, trim: true, default: "" },
    sentAt: { type: Date, default: null },
    notificationId: { type: Schema.Types.ObjectId, ref: "notifications", default: null },
    // Array like cc: a PO can address several of the vendor's contacts.
    // Mongoose casts an older single-string value into a one-element array on
    // read, so existing rows keep working.
    to: { type: [String], default: [] },
    cc: { type: [String], default: [] },
    from: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const trackingOrderSchema = new Schema(
  {
    sourceQuotationId: { type: Schema.Types.ObjectId, ref: "quotations", required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "vendors", required: true },

    buyerEntity: { type: buyerEntitySchema, default: () => ({}) },

    status: {
      type: String,
      enum: TRACKING_STATUS_ARRAY,
      default: TRACKING_STATUS.ENTITY_PENDING,
    },

    poId: { type: Schema.Types.ObjectId, ref: "purchase_orders", default: null },

    notRequiredReason: { type: String, trim: true, default: "" },
    disabledAt: { type: Date, default: null },

    mailResult: { type: mailResultSchema, default: null },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

trackingOrderSchema.index({ sourceQuotationId: 1, vendorId: 1 }, { unique: true });
trackingOrderSchema.index({ status: 1, isActive: 1 });
trackingOrderSchema.index({ poId: 1 });


// who created / last touched this — see the plugin for why it is a hook
trackingOrderSchema.plugin(actorStampPlugin);

const StockTrackingOrderModel = mongoose.model(
  "tracking_orders",
  trackingOrderSchema,
  "tracking_orders"
);

export default StockTrackingOrderModel;
