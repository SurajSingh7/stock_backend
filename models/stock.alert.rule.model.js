import mongoose from "mongoose";
import {
  ALERT_CHANNEL_ARRAY,
  ALERT_RULE_KIND,
  ALERT_RULE_KIND_ARRAY,
  ALERT_STEP_TYPE,
  ALERT_STEP_TYPE_ARRAY,
  ALERT_RECIPIENT_TYPE_ARRAY,
} from "../constants/stock.enums.js";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";

const { Schema } = mongoose;

/*
  A rule: on this event, send these steps.

    steps[0]   INITIAL — goes out the moment the event happens
    steps[1..] REMINDER / ESCALATION — each `afterHours` after the step before
               it, and only while the record is still pending (the event
               catalog decides what "pending" means, not the admin)

  Every step, every channel inside a step, and the rule itself has its own
  ON/OFF. The channel master switch (alert_settings) sits above all of them.
*/
const recipientSchema = new Schema(
  {
    type: { type: String, enum: ALERT_RECIPIENT_TYPE_ARRAY, required: true },
    // CONTACT → alert_contacts id, GROUP → alert_groups id
    refId: { type: Schema.Types.ObjectId, default: null },
    // ADDRESS → an email or a phone, depending on the channel
    address: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const sendSchema = new Schema(
  {
    channel: { type: String, enum: ALERT_CHANNEL_ARRAY, required: true },
    enabled: { type: Boolean, default: true },
    templateId: { type: Schema.Types.ObjectId, ref: "alert_templates", required: true },
    to: { type: [recipientSchema], default: [] },
    cc: { type: [recipientSchema], default: [] }, // Email only
  },
  { _id: true }
);

const stepSchema = new Schema(
  {
    type: { type: String, enum: ALERT_STEP_TYPE_ARRAY, default: ALERT_STEP_TYPE.INITIAL },
    // Hours after the previous step (0 for the INITIAL step).
    afterHours: { type: Number, default: 0, min: 0 },
    enabled: { type: Boolean, default: true },
    sends: { type: [sendSchema], default: [] },
  },
  { _id: true }
);

const ruleSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    eventKey: { type: String, required: true, trim: true },
    kind: { type: String, enum: ALERT_RULE_KIND_ARRAY, default: ALERT_RULE_KIND.AUTOMATIC },
    enabled: { type: Boolean, default: true },
    description: { type: String, trim: true, default: "" },

    // Empty = no restriction. All given conditions must hold.
    conditions: {
      branchIds: [{ type: Schema.Types.ObjectId, ref: "branches" }],
      vendorIds: [{ type: Schema.Types.ObjectId, ref: "vendors" }],
      minAmount: { type: Number, default: null, min: 0 },
    },

    steps: { type: [stepSchema], default: [] },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ruleSchema.index({ isActive: 1, enabled: 1, eventKey: 1 });

ruleSchema.plugin(actorStampPlugin);

const StockAlertRuleModel = mongoose.model("alert_rules", ruleSchema, "alert_rules");

export default StockAlertRuleModel;
