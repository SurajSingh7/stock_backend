/*
  Stock Transfer alerts — starting templates and rules, so the five
  transfer notifications work the moment this runs.

    node scripts/seed-transfer-alerts.js

  Creates (each only if nothing by that name exists yet), for every event:
    • templates for In-App and WhatsApp
    • a rule sending both to "People with access to the branch"

  Each event is raised on the request and goes to the OTHER branch (see
  config/alert.event.catalog.js):
    STOCK_REQUESTED         → the branch asked for stock
    STOCK_REQUEST_DECLINED  → the branch that asked
    STOCK_SENT              → the branch that asked (again after every Correct & Resend)
    STOCK_PROBLEM_REPORTED  → the sending branch (correct and resend)
    STOCK_RECEIVED          → the sending branch

  "People with access to the branch" = alert contacts linked to a login whose
  access to that page covers the branch. Reminders (e.g. "still not received
  after 24 h") can be added as later steps on the Alerts → Rules screen.
*/
import mongoose from "mongoose";
import dotenv from "dotenv";
import StockAlertTemplateModel from "../models/stock.alert.template.model.js";
import StockAlertRuleModel from "../models/stock.alert.rule.model.js";
import StockAlertTemplateService from "../services/stock.alert.template.service.js";
import StockAlertRuleService from "../services/stock.alert.rule.service.js";
import { ALERT_CHANNEL, ALERT_RECIPIENT_TYPE } from "../constants/stock.enums.js";

dotenv.config();

const EVENTS = [
  {
    eventKey: "STOCK_REQUESTED",
    name: "Stock requested",
    description: "Another branch asked us for stock",
    inApp: { subject: "{{requestingBranch}} asked for stock · {{requestNo}}", body: "{{itemsList}}" },
    whatsapp: "📦 *{{requestingBranch}} asked {{sendingBranch}} for stock*\nRequest {{requestNo}}\n\n{{itemsList}}\n\n👉 {{link}}",
  },
  {
    eventKey: "STOCK_REQUEST_DECLINED",
    name: "Stock request declined",
    description: "The branch we asked declined our request",
    inApp: { subject: "{{sendingBranch}} declined {{requestNo}}", body: "Reason: {{reason}}" },
    whatsapp: "❌ *{{sendingBranch}} declined your stock request {{requestNo}}*\nReason: {{reason}}\n\n👉 {{link}}",
  },
  {
    eventKey: "STOCK_SENT",
    name: "Stock on the way",
    description: "Stock sent to us — check it and say All Received or Report Problem",
    inApp: { subject: "{{sendingBranch}} sent stock · {{requestNo}}", body: "{{sentList}}\n\nCheck it when it arrives." },
    whatsapp: "🚚 *Stock on the way from {{sendingBranch}}*\nRequest {{requestNo}}\n\n{{sentList}}\n\nCheck it when it arrives: {{link}}",
  },
  {
    eventKey: "STOCK_PROBLEM_REPORTED",
    name: "Problem reported",
    description: "The branch that asked reported a problem — correct and resend",
    inApp: { subject: "{{requestingBranch}} reported a problem · {{requestNo}}", body: "{{problemNote}}\n\nTake off what did not go and resend." },
    whatsapp: "⚠️ *{{requestingBranch}} reported a problem with {{requestNo}}*\n\n“{{problemNote}}”\n\nSent:\n{{sentList}}\n\nCorrect & resend: {{link}}",
  },
  {
    eventKey: "STOCK_RECEIVED",
    name: "Stock received",
    description: "The branch that asked received our stock",
    inApp: { subject: "{{requestingBranch}} received {{requestNo}}", body: "{{sentList}}" },
    whatsapp: "✅ *{{requestingBranch}} received {{requestNo}}*\n\n{{sentList}}\n\n👉 {{link}}",
  },
];

const main = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  for (const ev of EVENTS) {
    const templates = [
      { channel: ALERT_CHANNEL.IN_APP, subject: ev.inApp.subject, body: ev.inApp.body },
      { channel: ALERT_CHANNEL.WHATSAPP, body: ev.whatsapp },
    ];
    const templateIds = {};
    for (const t of templates) {
      const existing = await StockAlertTemplateModel.findOne({ name: ev.name, eventKey: ev.eventKey, channel: t.channel, isActive: true }).lean();
      if (existing) {
        console.info(`  skip   template ${ev.eventKey} ${t.channel} (exists)`);
        templateIds[t.channel] = existing._id;
        continue;
      }
      const doc = await StockAlertTemplateService.create({ name: ev.name, eventKey: ev.eventKey, ...t }, null);
      console.info(`  create template ${ev.eventKey} ${t.channel}`);
      templateIds[t.channel] = doc._id;
    }

    if (await StockAlertRuleModel.exists({ name: ev.name, eventKey: ev.eventKey, isActive: true })) {
      console.info(`  skip   rule "${ev.name}" (exists)`);
      continue;
    }
    const to = [{ type: ALERT_RECIPIENT_TYPE.BRANCH_USERS }];
    await StockAlertRuleService.create(
      {
        name: ev.name,
        eventKey: ev.eventKey,
        description: ev.description,
        enabled: true,
        steps: [
          {
            type: "INITIAL",
            afterHours: 0,
            enabled: true,
            sends: templates.map((t) => ({ channel: t.channel, enabled: true, templateId: templateIds[t.channel], to, cc: [] })),
          },
        ],
      },
      null
    );
    console.info(`  create rule "${ev.name}"`);
  }

  await mongoose.disconnect();
  console.info("Done.");
};

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
