/**
 * One-shot migration: Item Requests went from "a quantity per ticked product"
 * to "a category and one quantity" — the store now decides which product(s)
 * go out.
 *
 * A request still in the old shape (a `lines` array) is folded into the new
 * one: requestedQty / issuedQty become the lines' totals, and the category's
 * tracking method and unit come from its lines (they were all one category).
 * What was issued is untouched — `issues` already names product and units;
 * only the old per-line id inside it is dropped.
 *
 * Idempotent; dry run unless --apply is passed.
 *
 * Run: node scripts/migrate-item-request-to-category-qty.js [--apply]
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

const APPLY = process.argv.includes("--apply");
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

const run = async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set — nothing to connect to.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected. Mode: ${APPLY ? "APPLY" : "DRY RUN (pass --apply to write)"}`);
  const col = mongoose.connection.db.collection("item_requests");

  const old = await col.find({ lines: { $exists: true } }).toArray();
  console.log(`Requests in the old shape: ${old.length}`);
  for (const r of old) {
    const lines = r.lines || [];
    const set = {
      trackingMethod: lines[0]?.trackingMethod || "individual",
      unit: lines[0]?.unit ?? null,
      requestedQty: round3(lines.reduce((s, l) => s + (l.requestedQty || 0), 0)),
      issuedQty: round3(lines.reduce((s, l) => s + (l.issuedQty || 0), 0)),
      issues: (r.issues || []).map((i) => ({ ...i, lines: (i.lines || []).map(({ lineId, ...rest }) => rest) })),
    };
    console.log(`  ${r.requestNumber}: ${lines.map((l) => `${l.productName} ${l.issuedQty}/${l.requestedQty}`).join(", ")} → ${set.issuedQty}/${set.requestedQty} ${set.trackingMethod}`);
    if (APPLY) await col.updateOne({ _id: r._id }, { $set: set, $unset: { lines: 1 } });
  }

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error("Migration failed:", err);
  await mongoose.disconnect();
  process.exit(1);
});
