/**
 * Terms & Conditions had a `status` (ACTIVE / INACTIVE) next to isActive. An
 * INACTIVE status kept a term out of PO creation, just like deleting it — two
 * switches for one thing. It was removed (2026-11-02); isActive is the only
 * on/off, set by Delete / Restore.
 *
 * So nothing changes for a PO: a term that was status INACTIVE (but not
 * deleted) becomes deleted — still never applied, now listed under Inactive
 * where it can be restored. Then the field is dropped from every term.
 *
 * Dry run by default; --apply writes, after saving the affected ids to
 * scripts/backups/. Idempotent.
 *
 * Run: node scripts/remove-terms-status.js            (dry run)
 *      node scripts/remove-terms-status.js --apply
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");

await mongoose.connect(process.env.MONGO_URI);
const col = mongoose.connection.db.collection("terms_conditions");
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${mongoose.connection.name}\n`);

const withStatus = await col.countDocuments({ status: { $exists: true } });
const toDeactivate = await col
  .find({ status: "INACTIVE", isActive: { $ne: false } }, { projection: { termName: 1, isDefault: 1 } })
  .toArray();

console.log(`terms with a status field              ${withStatus}`);
console.log(`status INACTIVE but not deleted        ${toDeactivate.length}  (will be marked deleted)`);
toDeactivate.forEach((t) => console.log(`  - ${t.termName}${t.isDefault ? "  (was default)" : ""}`));

if (!APPLY) {
  console.log("\nNothing written — run again with --apply.");
} else if (withStatus) {
  if (toDeactivate.length) {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "backups");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `terms-status-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify(toDeactivate, null, 2));
    console.log(`\nAffected ids saved: ${file}`);
    await col.updateMany(
      { _id: { $in: toDeactivate.map((t) => t._id) } },
      { $set: { isActive: false, deletedAt: new Date() } }
    );
  }
  const res = await col.updateMany({ status: { $exists: true } }, { $unset: { status: "" } });
  console.log(`Removed the status field from ${res.modifiedCount} terms.`);
} else {
  console.log("\nNothing to change.");
}

await mongoose.disconnect();
