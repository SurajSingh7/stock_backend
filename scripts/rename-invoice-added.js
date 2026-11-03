/**
 * One-shot migration: invoice status ADDED → UPLOADED (2026-11-03).
 *
 * "Added" read as if the work were done; the status means the vendor's invoice
 * has been uploaded and no item has been entered yet — the row's "+ Add Items"
 * says what comes next. Only the stored string changes.
 *
 * Run it with the backend stopped and BEFORE the new code starts: the new
 * model no longer accepts ADDED.
 *
 * Dry run by default; --apply writes, after saving the affected ids to
 * scripts/backups/. Idempotent.
 *
 * Run: node scripts/rename-invoice-added.js            (dry run)
 *      node scripts/rename-invoice-added.js --apply
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");

await mongoose.connect(process.env.MONGO_URI);
// The raw collection, not the model: the model's enum no longer lists ADDED.
const col = mongoose.connection.db.collection("invoices");
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${mongoose.connection.name}\n`);

const affected = await col
  .find({ status: "ADDED" }, { projection: { invoiceNumber: 1, trackingOrderId: 1 } })
  .toArray();
console.log(`Invoices on ADDED: ${affected.length}`);
affected.slice(0, 5).forEach((i) => console.log(`  - ${i.invoiceNumber}`));
if (affected.length > 5) console.log(`  … and ${affected.length - 5} more`);

if (!affected.length) {
  console.log("\nNothing to do — already migrated, or no invoices on ADDED.");
} else if (!APPLY) {
  console.log("\nNothing written — run again with --apply.");
} else {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `invoice-added-rename-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(affected, null, 2));
  console.log(`\nAffected ids saved: ${file}`);

  const res = await col.updateMany({ status: "ADDED" }, { $set: { status: "UPLOADED" } });
  console.log(`Updated ADDED → UPLOADED: ${res.modifiedCount}`);
  const leftover = await col.countDocuments({ status: "ADDED" });
  console.log(leftover === 0 ? "Done — no ADDED invoices remain." : `WARNING: ${leftover} invoices still on ADDED.`);
}

await mongoose.disconnect();
