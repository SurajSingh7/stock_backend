import mongoose from "mongoose";
import { ALERT_ESCALATION_STATUS, ALERT_ESCALATION_STATUS_ARRAY } from "../constants/stock.enums.js";

const { Schema } = mongoose;

/*
  One record's chain under one rule — the Escalations tab.

  Created when a rule with more than its INITIAL step fires. The checker picks
  it up at `nextDueAt`, re-reads the record, and either sends step
  `nextStepIndex` (still pending) or closes the chain as RESOLVED.

  At most one ACTIVE chain per (rule, record): the partial unique index makes
  a second firing of the same event restart nothing by accident — the
  dispatcher closes the old chain first when a fresh cycle is wanted.
*/
const historySchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    stepIndex: { type: Number, default: null },
    event: { type: String, trim: true, default: "" }, // SENT | RESOLVED | STOPPED | …
    detail: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const escalationSchema = new Schema(
  {
    ruleId: { type: Schema.Types.ObjectId, ref: "alert_rules", required: true },
    ruleName: { type: String, trim: true, default: "" },
    eventKey: { type: String, required: true, trim: true },
    recordType: { type: String, trim: true, default: "" },
    recordId: { type: Schema.Types.ObjectId, required: true },
    recordRef: { type: String, trim: true, default: "" },

    status: { type: String, enum: ALERT_ESCALATION_STATUS_ARRAY, default: ALERT_ESCALATION_STATUS.ACTIVE },
    // The step that goes out next, and when.
    nextStepIndex: { type: Number, default: 1 },
    nextDueAt: { type: Date, default: null },
    // Claimed by a checker run — prevents two runs sending the same step.
    lockedUntil: { type: Date, default: null },

    startedAt: { type: Date, default: Date.now },
    closedAt: { type: Date, default: null },
    closedReason: { type: String, trim: true, default: "" },
    closedBy: { type: Object, default: null },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

escalationSchema.index({ status: 1, nextDueAt: 1 });
escalationSchema.index({ recordId: 1 });
escalationSchema.index(
  { ruleId: 1, recordId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: ALERT_ESCALATION_STATUS.ACTIVE },
    name: "uniq_active_escalation_per_rule_record",
  }
);

const StockAlertEscalationModel = mongoose.model("alert_escalations", escalationSchema, "alert_escalations");

export default StockAlertEscalationModel;
