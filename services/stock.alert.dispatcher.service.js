import StockAlertRuleModel from "../models/stock.alert.rule.model.js";
import StockAlertTemplateModel from "../models/stock.alert.template.model.js";
import StockAlertMessageModel, { triggeredBySnapshot } from "../models/stock.alert.message.model.js";
import StockAlertEscalationModel from "../models/stock.alert.escalation.model.js";
import StockAlertSettingsService from "./stock.alert.settings.service.js";
import StockAlertRecipientService from "./stock.alert.recipient.service.js";
import { getAlertEvent } from "../config/alert.event.catalog.js";
import { renderAlertTemplate } from "../helpers/alert.render.helper.js";
import { nextOfficeTime } from "../helpers/alert.office.hours.helper.js";
import { getAlertProvider } from "../helpers/alert.providers/index.js";
import { getLogger } from "../helpers/logger.helper.js";
import {
  ALERT_CHANNEL,
  ALERT_ESCALATION_STATUS,
  ALERT_MESSAGE_STATUS,
  ALERT_RULE_KIND,
  ALERT_TRIGGER,
  CONTACT_RECIPIENT_TYPE,
} from "../constants/stock.enums.js";

const log = getLogger(import.meta.url);
const HOUR = 60 * 60 * 1000;

const fmtDate = (d) =>
  d ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : "";

// Set by the worker so a freshly queued message goes out now, not at the next tick.
let kickSender = () => {};
export const setSenderKick = (fn) => {
  kickSender = fn;
};

/*
  Does this record fall under the rule? Empty condition = no restriction.
  A branch condition on a record that has no branch (quotations) never
  matches — better silent than sent to the wrong branch's team.
*/
export const matchesConditions = (rule, ctx) => {
  const c = rule.conditions || {};
  if (c.branchIds?.length && !(ctx.branchId && c.branchIds.map(String).includes(String(ctx.branchId)))) return false;
  if (c.vendorIds?.length && !c.vendorIds.map(String).some((v) => (ctx.vendorIds || []).includes(v))) return false;
  if (c.minAmount !== null && c.minAmount !== undefined && Number(ctx.amount || 0) < Number(c.minAmount)) return false;
  return true;
};

export default class StockAlertDispatcherService {
  /**
   * An event happened. Call AFTER the record is committed; never awaited for
   * the user's sake and never throws — a broken alert must not fail, or even
   * slow down, the work it is about.
   */
  static emit(eventKey, recordId, { actor } = {}) {
    StockAlertDispatcherService.handleEvent(eventKey, recordId, { actor }).catch((err) =>
      log.error(`Alert event ${eventKey} for ${recordId} failed: ${err.message}`)
    );
  }

  static async handleEvent(eventKey, recordId, { actor } = {}) {
    const event = getAlertEvent(eventKey);
    if (!event) throw new Error(`Unknown alert event ${eventKey}`);
    if (event.kind === "MANUAL") return { rules: 0 };

    const rules = await StockAlertRuleModel.find({
      isActive: true,
      enabled: true,
      kind: ALERT_RULE_KIND.AUTOMATIC,
      eventKey,
    }).lean();
    if (!rules.length) return { rules: 0 };

    const doc = await event.load(recordId);
    if (!doc) return { rules: 0 };
    const ctx = { ...event.build(doc), recordId: doc._id };
    const now = new Date();

    let fired = 0;
    for (const rule of rules) {
      if (!matchesConditions(rule, ctx)) continue;
      fired += 1;

      // The same event again on the same record (rejected → resent) starts a
      // fresh cycle: the old chain is closed, not continued.
      await StockAlertEscalationModel.updateMany(
        { ruleId: rule._id, recordId: doc._id, status: ALERT_ESCALATION_STATUS.ACTIVE },
        {
          $set: { status: ALERT_ESCALATION_STATUS.RESOLVED, closedAt: now, closedReason: "Event happened again — new cycle" },
          $push: { history: { at: now, event: "RESOLVED", detail: "Event happened again — new cycle" } },
        }
      );

      let escalation = null;
      const hasLaterSteps = rule.steps.length > 1;
      if (hasLaterSteps && event.isPending && event.isPending(doc)) {
        const settings = await StockAlertSettingsService.get();
        escalation = await StockAlertEscalationModel.create({
          ruleId: rule._id,
          ruleName: rule.name,
          eventKey,
          recordType: event.recordType,
          recordId: doc._id,
          recordRef: ctx.ref,
          startedAt: now,
          nextStepIndex: 1,
          nextDueAt: nextOfficeTime(new Date(now.getTime() + rule.steps[1].afterHours * HOUR), settings.officeHours),
          history: [{ at: now, stepIndex: 0, event: "STARTED", detail: event.pendingLabel }],
        });
      }

      await StockAlertDispatcherService.enqueueStep({
        rule,
        stepIndex: 0,
        event,
        ctx,
        trigger: ALERT_TRIGGER.EVENT,
        escalation,
        actor,
      });
    }
    return { rules: fired };
  }

  /**
   * Writes one step's messages into the log (QUEUED or SKIPPED) and wakes the
   * sender. Rendering happens here, once — the log keeps the exact text.
   */
  static async enqueueStep({ rule, stepIndex, event, ctx, trigger, escalation = null, actor = null }) {
    const step = rule.steps[stepIndex];
    if (!step || !step.enabled) return { queued: 0, skipped: 0 };

    const settings = await StockAlertSettingsService.get();
    const startedAt = escalation?.startedAt || new Date();
    const vars = {
      ...ctx.vars,
      recordRef: ctx.ref,
      link: ctx.link,
      pendingSince: fmtDate(startedAt),
      pendingFor: String(Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / HOUR))),
    };

    const rows = [];
    const base = {
      trigger,
      eventKey: event.key,
      ruleId: rule._id,
      ruleName: rule.name,
      escalationId: escalation?._id || null,
      stepIndex,
      stepType: step.type,
      recordType: event.recordType,
      recordId: ctx.recordId || null,
      recordRef: ctx.ref,
      link: ctx.link || "",
      triggeredBy: triggeredBySnapshot(actor),
    };

    for (const send of step.sends.filter((s) => s.enabled !== false)) {
      const template = await StockAlertTemplateModel.findOne({ _id: send.templateId, isActive: true }).lean();
      const provider = getAlertProvider(send.channel);
      const channelOn = !!settings.channels?.[send.channel]?.enabled;
      const common = { ...base, channel: send.channel, provider: provider?.name || "", templateId: send.templateId };

      if (!template) {
        rows.push({ ...common, to: { kind: "NONE", name: "—" }, status: ALERT_MESSAGE_STATUS.SKIPPED, skipReason: "template was removed" });
        continue;
      }
      const rendered = renderAlertTemplate(template, vars);
      const attachments = template.attachDocument && ctx.document ? [ctx.document] : [];

      const recipientCtx = { owner: ctx.owner, vendorId: ctx.vendorId, branchId: ctx.branchId, accessModule: event.branchAccessModule };
      const { targets, skipped } = await StockAlertRecipientService.resolve(send.channel, send.to, {
        ...recipientCtx,
        vendorLine: CONTACT_RECIPIENT_TYPE.TO,
      });
      const cc =
        send.channel === ALERT_CHANNEL.EMAIL && send.cc?.length
          ? (await StockAlertRecipientService.resolve(ALERT_CHANNEL.EMAIL, send.cc, { ...recipientCtx, vendorLine: CONTACT_RECIPIENT_TYPE.CC })).targets.map((t) => t.address)
          : [];

      skipped.forEach((s) =>
        rows.push({ ...common, to: { kind: "NONE", name: s.name }, status: ALERT_MESSAGE_STATUS.SKIPPED, skipReason: s.reason, subject: rendered.subject, body: rendered.body })
      );

      for (const target of targets) {
        rows.push(
          StockAlertDispatcherService.prepareRow({
            ...common,
            to: target,
            cc,
            subject: rendered.subject,
            body: rendered.body,
            attachments,
          }, { settings, channelOn })
        );
      }
    }

    if (!rows.length) return { queued: 0, skipped: 0 };
    const docs = await StockAlertMessageModel.insertMany(
      rows.map((r) => ({ ...r, log: [{ at: new Date(), event: r.status, detail: r.skipReason || "" }] }))
    );
    const queued = docs.filter((d) => d.status === ALERT_MESSAGE_STATUS.QUEUED).length;
    if (queued) kickSender();
    return { queued, skipped: docs.length - queued, messageIds: docs.map((d) => d._id) };
  }

  /**
   * Applies the master switch and the sandbox to one message about to be
   * logged. Shared by rules, manual sends and resends so all three behave the
   * same.
   */
  static prepareRow(row, { settings, channelOn, ignoreSwitch = false, ignoreSandbox = false }) {
    if (!ignoreSwitch && !channelOn) {
      return { ...row, status: ALERT_MESSAGE_STATUS.SKIPPED, skipReason: `${row.channel} is switched off` };
    }
    if (!getAlertProvider(row.channel)) {
      return { ...row, status: ALERT_MESSAGE_STATUS.SKIPPED, skipReason: `${row.channel} has no sender yet` };
    }
    // The bell only ever reaches our own logged-in people — no sandbox needed.
    if (!ignoreSandbox && settings.sandbox?.enabled && row.channel !== ALERT_CHANNEL.IN_APP) {
      const isEmail = row.channel === ALERT_CHANNEL.EMAIL;
      const testAddress = isEmail ? settings.sandbox.email : settings.sandbox.phone;
      if (!testAddress) {
        return {
          ...row,
          status: ALERT_MESSAGE_STATUS.SKIPPED,
          skipReason: `Sandbox is on but no test ${isEmail ? "email" : "WhatsApp number"} is set`,
        };
      }
      return {
        ...row,
        sandboxedFrom: `${row.to.name ? `${row.to.name} · ` : ""}${row.to.address}${row.cc?.length ? ` (cc ${row.cc.join(", ")})` : ""}`,
        to: { kind: isEmail ? "EMAIL" : "PHONE", address: testAddress, name: "Sandbox", contactId: null },
        cc: [],
        status: ALERT_MESSAGE_STATUS.QUEUED,
      };
    }
    return { ...row, status: ALERT_MESSAGE_STATUS.QUEUED };
  }

  /**
   * Re-checks every running chain of a record right away, so the
   * Escalations tab shows RESOLVED the moment the work is done instead of at
   * the chain's next step. Safe to call after any status change.
   */
  static refresh(recordId) {
    StockAlertDispatcherService.resolveSettled({ recordId }).catch((err) =>
      log.error(`Alert refresh for ${recordId} failed: ${err.message}`)
    );
  }

  static async resolveSettled({ recordId = null, limit = 200 } = {}) {
    const filter = { status: ALERT_ESCALATION_STATUS.ACTIVE };
    if (recordId) filter.recordId = recordId;
    const chains = await StockAlertEscalationModel.find(filter).limit(limit).lean();
    let resolved = 0;
    for (const chain of chains) {
      const event = getAlertEvent(chain.eventKey);
      const doc = event ? await event.load(chain.recordId) : null;
      let status = null;
      let reason = "";
      if (!event || !doc) {
        status = ALERT_ESCALATION_STATUS.CANCELLED;
        reason = "Record no longer exists";
      } else if (!event.isPending || !event.isPending(doc)) {
        status = ALERT_ESCALATION_STATUS.RESOLVED;
        reason = "Work done";
      }
      if (!status) continue;
      const res = await StockAlertEscalationModel.updateOne(
        { _id: chain._id, status: ALERT_ESCALATION_STATUS.ACTIVE },
        {
          $set: { status, closedAt: new Date(), closedReason: reason },
          $push: { history: { at: new Date(), event: status, detail: reason } },
        }
      );
      resolved += res.modifiedCount;
    }
    return resolved;
  }
}

export const emitAlertEvent = StockAlertDispatcherService.emit;
export const refreshAlerts = StockAlertDispatcherService.refresh;
