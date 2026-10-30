/*
  Low-stock alerts — the starting templates and rule, so the alert works the
  moment this runs instead of needing three templates and a rule built by hand.

    node scripts/seed-low-stock-alert.js

  Creates (each only if nothing by that name exists yet):
    • templates "Low stock" for In-App, WhatsApp and Email
    • rule "Low stock alert" — In-App + WhatsApp + Email, all three to
      "People with access to the branch"

  Who that reaches: alert contacts linked to a login whose Inventory Items
  access covers the branch (OWN / SELECTED / ALL). Admins are not included —
  add them to the rule by name if they should hear about every branch.
  Edit the wording, channels or recipients on the Alerts screens afterwards.
*/
import mongoose from "mongoose";
import dotenv from "dotenv";
import StockAlertTemplateModel from "../models/stock.alert.template.model.js";
import StockAlertRuleModel from "../models/stock.alert.rule.model.js";
import StockAlertTemplateService from "../services/stock.alert.template.service.js";
import StockAlertRuleService from "../services/stock.alert.rule.service.js";
import { ALERT_CHANNEL, ALERT_RECIPIENT_TYPE } from "../constants/stock.enums.js";

dotenv.config();

const EVENT = "LOW_STOCK";
const RULE_NAME = "Low stock alert";

const TEMPLATES = [
  {
    channel: ALERT_CHANNEL.IN_APP,
    subject: "Low stock · {{branchName}}",
    body: "{{itemsList}}",
  },
  {
    channel: ALERT_CHANNEL.WHATSAPP,
    body: "⚠️ *Low stock — {{branchName}}*\n\n{{itemsList}}\n\n👉 {{link}}",
  },
  {
    channel: ALERT_CHANNEL.EMAIL,
    subject: "Low stock at {{branchName}} — {{itemCount}} product(s)",
    body: "These products are at or below their stock alert threshold in {{branchName}}:\n\n{{itemsList}}\n\nSee everything that is low: {{link}}",
  },
];

const main = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const templateIds = {};
  for (const t of TEMPLATES) {
    const name = "Low stock";
    const existing = await StockAlertTemplateModel.findOne({ name, eventKey: EVENT, channel: t.channel, isActive: true }).lean();
    if (existing) {
      console.info(`  skip   template ${t.channel} (exists)`);
      templateIds[t.channel] = existing._id;
      continue;
    }
    const doc = await StockAlertTemplateService.create({ name, eventKey: EVENT, ...t }, null);
    console.info(`  create template ${t.channel}`);
    templateIds[t.channel] = doc._id;
  }

  if (await StockAlertRuleModel.exists({ name: RULE_NAME, eventKey: EVENT, isActive: true })) {
    console.info(`  skip   rule "${RULE_NAME}" (exists)`);
  } else {
    const to = [{ type: ALERT_RECIPIENT_TYPE.BRANCH_USERS }];
    await StockAlertRuleService.create(
      {
        name: RULE_NAME,
        eventKey: EVENT,
        description: "Branch stock at or below its threshold — to everyone with access to that branch",
        enabled: true,
        steps: [
          {
            type: "INITIAL",
            afterHours: 0,
            enabled: true,
            sends: TEMPLATES.map((t) => ({ channel: t.channel, enabled: true, templateId: templateIds[t.channel], to, cc: [] })),
          },
        ],
      },
      null
    );
    console.info(`  create rule "${RULE_NAME}"`);
  }

  await mongoose.disconnect();
  console.info("Done.");
};

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
