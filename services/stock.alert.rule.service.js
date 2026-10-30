import mongoose from "mongoose";
import StockAlertRuleModel from "../models/stock.alert.rule.model.js";
import StockAlertTemplateModel from "../models/stock.alert.template.model.js";
import StockAlertEscalationModel from "../models/stock.alert.escalation.model.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import { getAlertEvent, eventAllowsVendor } from "../config/alert.event.catalog.js";
import {
  ALERT_CHANNEL,
  ALERT_CHANNEL_ARRAY,
  ALERT_ESCALATION_STATUS,
  ALERT_RECIPIENT_TYPE,
  ALERT_RECIPIENT_TYPE_ARRAY,
  ALERT_RULE_KIND,
  ALERT_STEP_TYPE,
} from "../constants/stock.enums.js";

const escapeRegex = (s = "") => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isId = (x) => mongoose.isValidObjectId(x);

/*
  A rule is checked as a whole on every save, so a broken chain never reaches
  the sender: the first step is INITIAL at 0 h, later steps wait > 0 h, an
  event with no "pending" gets no later steps, every template matches its
  send's channel AND the rule's event.
*/
const cleanRecipients = (list, where, { allowVendor, allowBranchUsers }) => {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error(`${where}: recipients must be a list`);
  return list.map((r) => {
    if (!ALERT_RECIPIENT_TYPE_ARRAY.includes(r?.type)) throw new Error(`${where}: invalid recipient type`);
    if ([ALERT_RECIPIENT_TYPE.CONTACT, ALERT_RECIPIENT_TYPE.GROUP].includes(r.type) && !isId(r.refId)) {
      throw new Error(`${where}: pick the ${r.type === ALERT_RECIPIENT_TYPE.CONTACT ? "contact" : "group"}`);
    }
    if (r.type === ALERT_RECIPIENT_TYPE.ADDRESS && !String(r.address || "").trim()) {
      throw new Error(`${where}: type the email or number`);
    }
    if (r.type === ALERT_RECIPIENT_TYPE.VENDOR && !allowVendor) {
      throw new Error(`${where}: this event has no single vendor to send to`);
    }
    if (r.type === ALERT_RECIPIENT_TYPE.BRANCH_USERS && !allowBranchUsers) {
      throw new Error(`${where}: "people with access to the branch" is not available for this event`);
    }
    return { type: r.type, refId: r.refId || null, address: String(r.address || "").trim() };
  });
};

const cleanRule = async (body, current = {}) => {
  const next = { ...current };
  if (body.name !== undefined) next.name = String(body.name || "").trim();
  if (body.description !== undefined) next.description = String(body.description || "").trim();
  if (body.eventKey !== undefined) next.eventKey = body.eventKey;
  if (body.enabled !== undefined) next.enabled = !!body.enabled;
  if (body.conditions !== undefined) {
    const c = body.conditions || {};
    const ids = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).map(String) : []);
    next.conditions = {
      branchIds: ids(c.branchIds),
      vendorIds: ids(c.vendorIds),
      minAmount: c.minAmount === null || c.minAmount === "" || c.minAmount === undefined ? null : Number(c.minAmount),
    };
    if ([...next.conditions.branchIds, ...next.conditions.vendorIds].some((x) => !isId(x))) throw new Error("Invalid condition");
    if (next.conditions.minAmount !== null && !(next.conditions.minAmount >= 0)) throw new Error("Minimum amount must be 0 or more");
  }
  if (body.steps !== undefined) next.steps = body.steps;

  if (!next.name) throw new Error("Rule name is required");
  const event = getAlertEvent(next.eventKey);
  if (!event) throw new Error("Invalid event");
  next.kind = event.kind === "MANUAL" ? ALERT_RULE_KIND.MANUAL : ALERT_RULE_KIND.AUTOMATIC;
  const allowVendor = eventAllowsVendor(event);
  const allowBranchUsers = !!event.branchAccessModule;

  const steps = Array.isArray(next.steps) ? next.steps : [];
  if (!steps.length) throw new Error("A rule needs at least its first message");
  if (!event.pendingLabel && steps.length > 1) {
    throw new Error("This event has nothing to wait on, so it can't have reminders or escalations");
  }
  if (next.kind === ALERT_RULE_KIND.MANUAL && steps.length > 1) throw new Error("A manual rule has only one message");

  const templateIds = new Set();
  const cleanedSteps = steps.map((s, i) => {
    const where = i === 0 ? "First message" : `Step ${i + 1}`;
    const type = i === 0 ? ALERT_STEP_TYPE.INITIAL : s.type === ALERT_STEP_TYPE.ESCALATION ? ALERT_STEP_TYPE.ESCALATION : ALERT_STEP_TYPE.REMINDER;
    const afterHours = i === 0 ? 0 : Number(s.afterHours);
    if (i > 0 && !(afterHours > 0)) throw new Error(`${where}: hours after the previous step must be more than 0`);
    if (i > 0 && afterHours > 24 * 30) throw new Error(`${where}: at most 720 hours (30 days)`);
    const sends = Array.isArray(s.sends) ? s.sends : [];
    if (!sends.length) throw new Error(`${where}: add at least one channel`);
    const seenChannels = new Set();
    return {
      ...(s._id && isId(s._id) ? { _id: s._id } : {}),
      type,
      afterHours,
      enabled: s.enabled === undefined ? true : !!s.enabled,
      sends: sends.map((send) => {
        if (!ALERT_CHANNEL_ARRAY.includes(send.channel)) throw new Error(`${where}: invalid channel`);
        if (seenChannels.has(send.channel)) throw new Error(`${where}: ${send.channel} is added twice`);
        seenChannels.add(send.channel);
        if (!isId(send.templateId)) throw new Error(`${where}: pick a ${send.channel} template`);
        templateIds.add(String(send.templateId));
        const to = cleanRecipients(send.to, `${where} (${send.channel})`, { allowVendor, allowBranchUsers });
        // MANUAL rules may leave To empty: the dialog fills it from the vendor.
        if (!to.length && next.kind !== ALERT_RULE_KIND.MANUAL) throw new Error(`${where} (${send.channel}): add at least one recipient`);
        return {
          ...(send._id && isId(send._id) ? { _id: send._id } : {}),
          channel: send.channel,
          enabled: send.enabled === undefined ? true : !!send.enabled,
          templateId: send.templateId,
          to,
          cc: send.channel === ALERT_CHANNEL.EMAIL ? cleanRecipients(send.cc, `${where} (CC)`, { allowVendor, allowBranchUsers }) : [],
        };
      }),
    };
  });

  const templates = await StockAlertTemplateModel.find({ _id: { $in: [...templateIds] }, isActive: true }).lean();
  const byId = new Map(templates.map((t) => [String(t._id), t]));
  cleanedSteps.forEach((s, i) =>
    s.sends.forEach((send) => {
      const t = byId.get(String(send.templateId));
      const where = i === 0 ? "First message" : `Step ${i + 1}`;
      if (!t) throw new Error(`${where}: the ${send.channel} template no longer exists`);
      if (t.channel !== send.channel) throw new Error(`${where}: "${t.name}" is a ${t.channel} template, not ${send.channel}`);
      if (t.eventKey !== next.eventKey) throw new Error(`${where}: "${t.name}" is written for a different event`);
    })
  );
  next.steps = cleanedSteps;
  return next;
};

const cancelChains = async (ruleId, reason) =>
  StockAlertEscalationModel.updateMany(
    { ruleId, status: ALERT_ESCALATION_STATUS.ACTIVE },
    {
      $set: { status: ALERT_ESCALATION_STATUS.CANCELLED, closedAt: new Date(), closedReason: reason },
      $push: { history: { at: new Date(), event: "CANCELLED", detail: reason } },
    }
  );

export default class StockAlertRuleService {
  static async list({ skip = 0, limit = 50, search, eventKey, showInactive } = {}) {
    const filter = showInactive ? {} : { isActive: true };
    if (eventKey) filter.eventKey = eventKey;
    if (search) filter.name = { $regex: escapeRegex(search.trim()), $options: "i" };
    const [data, total] = await Promise.all([
      StockAlertRuleModel.find(filter).sort({ eventKey: 1, name: 1 }).skip(skip).limit(limit).lean(),
      StockAlertRuleModel.countDocuments(filter),
    ]);
    return { data, total };
  }

  static async getById(id) {
    const r = await StockAlertRuleModel.findOne({ _id: id, isActive: true }).lean();
    if (!r) throw new Error("Rule not found");
    return r;
  }

  static async create(body, actor) {
    const doc = await StockAlertRuleModel.create(await cleanRule(body));
    await StockAuditLogService.recordAudit({ entityType: "alert_rules", entityId: doc._id, action: "CREATE", actor, after: doc.toObject() });
    return doc;
  }

  static async update(id, body, actor) {
    const doc = await StockAlertRuleModel.findOne({ _id: id, isActive: true });
    if (!doc) throw new Error("Rule not found");
    const before = doc.toObject();
    const next = await cleanRule(body, before);
    if (next.eventKey !== before.eventKey) {
      throw new Error("A rule's event can't change — make a new rule for the other event");
    }
    doc.set(next);
    await doc.save();
    // Switched off → its running chains stop now, not at their next step.
    if (before.enabled && !doc.enabled) await cancelChains(doc._id, "Rule switched off");
    await StockAuditLogService.recordAudit({ entityType: "alert_rules", entityId: doc._id, action: "UPDATE", actor, before, after: doc.toObject() });
    return doc;
  }

  static async setEnabled(id, enabled, actor) {
    const doc = await StockAlertRuleModel.findOne({ _id: id, isActive: true });
    if (!doc) throw new Error("Rule not found");
    const before = doc.toObject();
    doc.enabled = !!enabled;
    await doc.save();
    if (!doc.enabled) await cancelChains(doc._id, "Rule switched off");
    await StockAuditLogService.recordAudit({ entityType: "alert_rules", entityId: doc._id, action: doc.enabled ? "ENABLE" : "DISABLE", actor, before, after: doc.toObject() });
    return doc;
  }

  static async remove(id, actor) {
    const doc = await StockAlertRuleModel.findOne({ _id: id, isActive: true });
    if (!doc) throw new Error("Rule not found");
    const before = doc.toObject();
    doc.isActive = false;
    doc.deletedAt = new Date();
    await doc.save();
    await cancelChains(doc._id, "Rule deleted");
    await StockAuditLogService.recordAudit({ entityType: "alert_rules", entityId: doc._id, action: "DELETE", actor, before, after: doc.toObject() });
    return doc;
  }
}
