import mongoose from "mongoose";

const { Schema } = mongoose;

/*
  The website bell — one row per notification per user.

  Written by the IN_APP channel's provider (helpers/alert.providers/
  inapp.inbox.provider.js) when a rule's In-App send goes out. `userId` is
  the HRMS login id (what req.user._id carries), so a user only ever reads
  their own rows. `messageId` points back at the Message Log row, which turns
  READ when the user opens the notification.
*/
const inboxSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    title: { type: String, trim: true, default: "" },
    body: { type: String, default: "" },
    link: { type: String, trim: true, default: "" },
    eventKey: { type: String, trim: true, default: "" },
    recordType: { type: String, trim: true, default: "" },
    recordRef: { type: String, trim: true, default: "" },
    recordId: { type: Schema.Types.ObjectId, default: null },
    messageId: { type: Schema.Types.ObjectId, ref: "alert_messages", default: null },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

inboxSchema.index({ userId: 1, createdAt: -1 });
inboxSchema.index({ userId: 1, readAt: 1 });

const StockAlertInboxModel = mongoose.model("alert_inbox", inboxSchema, "alert_inbox");

export default StockAlertInboxModel;
