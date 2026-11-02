/**
 * Product definitions had a second switch, status ACTIVE / DRAFT, next to
 * isActive. DRAFT stopped nothing — a draft product could be quoted, ordered,
 * received and transferred like any other — and only kept it out of the
 * low-stock check. It was removed (2026-11-02); isActive is the only on/off.
 *
 * This drops the leftover field. Products that were DRAFT simply become
 * ordinary products, which is what every screen already treated them as —
 * from now on the low-stock check covers them too.
 *
 * Dry run by default; --apply writes, after saving the DRAFT ids to
 * scripts/backups/. Idempotent.
 *
 * Run: node scripts/remove-product-draft-status.js            (dry run)
 *      node scripts/remove-product-draft-status.js --apply
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");

await mongoose.connect(process.env.MONGO_URI);
const col = mongoose.connection.db.collection("product_definitions");
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${mongoose.connection.name}\n`);

const withStatus = await col.countDocuments({ status: { $exists: true } });
const drafts = await col.find({ status: "DRAFT" }, { projection: { name: 1, isActive: 1 } }).toArray();

console.log(`products with a status field   ${withStatus}`);
console.log(`of which DRAFT                 ${drafts.length}`);
drafts.slice(0, 20).forEach((d) => console.log(`  - ${d.name}${d.isActive === false ? "  (deleted)" : ""}`));
if (drafts.length > 20) console.log(`  … and ${drafts.length - 20} more`);

if (!APPLY) {
  console.log(`\nNothing written — run again with --apply.`);
} else if (withStatus) {
  if (drafts.length) {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "backups");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `product-draft-status-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify(drafts.map((d) => ({ _id: d._id, name: d.name, status: "DRAFT" })), null, 2));
    console.log(`\nDRAFT ids saved: ${file}`);
  }
  const res = await col.updateMany({ status: { $exists: true } }, { $unset: { status: "" } });
  console.log(`Removed the status field from ${res.modifiedCount} products.`);
} else {
  console.log("\nNothing to change.");
}

await mongoose.disconnect();
