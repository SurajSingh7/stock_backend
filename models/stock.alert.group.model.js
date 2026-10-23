import mongoose from "mongoose";
import { ALERT_GROUP_TYPE, ALERT_GROUP_TYPE_ARRAY } from "../constants/stock.enums.js";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";

const { Schema } = mongoose;

/*
  A named set of recipients, picked once and used by many rules.
    LIST            people from Contacts — each gets their own message
    WHATSAPP_GROUP  one WhatsApp group; one message lands in the group.
                    `whatsappGroupId` is the provider's id (chatflow:
                    GET /v1/groups). A WhatsApp group has no email, so on the
                    Email channel it falls back to its `members`, if any.
*/
const groupSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ALERT_GROUP_TYPE_ARRAY, default: ALERT_GROUP_TYPE.LIST },
    description: { type: String, trim: true, default: "" },
    members: [{ type: Schema.Types.ObjectId, ref: "alert_contacts" }],
    whatsappGroupId: { type: String, trim: true, default: "" },
    whatsappGroupName: { type: String, trim: true, default: "" },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

groupSchema.index({ isActive: 1, name: 1 });

groupSchema.plugin(actorStampPlugin);

const StockAlertGroupModel = mongoose.model("alert_groups", groupSchema, "alert_groups");

export default StockAlertGroupModel;
