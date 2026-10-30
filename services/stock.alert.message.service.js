import mongoose from "mongoose";
import StockAlertMessageModel, { triggeredBySnapshot } from "../models/stock.alert.message.model.js";
import StockAlertEscalationModel from "../models/stock.alert.escalation.model.js";
import StockAlertTemplateModel from "../models/stock.alert.template.model.js";
import StockAlertSettingsService from "./stock.alert.settings.service.js";
import StockAlertDispatcherService from "./stock.alert.dispatcher.service.js";
import { runSender } from "./stock.alert.worker.js";
import StockAlertRecipientService, { normalizePhone } from "./stock.alert.recipient.service.js";
import StockAlertRuleModel from "../models/stock.alert.rule.model.js";
import { sampleVarsFor, getAlertEvent } from "../config/alert.event.catalog.js";
import { renderAlertTemplate } from "../helpers/alert.render.helper.js";
import { getAlertProvider } from "../helpers/alert.providers/index.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import {
  ALERT_CHANNEL,
  ALERT_ESCALATION_STATUS,
  ALERT_MESSAGE_STATUS as S,
  ALERT_TRIGGER,
  CONTACT_RECIPIENT_TYPE,
} from "../constants/stock.enums.js";

const escapeRegex = (s = "") => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIST_FIELDS = "-body -log -attachments.path";

export class StockAlertMessageService {
  static async list({ skip = 0, limit = 50, channel, status, eventKey, trigger, recordId, search, dateFrom, dateTo } = {}) {
    const filter = {};
    if (channel) filter.channel = channel;
    if (status) filter.status = status;
    if (eventKey) filter.eventKey = eventKey;
    if (trigger) filter.trigger = trigger;
    if (recordId && mongoose.isValidObjectId(recordId)) filter.recordId = recordId;
    if (search) {
      const rx = { $regex: escapeRegex(search.trim()), $options: "i" };
      filter.$or = [{ recordRef: rx }, { "to.address": rx }, { "to.name": rx }, { ruleName: rx }];
    }
    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }
    const [data, total, counts] = await Promise.all([
      StockAlertMessageModel.find(filter).select(LIST_FIELDS).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      StockAlertMessageModel.countDocuments(filter),
      StockAlertMessageModel.aggregate([
        { $match: { ...filter, status: { $exists: true } } },
        { $group: { _id: "$status", n: { $sum: 1 } } },
      ]),
    ]);
    return { data, total, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) };
  }

  static async getById(id) {
    const m = await StockAlertMessageModel.findById(id).select("-attachments.path").lean();
    if (!m) throw new Error("Message not found");
    return m;
  }

  /** A new row repeating a failed / skipped / sent one — the original stays as history. */
  static async resend(id, actor) {
    const m = await StockAlertMessageModel.findById(id).lean();
    if (!m) throw new Error("Message not found");
    if ([S.QUEUED, S.SENDING].includes(m.status)) throw new Error("This message is still on its way");
    if (!m.to?.address) return StockAlertMessageService._retryMissed(m, actor);

    const settings = await StockAlertSettingsService.get();
    const row = StockAlertDispatcherService.prepareRow(
      {
        trigger: ALERT_TRIGGER.RESEND,
        eventKey: m.eventKey,
        ruleId: m.ruleId,
        ruleName: m.ruleName,
        escalationId: m.escalationId,
        stepIndex: m.stepIndex,
        stepType: m.stepType,
        recordType: m.recordType,
        recordId: m.recordId,
        recordRef: m.recordRef,
        channel: m.channel,
        provider: m.provider,
        templateId: m.templateId,
        // Already-sandboxed rows keep going to the sandbox.
        to: m.to,
        cc: m.cc,
        subject: m.subject,
        body: m.body,
        attachments: m.attachments,
        resendOf: m._id,
        triggeredBy: triggeredBySnapshot(actor),
        sandboxedFrom: m.sandboxedFrom,
      },
      { settings, channelOn: !!settings.channels?.[m.channel]?.enabled, ignoreSandbox: true }
    );
    if (row.status === S.SKIPPED) throw new Error(`Not resent: ${row.skipReason}`);
    const doc = await StockAlertMessageModel.create({ ...row, log: [{ at: new Date(), event: S.QUEUED, detail: "Resend" }] });
    await StockAuditLogService.recordAudit({ entityType: "alert_messages", entityId: doc._id, action: "RESEND", actor, after: { resendOf: m._id } });
    runSender().catch(() => {});
    return doc;
  }

  /*
    A row skipped for want of a recipient ("no WhatsApp number", "nobody
    linked to a login has access to this branch") has nobody to repeat it to.
    Trying again resolves the rule's recipients afresh — picking up the number
    added or the contact linked since — and sends the same text to whoever it
    now finds that this record's rule hasn't already reached on this channel.
  */
  static async _retryMissed(m, actor) {
    if (!m.ruleId || !m.body) throw new Error("This message had no address — fix the contact and let the rule send again");
    const rule = await StockAlertRuleModel.findOne({ _id: m.ruleId, isActive: true }).lean();
    const send = rule?.steps?.[m.stepIndex ?? 0]?.sends?.find((x) => x.channel === m.channel);
    if (!send) throw new Error("The rule (or this channel in it) no longer exists");
    const event = getAlertEvent(m.eventKey);
    const doc = event && m.recordId ? await event.load(m.recordId) : null;
    if (!doc) throw new Error("The record this message was about no longer exists");
    const ctx = event.build(doc);

    const recipientCtx = { owner: ctx.owner, vendorId: ctx.vendorId, branchId: ctx.branchId, accessModule: event.branchAccessModule };
    const { targets, skipped } = await StockAlertRecipientService.resolve(m.channel, send.to, { ...recipientCtx, vendorLine: CONTACT_RECIPIENT_TYPE.TO });
    const cc = m.channel === ALERT_CHANNEL.EMAIL && send.cc?.length
      ? (await StockAlertRecipientService.resolve(ALERT_CHANNEL.EMAIL, send.cc, { ...recipientCtx, vendorLine: CONTACT_RECIPIENT_TYPE.CC })).targets.map((t) => t.address)
      : [];

    // Who already has it — the sandbox rewrites `to`, so the real address is in sandboxedFrom.
    const sent = await StockAlertMessageModel.find({
      ruleId: m.ruleId, recordId: m.recordId, channel: m.channel, status: { $nin: [S.SKIPPED, S.FAILED, S.CANCELLED] },
    }).select("to sandboxedFrom").lean();
    const reached = (t) => sent.some((x) => x.to?.address === t.address || String(x.sandboxedFrom || "").includes(t.address));
    const fresh = targets.filter((t) => !reached(t));
    if (!fresh.length) {
      const why = targets.length ? "everyone it finds has already received it" : skipped.map((s) => `${s.name}: ${s.reason}`).join("; ") || "nobody to send to";
      throw new Error(`Still nobody new to send to — ${why}`);
    }

    const settings = await StockAlertSettingsService.get();
    const channelOn = !!settings.channels?.[m.channel]?.enabled;
    const rows = fresh.map((to) =>
      StockAlertDispatcherService.prepareRow(
        {
          trigger: ALERT_TRIGGER.RESEND,
          eventKey: m.eventKey,
          ruleId: m.ruleId,
          ruleName: m.ruleName,
          escalationId: m.escalationId,
          stepIndex: m.stepIndex,
          stepType: m.stepType,
          recordType: m.recordType,
          recordId: m.recordId,
          recordRef: m.recordRef,
          link: m.link,
          channel: m.channel,
          provider: getAlertProvider(m.channel)?.name || "",
          templateId: m.templateId,
          to,
          cc,
          subject: m.subject,
          body: m.body,
          attachments: m.attachments,
          resendOf: m._id,
          triggeredBy: triggeredBySnapshot(actor),
        },
        { settings, channelOn }
      )
    );
    const docs = await StockAlertMessageModel.insertMany(
      rows.map((r) => ({ ...r, log: [{ at: new Date(), event: r.status, detail: r.skipReason || "Tried again after a skip" }] }))
    );
    await StockAuditLogService.recordAudit({ entityType: "alert_messages", entityId: m._id, action: "RESEND", actor, after: { retried: docs.map((d) => d._id) } });
    if (docs.some((d) => d.status === S.QUEUED)) runSender().catch(() => {});
    return { queued: docs.filter((d) => d.status === S.QUEUED).length, skipped: docs.filter((d) => d.status === S.SKIPPED).length, to: fresh.map((t) => t.name) };
  }

  static async cancel(id, actor) {
    const res = await StockAlertMessageModel.findOneAndUpdate(
      { _id: id, status: S.QUEUED },
      {
        $set: { status: S.CANCELLED, nextAttemptAt: null },
        $push: { log: { at: new Date(), event: S.CANCELLED, detail: actor?.name ? `by ${actor.name}` : "" } },
      },
      { new: true }
    );
    if (!res) throw new Error("Only a message still waiting to go can be cancelled");
    return res;
  }

  /**
   * Sends a template, filled with sample values, to one address — bypasses
   * the master switch and the sandbox on purpose: it is how an admin checks a
   * channel works before switching it on.
   */
  static async sendTest(templateId, { to }, actor) {
    const t = await StockAlertTemplateModel.findOne({ _id: templateId, isActive: true }).lean();
    if (!t) throw new Error("Template not found");
    const isEmail = t.channel === ALERT_CHANNEL.EMAIL;
    const address = isEmail ? String(to || "").trim().toLowerCase() : normalizePhone(to);
    if (isEmail ? !EMAIL_RE.test(address) : !address) {
      throw new Error(isEmail ? "Invalid test email" : "Invalid test WhatsApp number — use 10 digits or digits with country code");
    }
    if (!getAlertProvider(t.channel)) throw new Error(`${t.channel} has no sender yet`);
    const rendered = renderAlertTemplate(t, sampleVarsFor(t.eventKey));
    const doc = await StockAlertMessageModel.create({
      trigger: ALERT_TRIGGER.TEST,
      eventKey: t.eventKey,
      recordRef: "TEST",
      channel: t.channel,
      provider: getAlertProvider(t.channel).name,
      templateId: t._id,
      to: { kind: isEmail ? "EMAIL" : "PHONE", address, name: "Test" },
      subject: rendered.subject ? `[TEST] ${rendered.subject}` : "",
      body: isEmail ? rendered.body : `[TEST]\n${rendered.body}`,
      status: S.QUEUED,
      triggeredBy: triggeredBySnapshot(actor),
      log: [{ at: new Date(), event: S.QUEUED, detail: "Send test" }],
    });
    runSender().catch(() => {});
    return doc;
  }

  /** Test a channel itself with a plain line — from the Channels tab. */
  static async sendChannelTest(channel, { to }, actor) {
    const isEmail = channel === ALERT_CHANNEL.EMAIL;
    if (![ALERT_CHANNEL.EMAIL, ALERT_CHANNEL.WHATSAPP].includes(channel)) throw new Error("Invalid channel");
    const address = isEmail ? String(to || "").trim().toLowerCase() : normalizePhone(to);
    if (isEmail ? !EMAIL_RE.test(address) : !address) throw new Error(isEmail ? "Invalid test email" : "Invalid test WhatsApp number");
    const provider = getAlertProvider(channel);
    const text = `Test message from Stock · Alerts & Escalations — ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;
    const doc = await StockAlertMessageModel.create({
      trigger: ALERT_TRIGGER.TEST,
      recordRef: "TEST",
      channel,
      provider: provider.name,
      to: { kind: isEmail ? "EMAIL" : "PHONE", address, name: "Test" },
      subject: isEmail ? "[TEST] Stock alerts are working" : "",
      body: isEmail ? `<p>${text}</p>` : text,
      status: S.QUEUED,
      triggeredBy: triggeredBySnapshot(actor),
      log: [{ at: new Date(), event: S.QUEUED, detail: "Channel test" }],
    });
    runSender().catch(() => {});
    return doc;
  }
}

export class StockAlertEscalationService {
  static async list({ skip = 0, limit = 50, status, eventKey, search } = {}) {
    const filter = {};
    filter.status = status || ALERT_ESCALATION_STATUS.ACTIVE;
    if (status === "ALL") delete filter.status;
    if (eventKey) filter.eventKey = eventKey;
    if (search) {
      const rx = { $regex: escapeRegex(search.trim()), $options: "i" };
      filter.$or = [{ recordRef: rx }, { ruleName: rx }];
    }
    const [data, total] = await Promise.all([
      StockAlertEscalationModel.find(filter)
        .sort(filter.status === ALERT_ESCALATION_STATUS.ACTIVE ? { nextDueAt: 1 } : { updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StockAlertEscalationModel.countDocuments(filter),
    ]);
    return { data, total };
  }

  static async stop(id, reason, actor) {
    const why = String(reason || "").trim() || "Stopped by hand";
    const res = await StockAlertEscalationModel.findOneAndUpdate(
      { _id: id, status: ALERT_ESCALATION_STATUS.ACTIVE },
      {
        $set: { status: ALERT_ESCALATION_STATUS.STOPPED, closedAt: new Date(), closedReason: why, closedBy: triggeredBySnapshot(actor), lockedUntil: null },
        $push: { history: { at: new Date(), event: "STOPPED", detail: `${why}${actor?.name ? ` — ${actor.name}` : ""}` } },
      },
      { new: true }
    );
    if (!res) throw new Error("Only a running escalation can be stopped");
    await StockAuditLogService.recordAudit({ entityType: "alert_escalations", entityId: res._id, action: "STOP", actor, after: { reason: why } });
    return res;
  }
}
