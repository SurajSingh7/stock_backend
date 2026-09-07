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
  vendors: "stock.vendor.model.js",
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
  // Ask the COMPILED schema, not the source text. Fields can arrive from a
  // plugin (createdBy/updatedBy do), in which case they appear nowhere in the
  // model file and a grep would wrongly report them missing.
  let Model;
  try {
    Model = (await import(`../models/${file}`)).default;
  } catch (err) {
    failures.push(`models/${file} could not be loaded: ${err.message.split("\n")[0]}`);
    continue;
  }

  for (const p of paths) {
    if (p === "_id") continue; // always present
    // Resolve a dotted path one segment at a time, stepping into sub-schemas.
    const segments = p.split(".");
    let schema = Model.schema;
    let ok = true;
    for (let i = 0; i < segments.length; i++) {
      const at = schema?.path(segments[i]);
      if (!at) { ok = false; break; }
      if (i < segments.length - 1) schema = at.schema ?? at.caster?.schema;
    }
    if (!ok) {
      failures.push(`Module "${key}" scopes on "${p}", but ${file} has no such field.`);
    }
  }
}

/* ── 3. scoped services actually enforce ──────────────────────────────────── */
const SERVICE_FILE = {
  branches: "stock.branch.service.js",
  vendors: "stock.vendor.service.js",
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

/* ── 4. per-METHOD enforcement ────────────────────────────────────────────
 * Check 3 only proves a service mentions the helper SOMEWHERE. That is not
 * enough: a service can scope its list and leave every mutation open, which
 * is exactly the gap that shipped once already. So walk each static method
 * and require any that queries its OWN model to either apply the scope or
 * declare itself internal.
 */
const OWN_MODEL = {
  branches: "StockBranchModel",
  vendors: "StockVendorModel",
  "inventory-items": "StockInventoryItemModel",
  "transfer-requests": "StockTransferRequestModel",
  quotations: "StockQuotationModel",
  "tracking-orders": "StockTrackingOrderModel",
  "purchase-orders": "StockPurchaseOrderModel",
  invoices: "StockInvoiceModel",
};

// Internal mechanics that legitimately see every row. Each is named here
// rather than pattern-matched, so adding one is a deliberate, reviewable act.
const UNSCOPED_BY_DESIGN = {
  branches: {
    assertCodeNotDuplicate: "uniqueness must consider every branch",
    getActiveBranches: "dropdown for picking the OTHER branch of a transfer",
  },
  vendors: {
    assertVendorNotDuplicate: "a duplicate name or GST must be caught across every branch",
    generateNextVendorCode: "sequence spans all branches",
  },
  "transfer-requests": { generateRequestNumber: "sequence spans all branches" },
  quotations: { generateQuotationNumber: "sequence spans all users" },
  "purchase-orders": { generatePONumber: "sequence spans all entities" },
  "tracking-orders": {
    createForQuotationVendors: "internal fan-out at quotation approval",
    getById: "internal lookup, not routed",
    recalculateStatus: "internal recalculation",
    getByQuotationAndVendor: "internal lookup, not routed",
  },
  invoices: { _sumNonRejectedQtyByLine: "over-receipt cap must sum every invoice" },
};

const SCOPE_CALL = /applyDataScope|isWithinDataScope|assertDataScope|resolveDimensionAllowList|unscopedInternalQuery/;

for (const [key, dims] of Object.entries(DATA_SCOPE_REGISTRY)) {
  if (!Object.keys(dims).length) continue;
  const file = SERVICE_FILE[key];
  const model = OWN_MODEL[key];
  if (!file || !model) continue;

  const full = path.join(ROOT, "services", file);
  if (!fs.existsSync(full)) continue;
  const src = fs.readFileSync(full, "utf8");
  const allowed = UNSCOPED_BY_DESIGN[key] || {};

  const methods = src.split(/\n {2}static (?:async )?/);
  for (let i = 1; i < methods.length; i++) {
    const body = methods[i];
    const name = body.split(/[(\s]/)[0];
    if (!new RegExp(`${model}\\.(find|findOne|findById|aggregate|countDocuments|distinct)`).test(body)) continue;
    if (SCOPE_CALL.test(body)) continue;
    if (allowed[name]) continue;

    failures.push(
      `services/${file} → ${name}() queries ${model} but neither applies the data ` +
        `scope nor is listed in UNSCOPED_BY_DESIGN. Add the scope check, or ` +
        `register it there with a reason.`
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
