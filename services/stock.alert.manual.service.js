import StockAlertRuleModel from "../models/stock.alert.rule.model.js";
import StockAlertTemplateModel from "../models/stock.alert.template.model.js";
import StockAlertMessageModel, { triggeredBySnapshot } from "../models/stock.alert.message.model.js";
import StockAlertSettingsService from "./stock.alert.settings.service.js";
import StockAlertRecipientService from "./stock.alert.recipient.service.js";
import StockAlertDispatcherService from "./stock.alert.dispatcher.service.js";
import { getAlertEvent } from "../config/alert.event.catalog.js";
import { renderAlertTemplate } from "../helpers/alert.render.helper.js";
import { getAlertProvider } from "../helpers/alert.providers/index.js";
import {
  ALERT_CHANNEL,
  ALERT_MESSAGE_STATUS as S,
  ALERT_RECIPIENT_TYPE,
  ALERT_RULE_KIND,
  ALERT_TRIGGER,
  CONTACT_RECIPIENT_TYPE,
} from "../constants/stock.enums.js";

/*
  Manual sends — a person presses Send on a record's screen (PO → vendor).

  A MANUAL rule never fires on its own. It only decides what the dialog
  starts with: the template (subject, text, PDF) and our own CC list. The
  person sees it, may change To/CC, and presses Send; the mail then goes out
  RIGHT AWAY, not through the queue, because the dialog waits for the answer
  — exactly as the old PO "Send Mail" did. It is still logged in the Message
  Log like any other message, and the master switch and sandbox still apply.

  Which rule: one whose Vendor condition names this record's vendor wins over
  one without a vendor condition (what the old per-vendor Notification did).
  No rule at all → a plain built-in text, so sending never depends on setup.
*/
const FALLBACK = {
  PO_SEND_TO_VENDOR: {
    subject: "Purchase Order {{poNumber}}",
    body: "<p>Please find attached Purchase Order <strong>{{poNumber}}</strong>.</p>",
    attachDocument: true,
  },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default class StockAlertManualService {
  static async pickRule(eventKey, ctx) {
    const rules = await StockAlertRuleModel.find({
      isActive: true,
      enabled: true,
      kind: ALERT_RULE_KIND.MANUAL,
      eventKey,
    })
      .sort({ updatedAt: -1 })
      .lean();
    const vendorIds = (ctx.vendorIds || []).map(String);
    return (
      rules.find((r) => (r.conditions?.vendorIds || []).some((v) => vendorIds.includes(String(v)))) ||
      rules.find((r) => !(r.conditions?.vendorIds || []).length) ||
      null
    );
  }

  /** What the dialog shows before Send: subject, text, our CC, who it goes to. */
  static async prepare(eventKey, recordId) {
    const event = getAlertEvent(eventKey);
    if (!event || event.kind !== "MANUAL") throw new Error("Invalid manual event");
    const doc = await event.load(recordId);
    if (!doc) throw new Error(`${event.recordType} not found`);
    const ctx = { ...event.build(doc), recordId: doc._id };

    const rule = await StockAlertManualService.pickRule(eventKey, ctx);
    const send = rule?.steps?.[0]?.sends?.find((s) => s.channel === ALERT_CHANNEL.EMAIL && s.enabled !== false) || null;
    const template = send ? await StockAlertTemplateModel.findOne({ _id: send.templateId, isActive: true }).lean() : null;
    const source = template || { channel: ALERT_CHANNEL.EMAIL, ...FALLBACK[eventKey] };
    const rendered = renderAlertTemplate(source, { ...ctx.vars, recordRef: ctx.ref, link: ctx.link, pendingSince: "", pendingFor: "" });

    // Our own CC from the rule. VENDOR on the CC line means the vendor's CC
    // contacts — the dialog already lists those itself, so they are left out
    // here and only OUR people come back as "internal CC".
    const internal = (send?.cc || []).filter((r) => r.type !== ALERT_RECIPIENT_TYPE.VENDOR);
    const { targets } = await StockAlertRecipientService.resolve(ALERT_CHANNEL.EMAIL, internal, {
      owner: ctx.owner,
      vendorId: ctx.vendorId,
      vendorLine: CONTACT_RECIPIENT_TYPE.CC,
    });

    const settings = await StockAlertSettingsService.get();
    return {
      ruleId: rule?._id || null,
      ruleName: rule?.name || "",
      templateId: template?._id || null,
      subject: rendered.subject,
      body: rendered.body,
      attachment: source.attachDocument && ctx.document ? ctx.document.fileName : null,
      internalCc: targets.map((t) => t.address),
      emailEnabled: !!settings.channels?.EMAIL?.enabled,
      sandbox: settings.sandbox?.enabled ? { email: settings.sandbox.email || "" } : null,
      _ctx: ctx,
      _attachDocument: !!source.attachDocument,
    };
  }

  /**
   * Sends now and answers with the outcome. Throws (with a message the
   * dialog can show) when nothing went out, so the caller records nothing.
   */
  static async sendNow(eventKey, recordId, { to = [], cc = [], actor = null } = {}) {
    const prepared = await StockAlertManualService.prepare(eventKey, recordId);
    const event = getAlertEvent(eventKey);
    const ctx = prepared._ctx;

    const toList = [...new Set(to.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))];
    const ccList = [...new Set(cc.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))].filter((x) => !toList.includes(x));
    if (!toList.length) throw new Error("Add at least one recipient on the To line");
    const bad = [...toList, ...ccList].find((x) => !EMAIL_RE.test(x));
    if (bad) throw new Error(`Invalid email: ${bad}`);

    const settings = await StockAlertSettingsService.get();
    const provider = getAlertProvider(ALERT_CHANNEL.EMAIL);
    const row = StockAlertDispatcherService.prepareRow(
      {
        trigger: ALERT_TRIGGER.MANUAL,
        eventKey,
        ruleId: prepared.ruleId,
        ruleName: prepared.ruleName || "Built-in text",
        recordType: event.recordType,
        recordId: ctx.recordId,
        recordRef: ctx.ref,
        channel: ALERT_CHANNEL.EMAIL,
        provider: provider?.name || "",
        templateId: prepared.templateId,
        to: { kind: "EMAIL", address: toList.join(", "), name: ctx.vars.vendorName || "" },
        cc: ccList,
        subject: prepared.subject,
        body: prepared.body,
        attachments: prepared._attachDocument && ctx.document ? [ctx.document] : [],
        triggeredBy: triggeredBySnapshot(actor),
      },
      { settings, channelOn: !!settings.channels?.EMAIL?.enabled }
    );
    // A manual send that would be skipped is refused instead: the person is
    // waiting for "sent", and a silent skip would record a mail that never left.
    if (row.status === S.SKIPPED) {
      throw new Error(
        /switched off/.test(row.skipReason)
          ? "Email is switched off in Alerts & Escalations → Channels"
          : `Not sent: ${row.skipReason}. Set it in Alerts & Escalations → Channels.`
      );
    }

    const msg = await StockAlertMessageModel.create({
      ...row,
      status: S.SENDING,
      attempts: 1,
      log: [{ at: new Date(), event: "SENDING", detail: `Manual send${actor?.name ? ` by ${actor.name}` : ""}` }],
    });
    try {
      const result = await provider.send(msg);
      msg.status = S.SENT;
      msg.sentAt = new Date();
      msg.providerMessageId = result.providerMessageId || "";
      msg.note(S.SENT);
      await msg.save();
    } catch (err) {
      msg.status = S.FAILED;
      msg.lastError = err.message;
      msg.note(S.FAILED, err.message);
      await msg.save();
      throw new Error(`The mail could not be sent: ${err.message}`);
    }
    return {
      messageId: msg._id,
      ruleId: prepared.ruleId,
      to: toList,
      cc: ccList,
      sandboxedTo: row.sandboxedFrom ? row.to.address : null,
    };
  }
}
