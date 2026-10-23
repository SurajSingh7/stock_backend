import mongoose from "mongoose";
import {
  ALERT_CHANNEL_ARRAY,
  ALERT_MESSAGE_STATUS,
  ALERT_MESSAGE_STATUS_ARRAY,
  ALERT_STEP_TYPE_ARRAY,
  ALERT_TRIGGER_ARRAY,
} from "../constants/stock.enums.js";
import { actorSnapshot } from "./plugins/actor.stamp.plugin.js";

const { Schema } = mongoose;

/*
  The Message Log, and the outbox the sender works from.

  One row per message per recipient. A row is written BEFORE anything is
  sent, so a send that crashes half way still leaves a trace, and the row's
  _id doubles as the provider idempotency key — a retry or a Resend can never
  deliver the same message twice.

  The text is rendered once, when the row is written. What the log shows is
  exactly what went out, even if the template is edited afterwards.
*/
const targetSchema = new Schema(
  {
    // PHONE | EMAIL | WA_GROUP | USER (in-app)
    kind: { type: String, required: true },
    address: { type: String, trim: true, default: "" },
    name: { type: String, trim: true, default: "" },
    contactId: { type: Schema.Types.ObjectId, default: null },
  },
  { _id: false }
);

const attachmentSchema = new Schema(
  {
    fileName: { type: String, trim: true, default: "" },
    // Absolute path on this server — read at send time.
    path: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const messageSchema = new Schema(
  {
    trigger: { type: String, enum: ALERT_TRIGGER_ARRAY, required: true },
    eventKey: { type: String, trim: true, default: "" },
    ruleId: { type: Schema.Types.ObjectId, ref: "alert_rules", default: null },
    ruleName: { type: String, trim: true, default: "" },
    escalationId: { type: Schema.Types.ObjectId, ref: "alert_escalations", default: null },
    stepIndex: { type: Number, default: null },
    stepType: { type: String, enum: [...ALERT_STEP_TYPE_ARRAY, null], default: null },

    // The record it is about — "QT-0042" etc. for the screen.
    recordType: { type: String, trim: true, default: "" },
    recordId: { type: Schema.Types.ObjectId, default: null },
    recordRef: { type: String, trim: true, default: "" },

    channel: { type: String, enum: ALERT_CHANNEL_ARRAY, required: true },
    provider: { type: String, trim: true, default: "" },
    templateId: { type: Schema.Types.ObjectId, ref: "alert_templates", default: null },

    to: { type: targetSchema, required: true },
    cc: { type: [String], default: [] },
    // Sandbox: the address it WOULD have gone to.
    sandboxedFrom: { type: String, trim: true, default: "" },

    subject: { type: String, default: "" },
    body: { type: String, default: "" },
    // Where "open" goes — the record's screen. Used by the website bell.
    link: { type: String, trim: true, default: "" },
    attachments: { type: [attachmentSchema], default: [] },

    status: { type: String, enum: ALERT_MESSAGE_STATUS_ARRAY, default: ALERT_MESSAGE_STATUS.QUEUED },
    skipReason: { type: String, trim: true, default: "" },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    // Set while one sender run is calling the provider for this row; a row
    // whose claim ran out without a provider id crashed mid-call and is
    // queued again.
    claimedUntil: { type: Date, default: null },
    lastError: { type: String, default: "" },

    providerMessageId: { type: String, trim: true, default: "" },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    // Last time the sender asked the provider for delivered/read.
    statusCheckedAt: { type: Date, default: null },

    // A Resend makes a new row pointing at the one it repeats.
    resendOf: { type: Schema.Types.ObjectId, default: null },
    triggeredBy: { type: Object, default: null },

    log: {
      type: [
        new Schema(
          { at: { type: Date, default: Date.now }, event: String, detail: String },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { timestamps: true }
);

messageSchema.index({ status: 1, nextAttemptAt: 1 });
messageSchema.index({ createdAt: -1 });
messageSchema.index({ recordId: 1, createdAt: -1 });
messageSchema.index({ eventKey: 1, createdAt: -1 });
messageSchema.index({ channel: 1, status: 1, createdAt: -1 });

messageSchema.methods.note = function note(event, detail = "") {
  this.log.push({ at: new Date(), event, detail: String(detail || "").slice(0, 500) });
};

export const triggeredBySnapshot = (actor) => (actor ? actorSnapshot(actor) : null);

const StockAlertMessageModel = mongoose.model("alert_messages", messageSchema, "alert_messages");

export default StockAlertMessageModel;
