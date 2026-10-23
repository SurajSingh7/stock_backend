/*
  Old Notification master → Alerts & Escalations, then removes the old one.

    node scripts/migrate-notifications-to-alerts.js           # dry run: prints the plan
    node scripts/migrate-notifications-to-alerts.js --apply   # does it

  What the old master did: per vendor (or a default), the CC list on the PO
  "Send Mail". In the new module that is a MANUAL rule on PO_SEND_TO_VENDOR:
    default notification       → CC of the vendor-less "PO to vendor (email)" rule
    vendor-specific notification → its own rule with a Vendor condition
  (StockAlertManualService prefers the vendor rule, same as the old resolver.)

  Then, with --apply:
    • every old document is written to scripts/backups/notifications-<ts>.json
    • the `notifications` collection is dropped
    • the `notifications` Access Control module and every grant on it
      (role, department, user override, data scope) are deleted
  Running it again finds nothing to migrate and only re-checks the clean-up.
*/
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import dotenv from "dotenv";
import StockAlertRuleModel from "../models/stock.alert.rule.model.js";
import StockAlertTemplateModel from "../models/stock.alert.template.model.js";
import StockAlertRuleService from "../services/stock.alert.rule.service.js";
import StockAlertTemplateService from "../services/stock.alert.template.service.js";

dotenv.config();
const APPLY = process.argv.includes("--apply");
const EVENT = "PO_SEND_TO_VENDOR";
const DEFAULT_RULE = "PO to vendor (email)";

const DEFAULT_TEMPLATE = {
  name: "Purchase Order to vendor",
  eventKey: EVENT,
  channel: "EMAIL",
  subject: "Purchase Order {{poNumber}} — {{entity}}",
  body: `<p>Dear {{vendorName}},</p>
<p>Please find attached Purchase Order <strong>{{poNumber}}</strong> for {{amount}}.</p>
<p>Kindly confirm receipt and share the dispatch schedule.</p>
<p>Regards,<br>Purchase Team · {{entity}}</p>`,
  attachDocument: true,
};

const addressCc = (emails) => [...new Set((emails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))].map((address) => ({ type: "ADDRESS", address }));

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const hasOld = (await db.listCollections({ name: "notifications" }).toArray()).length > 0;
  const old = hasOld ? await db.collection("notifications").find({}).toArray() : [];
  const live = old.filter((n) => n.isActive !== false && (n.channel || "EMAIL") === "EMAIL");
  console.log(`Old notifications: ${old.length} (${live.length} active email)${APPLY ? "" : "  — DRY RUN, add --apply"}`);

  let template = await StockAlertTemplateModel.findOne({ eventKey: EVENT, channel: "EMAIL", isActive: true }).lean();
  if (!template) {
    console.log(`  + template "${DEFAULT_TEMPLATE.name}"`);
    if (APPLY) template = (await StockAlertTemplateService.create(DEFAULT_TEMPLATE, null)).toObject();
  }
  const templateId = template?._id;
  const sendWith = (cc) => [{ type: "INITIAL", sends: [{ channel: "EMAIL", templateId, to: [{ type: "VENDOR" }], cc: [{ type: "VENDOR" }, ...cc] }] }];

  for (const n of live) {
    const cc = addressCc(n.ccEmails);
    if (n.isDefault) {
      const rule = await StockAlertRuleModel.findOne({ name: DEFAULT_RULE, eventKey: EVENT, isActive: true }).lean();
      if (rule) {
        const send = rule.steps[0].sends.find((s) => s.channel === "EMAIL");
        const have = new Set((send.cc || []).filter((r) => r.type === "ADDRESS").map((r) => r.address));
        const add = cc.filter((r) => !have.has(r.address));
        console.log(`  ~ "${DEFAULT_RULE}": CC += ${add.map((r) => r.address).join(", ") || "(nothing new)"}`);
        if (APPLY && add.length) {
          const steps = JSON.parse(JSON.stringify(rule.steps));
          steps[0].sends.find((s) => s.channel === "EMAIL").cc.push(...add);
          await StockAlertRuleService.update(rule._id, { steps }, null);
        }
      } else {
        console.log(`  + rule "${DEFAULT_RULE}" with CC ${cc.map((r) => r.address).join(", ")}`);
        if (APPLY) await StockAlertRuleService.create({ name: DEFAULT_RULE, eventKey: EVENT, description: `Migrated from notification "${n.name}"`, steps: sendWith(cc) }, null);
      }
    } else {
      const name = `PO to vendor — ${n.name}`;
      const exists = await StockAlertRuleModel.exists({ name, eventKey: EVENT, isActive: true });
      console.log(`  ${exists ? "=" : "+"} rule "${name}" · ${(n.applicableVendors || []).length} vendor(s) · CC ${cc.map((r) => r.address).join(", ")}`);
      if (APPLY && !exists) {
        await StockAlertRuleService.create(
          {
            name,
            eventKey: EVENT,
            description: `Migrated from notification "${n.name}"`,
            conditions: { vendorIds: (n.applicableVendors || []).map(String), branchIds: [], minAmount: null },
            steps: sendWith(cc),
          },
          null
        );
      }
    }
  }

  // ── Clean-up ──────────────────────────────────────────────────────────
  const mod = await db.collection("modules").findOne({ key: "notifications" });
  const grantCols = ["role_module_permissions", "user_permission_overrides", "department_module_restrictions", "user_data_scopes"];
  if (APPLY) {
    if (old.length) {
      const dir = path.join(process.cwd(), "scripts", "backups");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `notifications-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      fs.writeFileSync(file, JSON.stringify(old, null, 2));
      console.log(`  backup → ${file}`);
    }
    if (hasOld) {
      await db.collection("notifications").drop();
      console.log("  dropped collection notifications");
    }
    if (mod) {
      for (const c of grantCols) {
        const exists = (await db.listCollections({ name: c }).toArray()).length > 0;
        if (!exists) continue;
        const r = await db.collection(c).deleteMany({ moduleId: mod._id });
        if (r.deletedCount) console.log(`  removed ${r.deletedCount} grant(s) from ${c}`);
      }
      await db.collection("modules").deleteOne({ _id: mod._id });
      console.log("  removed Access Control module 'notifications'");
    }
  } else {
    console.log(`  would back up ${old.length} doc(s), drop 'notifications'${mod ? ", remove module 'notifications' and its grants" : ""}`);
  }

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error("Migration failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
