/**
 * Frontend page addresses were reorganised to follow the menu (2026-10-31),
 * all under /stock: /stock/payments → /stock/accounts/payments,
 * /master/category → /stock/masters/categories, /alerts/rules →
 * /stock/admin/alerts/rules, and so on. New notifications already link to the new pages (see
 * config/alert.event.catalog.js); this rewrites the links already stored, so
 * the website bell's old notifications and a Resend from the Message Log open
 * the right page too.
 *
 *   alert_inbox      link, body        — the bell
 *   alert_messages   link, body, subject — Message Log (Resend reuses these)
 *   alert_templates  body, subject     — only if someone typed a URL by hand
 *
 * Only page URLs change: a path counts as a page URL when it starts the text,
 * follows a quote/space/=, or follows a host — never the middle of a longer
 * path, so API paths such as /stock/alerts/... are left alone.
 *
 * Dry run by default — prints what would change and writes nothing.
 * --apply writes, after saving every row it will touch to scripts/backups/.
 * Idempotent: a second run finds nothing to change.
 *
 * Run: node scripts/migrate-frontend-urls.js            (dry run)
 *      node scripts/migrate-frontend-urls.js --apply
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");

// Old page → new page (both without the leading slash; every new page sits
// under /stock). Detail routes with an id are the first RULES.
const PAGES = [
  ["stock/tracking-orders", "purchase/tracking-orders"],
  ["stock/not-required", "purchase/not-required"],
  ["stock/invoice-list", "purchase/invoices"],
  ["stock/faulty-items", "purchase/faulty-items"],
  ["stock/quotations/list", "purchase/quotations"],
  ["stock/quotations/create", "purchase/quotations/create"],
  ["stock/quotations/approval", "approval/quotations"],
  // Older notifications linked to the bare /stock/quotations, which was never
  // a page (the list lived at /stock/quotations/list) — mend those as well.
  ["stock/quotations", "purchase/quotations"],
  ["stock/payment-approval", "approval/payments"],
  ["stock/purchase-orders/create", "accounts/po-approval/create"],
  ["stock/purchase-orders", "accounts/po-approval"],
  ["stock/invoice-approval", "accounts/invoice-approval"],
  ["stock/payments", "accounts/payments"],
  ["stock/reports/billing", "reports/billing"],
  ["stock/reports/account-summary", "reports/vendor-outstanding"],
  ["stock/reports/paid", "reports/paid"],
  ["stock/reports/transactions", "reports/transactions"],
  ["stock/reports/invoice-breakup", "reports/invoice-breakup"],
  ["stock/product-inventory", "inventory/products"],
  ["stock/item-inventory", "inventory/items"],
  ["stock/low-stock", "inventory/low-stock"],
  ["stock/stock-reports", "inventory/reports"],
  ["stock/opening-stock", "inventory/opening/in-store"],
  ["stock/opening-issued", "inventory/opening/with-people"],
  // The old pages: the requests we raised, and the ones raised with us.
  ["stock/transfer-requests", "inventory/transfers/my-requests"],
  ["stock/incoming-requests", "inventory/transfers/requests-to-us"],
  ["stock/transfer-history", "inventory/transfers/history"],
  ["stock/item-requests", "allotment/requests"],
  ["stock/subscriber-items", "allotment/subscribers"],
  ["stock/employee-items", "allotment/employees"],
  ["stock/repairs", "repairs"],
  ["stock/vendors", "vendors"],
  ["master/terms-condition", "vendors/terms"],
  ["master/product-definition", "masters/products"],
  ["master/category", "masters/categories"],
  ["master/branch", "masters/branches"],
  ["master/gst-rate", "masters/gst-rates"],
  ["master/field-definition", "admin/field-definitions"],
  ["master/ai-settings", "admin/ai-settings"],
  ...["rules", "templates", "contacts", "escalations", "log", "channels"].map((p) => [`alerts/${p}`, `admin/alerts/${p}`]),
  ...["modules", "roles", "departments", "users", "delegate", "audit-log"].map((p) => [`access-control/${p}`, `admin/access-control/${p}`]),
  ["test/request-simulator", "admin/test/request-simulator"],
];

const START = "(?<=^|[\"'`(\\s=]|https?:\\/\\/[^\\/\\s\"'`]+)";
const END = "(?=$|[/?#\"'`\\s)\\]}])";
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ID = "([0-9a-f]{24})";
// Sections of the new scheme. A database migrated by the first cut of this
// script (pages without the /stock prefix, e.g. /accounts/payments) is
// brought to the final address too; a fresh database never has these.
const SECTIONS = ["purchase", "approval", "accounts", "reports", "inventory", "allotment", "repairs", "vendors", "masters", "admin", "home", "notifications", "my-settings"];

const RULES = [
  [new RegExp(`${START}/stock/quotations/${ID}/view${END}`, "g"), "/stock/purchase/quotations/$1"],
  [new RegExp(`${START}/stock/quotations/${ID}/review${END}`, "g"), "/stock/approval/quotations/$1"],
  [new RegExp(`${START}/stock/purchase-orders/${ID}/view${END}`, "g"), "/stock/accounts/po-approval/$1"],
  ...PAGES.map(([o, n]) => [new RegExp(`${START}/${esc(o)}${END}`, "g"), `/stock/${n}`]),
  [new RegExp(`${START}/(${SECTIONS.join("|")})${END}`, "g"), "/stock/$1"],
];

const rewrite = (text) => {
  if (typeof text !== "string" || !text) return text;
  return RULES.reduce((s, [re, to]) => s.replace(re, to), text);
};

const TARGETS = [
  { collection: "alert_inbox", fields: ["link", "body"] },
  { collection: "alert_messages", fields: ["link", "body", "subject"] },
  { collection: "alert_templates", fields: ["body", "subject"] },
];

await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${mongoose.connection.name}\n`);

const changes = [];
for (const { collection, fields } of TARGETS) {
  const or = fields.map((f) => ({ [f]: { $regex: `/(stock|master|alerts|access-control|test|${SECTIONS.join("|")})\\b` } }));
  const rows = await db.collection(collection).find({ $or: or }, { projection: Object.fromEntries(fields.map((f) => [f, 1])) }).toArray();
  let n = 0;
  for (const row of rows) {
    const set = {};
    for (const f of fields) {
      const next = rewrite(row[f]);
      if (next !== row[f]) set[f] = next;
    }
    if (!Object.keys(set).length) continue;
    n++;
    changes.push({ collection, _id: row._id, before: Object.fromEntries(Object.keys(set).map((f) => [f, row[f]])), set });
  }
  console.log(`${collection.padEnd(16)} scanned ${String(rows.length).padStart(5)}   to change ${String(n).padStart(5)}`);
}

// A few examples, so the dry run can be read before anything is written.
for (const c of changes.slice(0, 5)) {
  const f = "link" in c.set ? "link" : Object.keys(c.set)[0];
  console.log(`\n  ${c.collection} ${c._id} ${f}\n    - ${String(c.before[f]).slice(0, 140)}\n    + ${String(c.set[f]).slice(0, 140)}`);
}

if (APPLY && changes.length) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `frontend-urls-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(changes.map(({ collection, _id, before }) => ({ collection, _id, before })), null, 2));
  console.log(`\nBackup of the old values: ${file}`);
  for (const c of changes) await db.collection(c.collection).updateOne({ _id: c._id }, { $set: c.set });
  console.log(`Updated ${changes.length} rows.`);
} else if (!APPLY) {
  console.log(`\n${changes.length} rows would change. Nothing written — run again with --apply.`);
} else {
  console.log("\nNothing to change.");
}

await mongoose.disconnect();
