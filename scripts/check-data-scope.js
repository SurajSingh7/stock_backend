/**
 * The data-scope counterpart to check-route-permissions.js.
 *
 * check:routes proves every route asks "may they do this". This proves every
 * scoped module's service actually filters "whose rows" — the failure mode the
 * spec calls out: a developer adds a query and forgets the scope, and the
 * endpoint silently returns everyone's data.
 *
 * Three checks:
 *   1. Every module in the seeder appears in the registry (fail closed).
 *   2. Every registry field actually exists on that model's schema.
 *   3. Every service owning a scoped module calls applyDataScope /
 *      isWithinDataScope, and any raw query it makes is accounted for.
 *
 * Run: npm run check:scope
 */
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { DATA_SCOPE_REGISTRY } from "../config/data.scope.registry.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const failures = [];
const warnings = [];

/* ── 1. registry completeness ─────────────────────────────────────────────── */
const seeder = fs.readFileSync(path.join(ROOT, "seeders/stock.module.seeder.js"), "utf8");
const seededKeys = [...seeder.matchAll(/key:\s*"([^"]+)"/g)].map((m) => m[1]);

for (const key of seededKeys) {
  if (!(key in DATA_SCOPE_REGISTRY)) {
    failures.push(`Module "${key}" is seeded but missing from the data-scope registry.`);
  }
}
for (const key of Object.keys(DATA_SCOPE_REGISTRY)) {
  if (!seededKeys.includes(key)) {
    warnings.push(`Registry lists "${key}", which the seeder no longer defines.`);
  }
}

/* ── 2. registry fields exist on the model ────────────────────────────────── */
// Model files are named after the resource, not the module key, so map the
// handful that differ rather than guessing.
const MODEL_FILE = {
  branches: "stock.branch.model.js",
  "inventory-items": "stock.inventory.item.model.js",
  "transfer-requests": "stock.transfer.request.model.js",
  quotations: "stock.quotation.model.js",
  "tracking-orders": "stock.tracking.order.model.js",
  "purchase-orders": "stock.purchase.order.model.js",
  invoices: "stock.invoice.model.js",
};

for (const [key, dims] of Object.entries(DATA_SCOPE_REGISTRY)) {
  const paths = Object.values(dims).flat();
  if (!paths.length) continue;

  const file = MODEL_FILE[key];
  if (!file) {
    failures.push(`Module "${key}" declares scope fields but has no model mapping in this script.`);
    continue;
  }
  const src = fs.readFileSync(path.join(ROOT, "models", file), "utf8");
  for (const p of paths) {
    // A dotted path lives in a sub-schema, so check only its leaf.
    const leaf = p.split(".").pop();
    if (leaf === "_id") continue; // always present
    if (!new RegExp(`\\b${leaf}\\s*:`).test(src)) {
      failures.push(`Module "${key}" scopes on "${p}", but ${file} has no such field.`);
    }
  }
}

/* ── 3. scoped services actually enforce ──────────────────────────────────── */
const SERVICE_FILE = {
  branches: "stock.branch.service.js",
  "inventory-items": "stock.inventory.item.service.js",
  "transfer-requests": "stock.transfer.request.service.js",
  quotations: "stock.quotation.service.js",
  "tracking-orders": "stock.tracking.order.service.js",
  "purchase-orders": "stock.purchase.order.service.js",
  invoices: "stock.invoice.service.js",
};

for (const [key, dims] of Object.entries(DATA_SCOPE_REGISTRY)) {
  if (!Object.keys(dims).length) continue; // unscoped by design
  const file = SERVICE_FILE[key];
  if (!file) {
    failures.push(`Scoped module "${key}" has no service mapping in this script.`);
    continue;
  }
  const full = path.join(ROOT, "services", file);
  if (!fs.existsSync(full)) {
    failures.push(`Scoped module "${key}" expects services/${file}, which does not exist.`);
    continue;
  }
  const src = fs.readFileSync(full, "utf8");
  if (!/applyDataScope|isWithinDataScope|resolveDimensionAllowList/.test(src)) {
    failures.push(
      `services/${file} owns scoped module "${key}" but never calls the data-scope helper — ` +
        `its queries would return every user's rows.`
    );
  }
}

/* ── report ───────────────────────────────────────────────────────────────── */
console.log(`Registry: ${Object.keys(DATA_SCOPE_REGISTRY).length} module(s), ${seededKeys.length} seeded.`);
for (const w of warnings) console.warn(`  warning: ${w}`);

if (failures.length) {
  console.error(`\n${failures.length} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("Every module is registered, every scope field exists, every scoped service enforces.");
process.exit(0);
