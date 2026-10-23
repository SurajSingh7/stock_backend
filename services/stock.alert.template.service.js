import StockAlertTemplateModel from "../models/stock.alert.template.model.js";
import StockAlertRuleModel from "../models/stock.alert.rule.model.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import { getAlertEvent, sampleVarsFor } from "../config/alert.event.catalog.js";
import { renderAlertTemplate, unknownVariables } from "../helpers/alert.render.helper.js";
import { ALERT_CHANNEL, ALERT_CHANNEL_ARRAY } from "../constants/stock.enums.js";

const escapeRegex = (s = "") => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const clean = (body, current = {}) => {
  const next = { ...current };
  for (const f of ["name", "channel", "eventKey", "subject", "body"]) {
    if (body[f] !== undefined) next[f] = typeof body[f] === "string" ? body[f].trim() : body[f];
  }
  if (body.attachDocument !== undefined) next.attachDocument = !!body.attachDocument;

  if (!next.name) throw new Error("Template name is required");
  if (!ALERT_CHANNEL_ARRAY.includes(next.channel)) throw new Error("Invalid channel");
  const event = getAlertEvent(next.eventKey);
  if (!event) throw new Error("Invalid event");
  if (!next.body) throw new Error("Message text is required");
  if (next.channel === ALERT_CHANNEL.EMAIL && !next.subject) throw new Error("Email subject is required");
  if (next.channel === ALERT_CHANNEL.IN_APP && !next.subject) throw new Error("A title is required for the website bell");
  if (next.channel === ALERT_CHANNEL.WHATSAPP) next.subject = "";
  if (next.attachDocument && !event.hasDocument) next.attachDocument = false;

  // A typo'd {{variable}} would go out literally — refuse it here.
  const known = event.variables.map((v) => v.key);
  const bad = unknownVariables(`${next.subject} ${next.body}`, known);
  if (bad.length) throw new Error(`Unknown variable(s) for this event: ${bad.map((b) => `{{${b}}}`).join(", ")}`);
  return next;
};

export default class StockAlertTemplateService {
  static async list({ skip = 0, limit = 50, search, channel, eventKey, showInactive } = {}) {
    const filter = showInactive ? {} : { isActive: true };
    if (channel) filter.channel = channel;
    if (eventKey) filter.eventKey = eventKey;
    if (search) filter.name = { $regex: escapeRegex(search.trim()), $options: "i" };
    const [data, total] = await Promise.all([
      StockAlertTemplateModel.find(filter).sort({ eventKey: 1, channel: 1, name: 1 }).skip(skip).limit(limit).lean(),
      StockAlertTemplateModel.countDocuments(filter),
    ]);
    return { data, total };
  }

  static async getById(id) {
    const t = await StockAlertTemplateModel.findOne({ _id: id, isActive: true }).lean();
    if (!t) throw new Error("Template not found");
    return t;
  }

  static async create(body, actor) {
    const doc = await StockAlertTemplateModel.create(clean(body));
    await StockAuditLogService.recordAudit({ entityType: "alert_templates", entityId: doc._id, action: "CREATE", actor, after: doc.toObject() });
    return doc;
  }

  static async update(id, body, actor) {
    const doc = await StockAlertTemplateModel.findOne({ _id: id, isActive: true });
    if (!doc) throw new Error("Template not found");
    const before = doc.toObject();
    const next = clean(body, before);
    // A rule already points this template at a channel/event; moving it
    // would silently send the wrong text on the wrong channel.
    if (next.channel !== before.channel || next.eventKey !== before.eventKey) {
      const used = await StockAlertRuleModel.exists({ isActive: true, "steps.sends.templateId": doc._id });
      if (used) throw new Error("This template is used by a rule — its channel and event can no longer change. Make a new template instead.");
    }
    doc.set(next);
    await doc.save();
    await StockAuditLogService.recordAudit({ entityType: "alert_templates", entityId: doc._id, action: "UPDATE", actor, before, after: doc.toObject() });
    return doc;
  }

  static async remove(id, actor) {
    const doc = await StockAlertTemplateModel.findOne({ _id: id, isActive: true });
    if (!doc) throw new Error("Template not found");
    const used = await StockAlertRuleModel.findOne({ isActive: true, "steps.sends.templateId": doc._id }).select("name").lean();
    if (used) throw new Error(`This template is used by rule "${used.name}" — remove it there first`);
    const before = doc.toObject();
    doc.isActive = false;
    doc.deletedAt = new Date();
    await doc.save();
    await StockAuditLogService.recordAudit({ entityType: "alert_templates", entityId: doc._id, action: "DELETE", actor, before, after: doc.toObject() });
    return doc;
  }

  /** Preview with the event's sample values (or the caller's own). */
  static preview({ channel, eventKey, subject, body, vars }) {
    const event = getAlertEvent(eventKey);
    if (!event) throw new Error("Invalid event");
    const known = event.variables.map((v) => v.key);
    return {
      ...renderAlertTemplate({ channel, subject, body }, { ...sampleVarsFor(eventKey), ...(vars || {}) }),
      unknownVariables: unknownVariables(`${subject || ""} ${body || ""}`, known),
    };
  }
}
