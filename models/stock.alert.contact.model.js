import mongoose from "mongoose";
import { ALERT_CONTACT_TYPE, ALERT_CONTACT_TYPE_ARRAY } from "../constants/stock.enums.js";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";

const { Schema } = mongoose;

/*
  A person alerts can be sent to.

  Users live in HRMS and this database has no users collection, so a contact
  carries its own phone and email. `userId` optionally links it to the HRMS
  login — the website bell (phase 5) delivers by that id, and a CREATOR
  recipient is matched to its contact by it.

  Two numbers on purpose: the HRMS phone is often a calling-only line, so
  WhatsApp goes to `whatsappNumber` when one is set and falls back to `phone`
  only when it is empty. Both are digits with country code (919876543210).
*/
const contactSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ALERT_CONTACT_TYPE_ARRAY, default: ALERT_CONTACT_TYPE.INTERNAL },
    phone: { type: String, trim: true, default: "" },
    whatsappNumber: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },
    userId: { type: Schema.Types.ObjectId, default: null },
    designation: { type: String, trim: true, default: "" },
    note: { type: String, trim: true, default: "" },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

contactSchema.index({ isActive: 1, name: 1 });
contactSchema.index({ userId: 1 }, { sparse: true });

contactSchema.plugin(actorStampPlugin);

const StockAlertContactModel = mongoose.model("alert_contacts", contactSchema, "alert_contacts");

export default StockAlertContactModel;
