import mongoose from "mongoose";
import { NOTIFICATION_CHANNEL_ARRAY } from "../constants/stock.enums.js";

const { Schema } = mongoose;

const stockNotificationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },

    channel: { type: String, enum: NOTIFICATION_CHANNEL_ARRAY, required: true },

    note: { type: String, trim: true, default: "" },
    ccEmails: { type: [String], default: [] },

    // Exactly one ACTIVE default per channel — enforced in the service
    // (auto-demotes the previous default for that channel) and backstopped
    // by the partial unique index below, same pattern as Terms & Conditions.
    isDefault: { type: Boolean, default: false },

    // Required (non-empty) when isDefault is false; ignored/cleared when true.
    applicableVendors: [{ type: Schema.Types.ObjectId, ref: "vendors" }],

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

stockNotificationSchema.index({ isDefault: 1, channel: 1 });
stockNotificationSchema.index({ applicableVendors: 1 });
stockNotificationSchema.index({ isActive: 1, channel: 1 });

// DB-level guard — only one ACTIVE default document per channel.
stockNotificationSchema.index(
  { isDefault: 1, channel: 1 },
  {
    unique: true,
    partialFilterExpression: { isDefault: true, isActive: true },
    name: "uniq_active_default_notification_per_channel",
  }
);

const StockNotificationModel = mongoose.model(
  "notifications",
  stockNotificationSchema,
  "notifications"
);

export default StockNotificationModel;
