/**
 * One-off: partial submit is gone (2026-11-25). An invoice is now entered in
 * full and approved in one go, so the invoice fields and the permission that
 * served it are removed from the database.
 *
 *   1. Invoices that had partial submit on are turned into normal invoices:
 *        - with approved entries → APPROVED, closed at what was approved: each
 *          line's invoiceQuantity drops to its approved receivedQuantity (the
 *          rest never arrived), and the approved entries' serial rows and
 *          inventory-item ids move onto the line. Units of entries that were
 *          not approved (draft / pending / rejected) were never stock and are
 *          deleted.
 *        - with only a draft → the draft's quantities and rows go onto the
 *          lines, status DRAFT (UPLOADED if the draft was empty).
 *      Every change is written to the invoice's editHistory.
 *   2. partialSubmit / entries / inLedger are unset on every invoice.
 *   3. invoiceEntryId is unset on every inventory item.
 *   4. The PARTIAL_SUBMIT action is pulled from the invoices module and from
 *      every role / user override / department restriction that holds it —
 *      the access-control service rejects actions the module no longer lists.
 *
 * The affected invoices are backed up to scripts/backups first.
 * Idempotent — a re-run finds nothing to do.
 * Run: node scripts/remove-partial-submit.js [--dry]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { mongoUri } from "../config/env.config.js";

const DRY = process.argv.includes("--dry");
const ACTION = "PARTIAL_SUBMIT";
const MODULE_KEY = "invoices";

await mongoose.connect(mongoUri);
const db = mongoose.connection.db;
const invoicesCol = db.collection("invoices");
const itemsCol = db.collection("inventory_items");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
// Same as StockInvoiceService._computeAmount: invoiced qty × price + billed charges.
const pricedQty = (l) => ((l.invoiceQuantity || 0) > 0 ? l.invoiceQuantity : l.receivedQuantity || 0);
const computeAmount = (lines, charges) =>
  round2(
    lines.reduce((t, l) => t + pricedQty(l) * (l.unitPrice || 0), 0) +
      (charges || []).filter((c) => c.includeInBilling !== false).reduce((t, c) => t + (Number(c.amount) || 0), 0)
  );

const partial = await invoicesCol.find({ $or: [{ partialSubmit: true }, { "entries.0": { $exists: true } }] }).toArray();
console.log(`${DRY ? "[dry run] " : ""}${partial.length} invoice(s) with partial submit`);

if (partial.length && !DRY) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `remove-partial-submit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(partial, null, 2));
  console.log(`  backup: ${file}`);
}

for (const inv of partial) {
  const entries = inv.entries || [];
  const approved = entries.filter((e) => e.status === "APPROVED").sort((a, b) => a.entryNumber - b.entryNumber);
  const notApproved = entries.filter((e) => e.status !== "APPROVED");
  const changes = [{ field: "Partial submit", from: "ON", to: "removed" }];
  let lines;
  let status;

  if (approved.length) {
    // Lines already carry the approved totals; the rows live on the entries.
    const rowsByKey = new Map();
    const idsByKey = new Map();
    approved.forEach((e) =>
      (e.lines || []).forEach((el) => {
        const k = String(el.quotationItemId);
        rowsByKey.set(k, [...(rowsByKey.get(k) || []), ...(el.rows || [])]);
        idsByKey.set(k, [...(idsByKey.get(k) || []), ...(el.createdInventoryItemIds || [])]);
      })
    );
    lines = inv.lines
      .map((l) => {
        const k = String(l.quotationItemId);
        const received = l.receivedQuantity || 0;
        if (received !== l.invoiceQuantity) {
          changes.push({ field: `${l.productName} · quantity`, from: l.invoiceQuantity, to: received });
        }
        return { ...l, invoiceQuantity: received, rows: rowsByKey.get(k) || [], createdInventoryItemIds: idsByKey.get(k) || [] };
      })
      .filter((l) => (l.invoiceQuantity || 0) > 0 || (l.focQuantity || 0) > 0);
    status = "APPROVED";
  } else {
    const draft = entries.find((e) => e.status === "DRAFT");
    const byKey = new Map((draft?.lines || []).map((el) => [String(el.quotationItemId), el]));
    lines = inv.lines.map((l) => {
      const d = byKey.get(String(l.quotationItemId));
      return { ...l, receivedQuantity: d?.receivedQuantity || 0, focQuantity: d?.focQuantity || 0, rows: d?.rows || [], createdInventoryItemIds: [] };
    });
    status = lines.some((l) => (l.receivedQuantity || 0) > 0 || (l.focQuantity || 0) > 0) ? "DRAFT" : "UPLOADED";
  }

  // Units of entries that never got approved were never stock.
  const strayIds = notApproved.flatMap((e) => (e.lines || []).flatMap((l) => l.createdInventoryItemIds || []));
  const entryIds = notApproved.map((e) => e._id);

  console.log(
    `  ${inv.invoiceNumber}: ${inv.status} → ${status}` +
      (changes.length > 1 ? ` · ${changes.slice(1).map((c) => `${c.field} ${c.from}→${c.to}`).join(", ")}` : "") +
      (strayIds.length || entryIds.length ? ` · delete units of ${notApproved.length} unapproved entr(ies)` : "")
  );
  if (DRY) continue;

  await itemsCol.deleteMany({ $or: [{ _id: { $in: strayIds } }, { invoiceEntryId: { $in: entryIds } }] });
  await invoicesCol.updateOne(
    { _id: inv._id },
    {
      $set: { lines, status, amount: computeAmount(lines, inv.extraCharges) },
      $push: { editHistory: { at: new Date(), by: null, byName: "System (partial submit removed)", changes } },
      $unset: { partialSubmit: "", entries: "", inLedger: "" },
    }
  );
}

// Leftover fields on every other invoice / item.
const invLeft = await invoicesCol.countDocuments({ $or: [{ partialSubmit: { $exists: true } }, { entries: { $exists: true } }, { inLedger: { $exists: true } }] });
const itemLeft = await itemsCol.countDocuments({ invoiceEntryId: { $exists: true } });
console.log(`  invoices with partialSubmit/entries/inLedger fields: ${invLeft}`);
console.log(`  inventory items with invoiceEntryId: ${itemLeft}`);
if (!DRY) {
  await invoicesCol.updateMany({}, { $unset: { partialSubmit: "", entries: "", inLedger: "" } });
  await itemsCol.updateMany({ invoiceEntryId: { $exists: true } }, { $unset: { invoiceEntryId: "" } });
  await itemsCol.dropIndex("invoiceEntryId_1").catch(() => {});
}

// The permission.
const module = await db.collection("modules").findOne({ key: MODULE_KEY }, { projection: { actions: 1 } });
if (module) {
  const targets = [
    { collection: "modules", filter: { _id: module._id }, fields: ["actions"] },
    { collection: "role_module_permissions", filter: { moduleId: module._id }, fields: ["allowedActions"] },
    { collection: "user_permission_overrides", filter: { moduleId: module._id }, fields: ["addActions", "removeActions"] },
    { collection: "department_module_restrictions", filter: { moduleId: module._id }, fields: ["allowedActions"] },
  ];
  console.log(`${DRY ? "[dry run] would remove" : "removing"} "${ACTION}" from the ${MODULE_KEY} module:`);
  for (const { collection, filter, fields } of targets) {
    for (const field of fields) {
      const match = { ...filter, [field]: ACTION };
      const count = await db.collection(collection).countDocuments(match);
      if (!DRY && count) await db.collection(collection).updateMany(match, { $pull: { [field]: ACTION } });
      console.log(`  ${`${collection}.${field}`.padEnd(46)} ${count} document(s)`);
    }
  }
}

await mongoose.disconnect();
