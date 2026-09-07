/**
 * Proves every business model records who created and last touched a row.
 *
 * The check runs against the COMPILED schema, not the source text, because the
 * mistake worth catching is subtle: applying actorStampPlugin to a sub-schema
 * (buyerEntitySchema, extraChargeSchema, stateSchema…) instead of the one
 * passed to mongoose.model(). That reads fine in a diff and silently stamps
 * nothing. Asking the finished model for its paths cannot be fooled that way —
 * it happened four times while this was being wired.
 *
 * Run: npm run check:stamp
 */
import { DATA_SCOPE_REGISTRY } from "../config/data.scope.registry.js";

const MODEL_FILE = {
  categories: "stock.category.model.js",
  "field-definitions": "stock.field.definition.model.js",
  "product-definitions": "stock.product.definition.model.js",
  vendors: "stock.vendor.model.js",
  "terms-conditions": "stock.terms.condition.model.js",
  notifications: "stock.notification.model.js",
  branches: "stock.branch.model.js",
  "inventory-items": "stock.inventory.item.model.js",
  "transfer-requests": "stock.transfer.request.model.js",
  quotations: "stock.quotation.model.js",
  "tracking-orders": "stock.tracking.order.model.js",
  "purchase-orders": "stock.purchase.order.model.js",
  invoices: "stock.invoice.model.js",
};

const ACTOR_FIELDS = ["userId", "employeeCode", "name", "email", "phone", "roleName", "branchId"];
const ACTOR_PATHS = ["createdBy", "updatedBy", "deletedBy"];

const failures = [];
let checked = 0;

for (const key of Object.keys(DATA_SCOPE_REGISTRY)) {
  const file = MODEL_FILE[key];
  if (!file) {
    failures.push(
      `Module "${key}" is in the data-scope registry but has no model mapping in this script — add one.`
    );
    continue;
  }

  let Model;
  try {
    Model = (await import(`../models/${file}`)).default;
  } catch (err) {
    failures.push(`models/${file} could not be loaded: ${err.message.split("\n")[0]}`);
    continue;
  }

  checked++;
  // A single-nested subdocument is addressed as one path, so ask for the
  // sub-schema and inspect ITS fields — Model.schema.paths["createdBy.userId"]
  // does not exist even when the field does.
  const missing = [];
  for (const p of ACTOR_PATHS) {
    const sub = Model.schema.path(p)?.schema;
    if (!sub) { missing.push(p); continue; }
    for (const f of ACTOR_FIELDS) if (!sub.paths[f]) missing.push(p + "." + f);
  }
  if (missing.length) {
    failures.push(
      `models/${file} is missing ${missing.join(", ")}. Add ` +
        `\`<schema>.plugin(actorStampPlugin)\` — and apply it to the schema passed to ` +
        `mongoose.model(), not to a sub-schema.`
    );
  }
}

/* ── 2. nobody writes these fields by hand ─────────────────────────────────
 * They are embedded documents now, so assigning a bare id throws at save time
 * with "Cast to Embedded failed … ObjectExpectedError". That is a runtime
 * error on a real user action, and it slipped through once already: the sweep
 * that removed the old manual stamps searched for `updatedBy:` and missed
 * `updatedBy =`, leaving Submit Approval broken.
 */
const fsSync = await import("node:fs");
const pathMod = await import("node:path");
const SERVICES = pathMod.join(import.meta.dirname, "..", "services");
const BY_HAND = /\.(createdBy|updatedBy|createdByName|updatedByName)\s*=[^=]/;

for (const file of fsSync.readdirSync(SERVICES)) {
  const src = fsSync.readFileSync(pathMod.join(SERVICES, file), "utf8");
  src.split(/\r?\n/).forEach((line, i) => {
    if (BY_HAND.test(line)) {
      failures.push(
        `services/${file}:${i + 1} assigns an author field by hand — ` +
          `actorStampPlugin owns createdBy/updatedBy. Delete the line; a bare id ` +
          `throws ObjectExpectedError at save time.`
      );
    }
  });
}

console.log(`Checked ${checked} model(s) for author fields.`);
if (failures.length) {
  console.error(`\n${failures.length} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("Every model records createdBy/updatedBy/deletedBy as a full actor snapshot.");
process.exit(0);
