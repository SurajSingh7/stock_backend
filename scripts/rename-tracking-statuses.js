/**
 * One-shot migration for the tracking-status rename (2026-11-03).
 *
 * Four statuses were renamed for what has arrived, so each reads on its own:
 *   IN_PROGRESS  → AWAITING_DELIVERY   PO approved, nothing received yet
 *   PARTIAL      → PARTLY_RECEIVED     some received, the rest still due
 *   FULLY_CLOSED → FULLY_RECEIVED      everything ordered has arrived
 *   SHORT_CLOSED → CLOSED_SHORT        closed early, the balance won't come
 * Nothing about what a status MEANS changed, and no other field moves — only
 * the stored string. Audit-log snapshots keep the old words; they record what
 * was true when written.
 *
 * Run it with the backend stopped and BEFORE the new code starts: the new
 * model no longer accepts the old values.
 *
 * Dry run by default; --apply writes, after saving the affected ids to
 * scripts/backups/. Idempotent.
 *
 * Run: node scripts/rename-tracking-statuses.js            (dry run)
 *      node scripts/rename-tracking-statuses.js --apply
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");
const RENAMES = {
  IN_PROGRESS: "AWAITING_DELIVERY",
  PARTIAL: "PARTLY_RECEIVED",
  FULLY_CLOSED: "FULLY_RECEIVED",
  SHORT_CLOSED: "CLOSED_SHORT",
};

await mongoose.connect(process.env.MONGO_URI);
// The raw collection, not the model: the model's enum no longer lists the old values.
const col = mongoose.connection.db.collection("tracking_orders");
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${mongoose.connection.name}\n`);

const affected = await col
  .find({ status: { $in: Object.keys(RENAMES) } }, { projection: { status: 1, vendorName: 1 } })
  .toArray();

for (const [from, to] of Object.entries(RENAMES)) {
  const n = affected.filter((t) => t.status === from).length;
  console.log(`${from.padEnd(13)} → ${to.padEnd(18)} ${n}`);
}

if (!affected.length) {
  console.log("\nNothing to do — already migrated, or no orders on the old statuses.");
} else if (!APPLY) {
  console.log(`\n${affected.length} orders would change. Nothing written — run again with --apply.`);
} else {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `tracking-status-rename-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(affected, null, 2));
  console.log(`\nAffected ids and old statuses saved: ${file}`);

  for (const [from, to] of Object.entries(RENAMES)) {
    const res = await col.updateMany({ status: from }, { $set: { status: to } });
    if (res.modifiedCount) console.log(`Updated ${from} → ${to}: ${res.modifiedCount}`);
  }
  const leftover = await col.countDocuments({ status: { $in: Object.keys(RENAMES) } });
  console.log(leftover === 0 ? "Done — no old statuses remain." : `WARNING: ${leftover} orders still on an old status.`);
}

await mongoose.disconnect();
