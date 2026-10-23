import mongoose from "mongoose";
import { ALERT_CHANNEL_ARRAY } from "../constants/stock.enums.js";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";

const { Schema } = mongoose;

/*
  What a message says. Written for one channel and one event: the event fixes
  which {{variables}} exist (config/alert.event.catalog.js), the channel fixes
  the format — Email takes a subject and HTML, WhatsApp plain text with
  *bold* / _italic_.
*/
const templateSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    channel: { type: String, enum: ALERT_CHANNEL_ARRAY, required: true },
    eventKey: { type: String, required: true, trim: true },
    subject: { type: String, trim: true, default: "" },
    body: { type: String, required: true },
    // Send the record's document along (the PO PDF) — only for events whose
    // catalog entry offers one.
    attachDocument: { type: Boolean, default: false },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

templateSchema.index({ isActive: 1, eventKey: 1, channel: 1 });

templateSchema.plugin(actorStampPlugin);

const StockAlertTemplateModel = mongoose.model("alert_templates", templateSchema, "alert_templates");

export default StockAlertTemplateModel;
