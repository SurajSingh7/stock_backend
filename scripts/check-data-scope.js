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
  "available-products": "stock.inventory.item.model.js",
  "available-items": "stock.inventory.item.model.js",
  "product-summary": "stock.inventory.item.model.js",
  "my-stock-requests": "stock.transfer.request.model.js",
  "stock-requests-to-us": "stock.transfer.request.model.js",
  "stock-transfer-history": "stock.transfer.request.model.js",
  "opening-stock": "stock.opening.stock.model.js",
  "opening-issued-stock": "stock.opening.stock.model.js",
  "item-requests": "stock.item.request.model.js",
  repairs: "stock.inventory.item.model.js",
  "employee-items": "stock.inventory.item.model.js",
  "stock-reports": "stock.inventory.item.model.js",
  quotations: "stock.quotation.model.js",
  "tracking-orders": "stock.tracking.order.model.js",
  "purchase-orders": "stock.purchase.order.model.js",
  invoices: "stock.invoice.model.js",
  "invoice-list": "stock.invoice.model.js", // same documents, payment-side module
  "faulty-items": "stock.invoice.model.js",
  payments: "stock.invoice.model.js",
  "payment-approval": "stock.invoice.model.js",
  "vendor-ledger": "stock.invoice.model.js",
  // Reports — all read the same invoices, each through its own module so the
  // data scope can differ per report.
  "billing-report": "stock.invoice.model.js",
  "paid-report": "stock.invoice.model.js",
  "transaction-register": "stock.invoice.model.js",
  "invoice-breakup": "stock.invoice.model.js",
  "account-summary": "stock.invoice.model.js",
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
  "available-items": "stock.inventory.item.service.js",
  "available-products": "stock.product.stock.service.js",
  "product-summary": "stock.product.stock.service.js",
  "my-stock-requests": "stock.transfer.request.service.js",
  "stock-requests-to-us": "stock.transfer.request.service.js",
  "stock-transfer-history": "stock.transfer.request.service.js",
  "opening-stock": "stock.opening.stock.service.js",
  "opening-issued-stock": "stock.opening.stock.service.js",
  "item-requests": "stock.item.request.service.js",
  repairs: "stock.repair.service.js",
  "employee-items": "stock.employee.item.service.js",
  "stock-reports": "stock.inventory.report.service.js",
  quotations: "stock.quotation.service.js",
  "tracking-orders": "stock.tracking.order.service.js",
  "purchase-orders": "stock.purchase.order.service.js",
  invoices: "stock.invoice.service.js",
  "invoice-list": "stock.invoice.payment.service.js",
  "faulty-items": "stock.faulty.item.service.js",
  payments: "stock.invoice.payment.service.js",
  "payment-approval": "stock.invoice.payment.service.js",
  "vendor-ledger": "stock.vendor.ledger.service.js",
  // Billing and Outstanding have no service of their own on purpose: they are
  // the ledger's summary with different columns, so the scope check that
  // matters is the one already asserted on stock.vendor.ledger.service.js.
  "billing-report": "stock.vendor.ledger.service.js",
  "paid-report": "stock.report.service.js",
  "transaction-register": "stock.report.service.js",
  "invoice-breakup": "stock.report.service.js",
  "account-summary": "stock.vendor.ledger.service.js",
};

/*
  Services that hold no queries of their own and take their scope from the one
  they delegate to.

  stock.report.service.js is the case this exists for: it builds the payment
  register and the invoice breakup entirely out of
  StockVendorLedgerService._loadFacts, which applies the scope. Demanding an
  applyDataScope call in a file that never touches a model would only invite
  somebody to add a decorative one.

  Named here rather than inferred, and both halves of the claim are asserted
  below — that the delegate really scopes, and that the delegating file really
  has no queries. The moment someone adds a direct model query here, the
  delegation stops being true and this fails.
*/
const SCOPED_BY_DELEGATION = {
  "stock.report.service.js": "stock.vendor.ledger.service.js",
};

/*
  Collections with no scope fields of their own, which inherit visibility from
  a parent that was already scoped.

  The adjustment collection is the case: a debit note is exactly as visible as
  the invoice it sits on, so it is deliberately absent from the registry and is
  only ever queried for invoice ids a scoped query returned — see
  StockVendorLedgerService._loadFacts and StockReportService._adjustmentRows.

  Named rather than pattern-matched, so adding one is a deliberate, reviewable
  act. This is a reviewed exemption and not a proof: the filter is built as a
  variable, so no static check here can show the parent constraint is present.
  What it does guarantee is that a delegating service cannot quietly start
  querying a SCOPED collection instead.
*/
const SCOPE_INHERITED_FROM_PARENT = new Set(["StockInvoiceAdjustmentModel"]);

const SCOPE_HELPER = /applyDataScope|isWithinDataScope|resolveDimensionAllowList/;

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

  const delegate = SCOPED_BY_DELEGATION[file];
  if (delegate) {
    const offenders = [...new Set(src.match(/\bStock[A-Za-z]*Model\b/g) || [])].filter(
      (m) => !SCOPE_INHERITED_FROM_PARENT.has(m)
    );
    if (offenders.length) {
      failures.push(
        `services/${file} is registered as scoped-by-delegation to ${delegate}, but it ` +
          `references ${offenders.join(", ")} directly — it must apply the data scope ` +
          `itself, or the collection must be listed in SCOPE_INHERITED_FROM_PARENT ` +
          `with a reason.`
      );
    }
    const delegateFull = path.join(ROOT, "services", delegate);
    const delegateSrc = fs.existsSync(delegateFull) ? fs.readFileSync(delegateFull, "utf8") : "";
    if (!SCOPE_HELPER.test(delegateSrc)) {
      failures.push(
        `services/${file} delegates the scope for "${key}" to ${delegate}, which does not apply it.`
      );
    }
    continue;
  }

  if (!SCOPE_HELPER.test(src)) {
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
  "available-products": "StockInventoryItemModel",
  "available-items": "StockInventoryItemModel",
  "product-summary": "StockInventoryItemModel",
  "my-stock-requests": "StockTransferRequestModel",
  "stock-requests-to-us": "StockTransferRequestModel",
  "stock-transfer-history": "StockTransferRequestModel",
  "opening-stock": "StockOpeningStockModel",
  "opening-issued-stock": "StockOpeningStockModel",
  "item-requests": "StockItemRequestModel",
  repairs: "StockInventoryItemModel",
  "employee-items": "StockInventoryItemModel",
  "stock-reports": "StockInventoryItemModel",
  quotations: "StockQuotationModel",
  "tracking-orders": "StockTrackingOrderModel",
  "purchase-orders": "StockPurchaseOrderModel",
  invoices: "StockInvoiceModel",
  "invoice-list": "StockInvoiceModel",
  "faulty-items": "StockInvoiceModel",
  payments: "StockInvoiceModel",
  "payment-approval": "StockInvoiceModel",
  "vendor-ledger": "StockInvoiceModel",
  "billing-report": "StockInvoiceModel",
  "paid-report": "StockInvoiceModel",
  "transaction-register": "StockInvoiceModel",
  "invoice-breakup": "StockInvoiceModel",
  "account-summary": "StockInvoiceModel",
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
    _resolveParent: "validates the main vendor picked on the form (the picker itself is scoped); one level only, checked across branches",
  },
  "my-stock-requests": { getFormBranches: "the OTHER branch of a transfer is outside your scope by design" },
  quotations: { generateQuotationNumber: "sequence spans all users" },
  "purchase-orders": { generatePONumber: "sequence spans all entities" },
  "tracking-orders": {
    createForQuotationVendors: "internal fan-out at quotation approval",
    getById: "internal lookup, not routed",
    recalculateStatus: "internal recalculation",
    getByQuotationAndVendor: "internal lookup, not routed",
    getPendingByCategory: "a warning must see open orders in every branch",
  },
  // The requester side is scoped by CHANNEL (each caller sees only its own
  // requests), not by branch — the NOC website is not an HRMS user and has no
  // branch scope to apply.
  "item-requests": {
    resendRequest: "requester side, scoped by channel",
    getForRequester: "requester side, scoped by channel",
    listForRequester: "requester side, scoped by channel",
    holdingsForRequester: "requester side, scoped by channel and subscriber",
    _resolveReturnSide: "requester side — checks the request's own earlier returns, scoped by channel and subscriber",
    _assertCategoriesNotOpen: "requester side — one open issue per category, scoped by subscriber and branch",
    withdrawRequest: "requester side, scoped by channel",
    _openElsewhere: "warning only — the same subscriber's open requests at other branches, request number and branch name only",
  },
  invoices: {
    _invoicedQtyByLine: "PO cap must sum every invoice",
    _assertUniqueNumber: "a duplicate invoice must be caught whoever added the first one",
  },
};

// Wrappers around resolveDimensionAllowList: assertBranch (Stock Transfer —
// each action checks its own side of a request) and visibleBranches (the
// Stock pages — every product-stock read starts from the caller's branches).
const SCOPE_CALL = /applyDataScope|isWithinDataScope|assertDataScope|resolveDimensionAllowList|assertBranch|visibleBranches|unscopedInternalQuery/;

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
