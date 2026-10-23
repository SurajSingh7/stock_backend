/*
  Sample data for Alerts & Escalations — so the screens open with something
  real to look at and edit.

    node scripts/seed-alert-test-data.js

  Safe to run again: anything that already exists by name is left alone.
  Contacts carry fake numbers (9190000000xx) and @example.com emails, and
  every row is marked "Sample" — edit them to real people before switching
  sandbox off. Sandbox is switched ON here and nothing reaches a real person
  while it stays on.
*/
import mongoose from "mongoose";
import dotenv from "dotenv";
import StockAlertSettingsModel from "../models/stock.alert.settings.model.js";
import StockAlertContactModel from "../models/stock.alert.contact.model.js";
import StockAlertGroupModel from "../models/stock.alert.group.model.js";
import StockAlertTemplateModel from "../models/stock.alert.template.model.js";
import StockAlertRuleModel from "../models/stock.alert.rule.model.js";
import { StockAlertContactService, StockAlertGroupService } from "../services/stock.alert.contact.service.js";
import StockAlertTemplateService from "../services/stock.alert.template.service.js";
import StockAlertRuleService from "../services/stock.alert.rule.service.js";

dotenv.config();

const SAMPLE = "Sample — edit me";

const CONTACTS = [
  { key: "ramesh", name: "Ramesh Kumar", designation: "Purchase Executive", phone: "919000000001", whatsappNumber: "919000000101", email: "ramesh@example.com" },
  { key: "neha", name: "Neha Singh", designation: "Purchase Executive", phone: "919000000002", email: "neha@example.com" },
  { key: "suresh", name: "Suresh Verma", designation: "Purchase Head", phone: "919000000003", email: "suresh@example.com" },
  { key: "priya", name: "Priya Sharma", designation: "Accounts", phone: "919000000004", email: "priya@example.com" },
  { key: "anil", name: "Anil Gupta", designation: "Accounts Head", phone: "919000000005", email: "anil@example.com" },
  { key: "kavita", name: "Kavita Rao", designation: "Approvals", phone: "919000000006", email: "kavita@example.com" },
  { key: "manoj", name: "Manoj Yadav", designation: "Store In-charge", phone: "919000000007", email: "manoj@example.com" },
  { key: "director", name: "Rajesh Mehta", designation: "Director", phone: "919000000008", email: "director@example.com" },
  { key: "md", name: "Vikram Malhotra", designation: "Managing Director", phone: "919000000009", email: "md@example.com" },
];

const GROUPS = [
  { key: "purchase", name: "Purchase Team", members: ["ramesh", "neha"] },
  { key: "accounts", name: "Accounts Team", members: ["priya"] },
  { key: "approvals", name: "Approvals Team", members: ["kavita"] },
  { key: "store", name: "Store Team", members: ["manoj"] },
];

// What each Tier 1 event's messages say — first message, reminder, escalation.
const TIER1 = {
  QUOTATION_CREATED: {
    title: "Quotation approval pending",
    line: "{{quotationNo}} · {{vendorNames}}\n{{categoryCount}} categories · {{amount}}",
    team: "purchase", head: "suresh", rule: "Quotation approval",
  },
  PO_GENERATED: {
    title: "PO review pending",
    line: "{{poNumber}} · {{vendorName}} · {{amount}}\nEntity: {{entity}}",
    team: "purchase", head: "suresh", rule: "PO review",
  },
  INVOICE_SUBMITTED: {
    title: "Invoice approval pending",
    line: "{{invoiceNumber}} · {{vendorName}} · {{amount}}\nInvoice date {{invoiceDate}}",
    team: "store", head: "suresh", rule: "Invoice approval",
  },
  PAYMENT_APPROVAL_REQUESTED: {
    title: "Payment approval pending",
    line: "{{invoiceNumber}} · {{vendorName}}\nPayable {{payable}} · sent by {{sentBy}}",
    team: "approvals", head: "anil", rule: "Payment approval",
  },
  DEBIT_NOTE_RAISED: {
    title: "Debit note review pending",
    line: "{{debitNoteNo}} on {{invoiceNumber}} · {{vendorName}}\n{{amount}} — {{reason}}",
    team: "accounts", head: "anil", rule: "Debit note review",
  },
  DEBIT_NOTE_SENT_FOR_APPROVAL: {
    title: "Debit note approval pending",
    line: "{{debitNoteNo}} on {{invoiceNumber}} · {{vendorName}}\n{{amount}} — {{reason}}",
    team: "approvals", head: "anil", rule: "Debit note approval",
  },
};

// Tier 2 — back to whoever made it.
const TIER2 = {
  QUOTATION_REJECTED: { title: "Quotation sent back", line: "{{quotationNo}} — {{status}}\nRejected: {{rejectedCategories}}\n{{rejectedRemarks}}", rule: "Quotation rejected → creator" },
  PO_REJECTED: { title: "PO rejected", line: "{{poNumber}} · {{vendorName}}\nReason: {{rejectedReason}}\nEdit it and regenerate.", rule: "PO rejected → creator" },
  INVOICE_REJECTED: { title: "Invoice rejected", line: "{{invoiceNumber}} · {{vendorName}}\nReason: {{rejectedReason}}", rule: "Invoice rejected → creator" },
  PAYMENT_APPROVAL_REJECTED: { title: "Payment approval rejected", line: "{{invoiceNumber}} · {{vendorName}} · {{payable}}\nReason: {{rejectedReason}}\nAdjust and send again.", rule: "Payment rejected → accounts" },
  DEBIT_NOTE_REVIEW_REJECTED: { title: "Debit note sent back", line: "{{debitNoteNo}} on {{invoiceNumber}}\nReason: {{rejectedReason}}", rule: "Debit note sent back → creator" },
};

const ensure = async (Model, filter, create) => {
  const found = await Model.findOne({ ...filter, isActive: true }).lean();
  if (found) return { doc: found, created: false };
  return { doc: await create(), created: true };
};

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const made = { contacts: 0, groups: 0, templates: 0, rules: 0 };

  await StockAlertSettingsModel.updateOne(
    { key: "global" },
    {
      $setOnInsert: {
        key: "global",
        channels: { EMAIL: { enabled: true }, WHATSAPP: { enabled: true }, IN_APP: { enabled: false } },
        sandbox: { enabled: true, email: "", phone: "" },
        officeHours: { enabled: true, days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "19:00" },
      },
    },
    { upsert: true }
  );

  const contact = {};
  for (const c of CONTACTS) {
    const { key, ...data } = c;
    const r = await ensure(StockAlertContactModel, { name: data.name }, () =>
      StockAlertContactService.create({ ...data, type: "INTERNAL", note: SAMPLE }, null)
    );
    contact[key] = r.doc._id;
    made.contacts += r.created ? 1 : 0;
  }

  const group = {};
  for (const g of GROUPS) {
    const r = await ensure(StockAlertGroupModel, { name: g.name }, () =>
      StockAlertGroupService.create({ name: g.name, type: "LIST", description: SAMPLE, members: g.members.map((m) => contact[m]) }, null)
    );
    group[g.key] = r.doc._id;
    made.groups += r.created ? 1 : 0;
  }

  const template = async (name, eventKey, channel, body, extra = {}) => {
    const r = await ensure(StockAlertTemplateModel, { name, eventKey, channel }, () =>
      StockAlertTemplateService.create({ name, eventKey, channel, body, ...extra }, null)
    );
    made.templates += r.created ? 1 : 0;
    return r.doc._id;
  };
  const rule = async (name, eventKey, steps, extra = {}) => {
    const r = await ensure(StockAlertRuleModel, { name }, () =>
      StockAlertRuleService.create({ name, eventKey, description: SAMPLE, steps, ...extra }, null)
    );
    made.rules += r.created ? 1 : 0;
  };
  const wa = (templateId, to) => ({ channel: "WHATSAPP", templateId, to });
  const g = (key) => ({ type: "GROUP", refId: group[key] });
  const c = (key) => ({ type: "CONTACT", refId: contact[key] });

  for (const [eventKey, t] of Object.entries(TIER1)) {
    const first = await template(`${t.title}`, eventKey, "WHATSAPP",
      `🔔 *${t.title}*\n${t.line}\nCreated by {{createdBy}}, {{createdAt}}\n\n👉 Open: {{link}}`);
    const reminder = await template(`${t.title} — reminder`, eventKey, "WHATSAPP",
      `⏰ *Reminder: ${t.title.toLowerCase()}*\n{{recordRef}} is waiting for {{pendingFor}} h (since {{pendingSince}}).\n\n👉 {{link}}`);
    const escalation = await template(`${t.title} — escalation`, eventKey, "WHATSAPP",
      `⚠️ *Escalation: ${t.title.toLowerCase()}*\n${t.line}\nNo action for {{pendingFor}} h. Created by {{createdBy}}.\n\n👉 {{link}}`);

    await rule(t.rule, eventKey, [
      { type: "INITIAL", sends: [wa(first, [g(t.team)])] },
      { type: "REMINDER", afterHours: 4, sends: [wa(reminder, [g(t.team)])] },
      { type: "REMINDER", afterHours: 4, sends: [wa(reminder, [g(t.team)])] },
      { type: "ESCALATION", afterHours: 16, sends: [wa(escalation, [c(t.head), c("director")])] },
      // MD is OFF to start with — switch on in the rule when wanted.
      { type: "ESCALATION", afterHours: 24, enabled: false, sends: [wa(escalation, [c("md")])] },
    ]);
  }

  for (const [eventKey, t] of Object.entries(TIER2)) {
    const tpl = await template(t.title, eventKey, "WHATSAPP", `↩️ *${t.title}*\n${t.line}\n\n👉 {{link}}`);
    const to = eventKey === "PAYMENT_APPROVAL_REJECTED" ? [{ type: "CREATOR" }, g("accounts")] : [{ type: "CREATOR" }];
    const steps = [{ type: "INITIAL", sends: [wa(tpl, to)] }];
    // One nudge a day later for the ones that wait on a resubmit.
    if (eventKey !== "QUOTATION_REJECTED") {
      steps.push({ type: "REMINDER", afterHours: 24, sends: [wa(tpl, to)] });
    }
    await rule(t.rule, eventKey, steps);
  }

  // The one Email: PO to the vendor, with the PDF (used from the PO screen in phase 4).
  const poMail = await template("Purchase Order to vendor", "PO_SEND_TO_VENDOR", "EMAIL",
    `<p>Dear {{vendorName}},</p>
<p>Please find attached Purchase Order <strong>{{poNumber}}</strong> for {{amount}}.</p>
<p>Kindly confirm receipt and share the dispatch schedule.</p>
<p>Regards,<br>Purchase Team · {{entity}}</p>`,
    { subject: "Purchase Order {{poNumber}} — {{entity}}", attachDocument: true });
  await rule("PO to vendor (email)", "PO_SEND_TO_VENDOR", [
    { type: "INITIAL", sends: [{ channel: "EMAIL", templateId: poMail, to: [{ type: "VENDOR" }], cc: [{ type: "VENDOR" }, g("purchase")] }] },
  ]);

  // ── Website bell (phase 5): an In-App line on every sample rule's first
  // message, to the same people. Added to rules that predate it, too.
  await StockAlertSettingsModel.updateOne({ key: "global", "channels.IN_APP.enabled": { $ne: true } }, { $set: { "channels.IN_APP.enabled": true } });
  const inAppTitle = { ...Object.fromEntries(Object.entries(TIER1).map(([k, t]) => [k, t.title])), ...Object.fromEntries(Object.entries(TIER2).map(([k, t]) => [k, t.title])) };
  for (const [eventKey, title] of Object.entries(inAppTitle)) {
    const tplId = await template(`${title} — bell`, eventKey, "IN_APP", "{{recordRef}} · {{createdBy}}\n{{link}}", { subject: title });
    const rules = await StockAlertRuleModel.find({ eventKey, isActive: true, kind: "AUTOMATIC" }).lean();
    for (const r of rules) {
      const first = r.steps[0];
      if (!first || first.sends.some((s) => s.channel === "IN_APP")) continue;
      const wa = first.sends.find((s) => s.channel === "WHATSAPP");
      if (!wa) continue;
      const steps = JSON.parse(JSON.stringify(r.steps));
      steps[0].sends.push({ channel: "IN_APP", templateId: tplId, to: wa.to, cc: [] });
      await StockAlertRuleService.update(r._id, { steps }, null);
      made.rules += 1;
    }
  }

  console.log("Alerts sample data:", made);
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error("Seeding alerts sample data failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
