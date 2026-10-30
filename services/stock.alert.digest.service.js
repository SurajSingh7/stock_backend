import StockAlertEscalationModel from "../models/stock.alert.escalation.model.js";
import StockAlertRuleModel from "../models/stock.alert.rule.model.js";
import StockAlertSettingsModel from "../models/stock.alert.settings.model.js";
import StockAlertMessageModel from "../models/stock.alert.message.model.js";
import StockAlertSettingsService from "./stock.alert.settings.service.js";
import StockAlertRecipientService from "./stock.alert.recipient.service.js";
import StockAlertDispatcherService, { matchesConditions } from "./stock.alert.dispatcher.service.js";
import StockLowStockStateModel from "../models/stock.low.stock.state.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockBranchModel from "../models/stock.branch.model.js";
import { getAlertEvent, lowStockLine } from "../config/alert.event.catalog.js";
import { getAlertProvider } from "../helpers/alert.providers/index.js";
import {
  ALERT_CHANNEL,
  ALERT_ESCALATION_STATUS,
  ALERT_MESSAGE_STATUS,
  ALERT_TRIGGER,
  CONTACT_RECIPIENT_TYPE,
} from "../constants/stock.enums.js";

/*
  The morning summary.

  Twenty separate reminders a day teach people to ignore the channel. So once
  a day everyone who is on the FIRST step of a rule with a running chain gets
  ONE WhatsApp listing everything still waiting on them, grouped by rule.

  Built from the Escalations collection (ACTIVE chains only) — the same truth
  the Escalations tab shows, so the summary and the screen never disagree.
  Rows go through prepareRow, so the master switch and sandbox apply as usual.
  Low stock rides along: each branch's products still LOW / OUT get a section
  of their own (see _addLowStock).
*/
const IST_OFFSET_MS = 330 * 60 * 1000;
const PER_RULE = 6;

export const istToday = (d = new Date()) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const istHHMM = (d = new Date()) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(11, 16);
const hoursSince = (d) => Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 3600000));

export default class StockAlertDigestService {
  /** Called every minute by the worker: sends once per day at the set time. */
  static async runIfDue() {
    const s = await StockAlertSettingsService.get();
    if (!s.digest?.enabled) return null;
    const today = istToday();
    if (s.digest.lastSentOn === today || istHHMM() < (s.digest.time || "10:00")) return null;
    // Claim today — a second worker gets modifiedCount 0 and stops.
    const claim = await StockAlertSettingsModel.updateOne(
      { key: "global", "digest.lastSentOn": { $ne: today } },
      { $set: { "digest.lastSentOn": today } }
    );
    StockAlertSettingsService.invalidate();
    if (!claim.modifiedCount) return null;
    return StockAlertDigestService.send();
  }

  /** Builds and queues today's summaries. Also used by "Send summary now". */
  static async send({ actor = null } = {}) {
    const chains = await StockAlertEscalationModel.find({ status: ALERT_ESCALATION_STATUS.ACTIVE })
      .sort({ startedAt: 1 })
      .lean();

    const rules = await StockAlertRuleModel.find({ _id: { $in: [...new Set(chains.map((c) => String(c.ruleId)))] }, isActive: true, enabled: true }).lean();
    const ruleById = new Map(rules.map((r) => [String(r._id), r]));

    // address → { target, sections: Map(ruleName → [lines]) }
    const people = new Map();
    const addLine = (t, section, line) => {
      const key = `${t.kind}:${t.address}`;
      if (!people.has(key)) people.set(key, { target: t, sections: new Map() });
      const p = people.get(key);
      if (!p.sections.has(section)) p.sections.set(section, []);
      const list = p.sections.get(section);
      if (!list.includes(line)) list.push(line);
    };
    for (const chain of chains) {
      const rule = ruleById.get(String(chain.ruleId));
      if (!rule) continue;
      const sends = (rule.steps[0]?.sends || []).filter((x) => x.enabled !== false && x.channel === ALERT_CHANNEL.WHATSAPP);
      if (!sends.length) continue;

      const event = getAlertEvent(chain.eventKey);
      const doc = event ? await event.load(chain.recordId) : null;
      if (!doc || !event.isPending?.(doc)) continue; // done since the last sweep
      const ctx = event.build(doc);
      const line = `• ${chain.recordRef}${ctx.vars.vendorName || ctx.vars.vendorNames ? ` · ${ctx.vars.vendorName || ctx.vars.vendorNames}` : ""}${ctx.vars.amount ? ` · ${ctx.vars.amount}` : ""} · ${hoursSince(chain.startedAt)} h`;

      for (const send of sends) {
        const { targets } = await StockAlertRecipientService.resolve(ALERT_CHANNEL.WHATSAPP, send.to, {
          owner: ctx.owner,
          vendorId: ctx.vendorId,
          vendorLine: CONTACT_RECIPIENT_TYPE.TO,
        });
        targets.forEach((t) => addLine(t, rule.name, line));
      }
    }
    await StockAlertDigestService._addLowStock(addLine);
    if (!people.size) return { people: 0, items: 0 };

    const settings = await StockAlertSettingsService.get();
    const provider = getAlertProvider(ALERT_CHANNEL.WHATSAPP);
    const dateLabel = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
    const appUrl = (process.env.APP_PUBLIC_URL || "http://localhost:3000").trim().replace(/\/+$/, "");

    let items = 0;
    const rows = [];
    for (const { target, sections } of people.values()) {
      const parts = [`🗓️ *Pending work — ${dateLabel}*`];
      for (const [ruleName, lines] of sections) {
        items += lines.length;
        parts.push("", `*${ruleName}* (${lines.length})`, ...lines.slice(0, PER_RULE));
        if (lines.length > PER_RULE) parts.push(`…and ${lines.length - PER_RULE} more`);
      }
      parts.push("", `👉 ${appUrl}`);
      rows.push(
        StockAlertDispatcherService.prepareRow(
          {
            trigger: ALERT_TRIGGER.DIGEST,
            eventKey: "",
            recordRef: "SUMMARY",
            channel: ALERT_CHANNEL.WHATSAPP,
            provider: provider?.name || "",
            to: target,
            cc: [],
            subject: "",
            body: parts.join("\n"),
            triggeredBy: actor ? { name: actor.name || "" } : null,
          },
          { settings, channelOn: !!settings.channels?.WHATSAPP?.enabled }
        )
      );
    }
    await StockAlertMessageModel.insertMany(
      rows.map((r) => ({ ...r, log: [{ at: new Date(), event: r.status, detail: r.skipReason || "Morning summary" }] }))
    );
    if (rows.some((r) => r.status === ALERT_MESSAGE_STATUS.QUEUED)) {
      const { runSender } = await import("./stock.alert.worker.js");
      runSender().catch(() => {});
    }
    return { people: rows.length, items };
  }

  /*
    What is still LOW or OUT, one section per branch, to the WhatsApp
    recipients of each enabled LOW_STOCK rule's first message — resolved per
    branch, so "people with access to the branch" hear only about theirs.
    Read from the state table: exactly what the alerts have already said.
  */
  static async _addLowStock(addLine) {
    const lowRules = await StockAlertRuleModel.find({ isActive: true, enabled: true, eventKey: "LOW_STOCK" }).lean();
    const sends = lowRules.flatMap((rule) =>
      (rule.steps[0]?.sends || [])
        .filter((x) => x.enabled !== false && x.channel === ALERT_CHANNEL.WHATSAPP)
        .map((send) => ({ rule, send }))
    );
    if (!sends.length) return;

    const states = await StockLowStockStateModel.find({}).lean();
    if (!states.length) return;
    const [products, branches] = await Promise.all([
      StockProductDefinitionModel.find({ _id: { $in: [...new Set(states.map((s) => String(s.productDefinitionId)))] } }).select("name unit").lean(),
      StockBranchModel.find({ _id: { $in: [...new Set(states.map((s) => String(s.branchId)))] }, isActive: true }).select("name").lean(),
    ]);
    const productBy = new Map(products.map((p) => [String(p._id), p]));
    const branchBy = new Map(branches.map((b) => [String(b._id), b]));

    const byBranch = new Map();
    for (const s of states) {
      const product = productBy.get(String(s.productDefinitionId));
      const branch = branchBy.get(String(s.branchId));
      if (!product || !branch) continue;
      const k = String(s.branchId);
      if (!byBranch.has(k)) byBranch.set(k, { branch, items: [] });
      byBranch.get(k).items.push({ productName: product.name, unit: product.unit, available: s.available, threshold: s.threshold, level: s.level });
    }

    const event = getAlertEvent("LOW_STOCK");
    for (const [branchId, { branch, items }] of byBranch) {
      items.sort((a, b) => (a.level === b.level ? a.productName.localeCompare(b.productName) : a.level === "OUT" ? -1 : 1));
      const section = `Low stock · ${branch.name}`;
      for (const { rule, send } of sends) {
        if (!matchesConditions(rule, { branchId })) continue;
        const { targets } = await StockAlertRecipientService.resolve(ALERT_CHANNEL.WHATSAPP, send.to, {
          branchId,
          accessModule: event?.branchAccessModule,
        });
        targets.forEach((t) => items.forEach((it) => addLine(t, section, lowStockLine(it))));
      }
    }
  }
}
