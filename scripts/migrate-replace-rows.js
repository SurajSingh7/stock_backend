/**
 * One-shot migration: Replace requests to one row per item (2026-10-28).
 *
 * A REPLACE used to carry one outgoing line per CATEGORY of the items coming
 * back, and counted as PARTIAL as soon as an old item was received. It now
 * carries one outgoing line per ITEM coming back (lines[].returnLineId), and
 * is PARTIAL only once something is actually swapped (old back AND new out).
 *
 * For each REPLACE whose lines are not yet linked:
 *   - one line for exactly one item of its category → just linked;
 *   - nothing issued yet → lines rebuilt, one per item;
 *   - otherwise (several items shared a line that has gone out in part) →
 *     reported and left alone; settle it by hand.
 * Open requests then get their status recomputed under the new rule.
 *
 * Idempotent; dry run unless --apply is passed.
 *
 * Run: node scripts/migrate-replace-rows.js [--apply]
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

const APPLY = process.argv.includes("--apply");
const OPEN = ["PENDING", "PARTIAL"];

const run = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set — nothing to connect to.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? "APPLY" : "DRY RUN (pass --apply to write)"}`);
  const col = mongoose.connection.db.collection("item_requests");

  const rows = await col.find({ type: "REPLACE", "lines.returnLineId": { $exists: false } }).toArray();
  console.log(`Replace requests not yet one row per item: ${rows.length}`);

  let done = 0;
  for (const r of rows) {
    const byCategory = new Map();
    for (const rl of r.returnLines || []) {
      const k = String(rl.categoryId);
      byCategory.set(k, [...(byCategory.get(k) || []), rl]);
    }
    let lines = null;
    if ((r.lines || []).every((l) => (byCategory.get(String(l.categoryId)) || []).length === 1)) {
      lines = r.lines.map((l) => ({ ...l, returnLineId: byCategory.get(String(l.categoryId))[0]._id }));
    } else if (!(r.issuedQty > 0)) {
      lines = (r.returnLines || []).map((rl) => {
        const base = r.lines.find((l) => String(l.categoryId) === String(rl.categoryId)) || {};
        return { ...base, _id: new mongoose.Types.ObjectId(), requestedQty: rl.requestedQty, issuedQty: 0, closure: base.closure || null, returnLineId: rl._id };
      });
    }
    if (!lines) {
      console.log(`  ${r.requestNumber} ${r.status}: SKIPPED — several items shared a line that has gone out in part`);
      continue;
    }

    let status = r.status;
    if (OPEN.includes(r.status)) {
      const settled = lines.every((l) => l.closure || (l.issuedQty || 0) >= (l.requestedQty || 0));
      const short = lines.some((l) => l.closure && (l.issuedQty || 0) < (l.requestedQty || 0));
      status = settled ? (short ? "PARTIALLY_CLOSED" : "COMPLETED") : (r.issuedQty || 0) > 0 ? "PARTIAL" : "PENDING";
    }
    console.log(`  ${r.requestNumber}: ${lines.length} row(s), status ${r.status}${status !== r.status ? ` → ${status}` : ""}`);
    if (APPLY) {
      await col.updateOne({ _id: r._id }, { $set: { lines, status, requestedQty: lines.reduce((s, l) => s + (l.requestedQty || 0), 0) } });
      done++;
    }
  }
  if (APPLY) console.log(`  → ${done} request(s) updated`);

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error("Migration failed:", err);
  await mongoose.disconnect();
  process.exit(1);
});
