/**
 * One-shot migration: Item Requests from one category to many lines (2026-10-27).
 *
 * A request used to carry ONE category on itself (categoryId, categoryPath,
 * trackingMethod, unit, requestedQty, issuedQty). It now carries `lines` — one
 * per category — and each handover line says which request line it was for
 * (issues[].lines[].requestLineId). Every old ISSUE / REPLACE request becomes
 * a request with exactly that one line; a short-closed one gets the closure
 * on its line too, so it still reads "closed short".
 *
 * Non-destructive: the old top-level fields are left where they are (the model
 * no longer reads them), so nothing is lost if this has to be looked at again.
 * Idempotent: a request that already has lines is skipped. Read-only unless
 * --apply is passed, so the default is a dry run you can inspect first.
 *
 * Run: node scripts/migrate-item-request-lines.js [--apply]
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

const APPLY = process.argv.includes("--apply");

const run = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set — nothing to connect to.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? "APPLY" : "DRY RUN (pass --apply to write)"}`);
  const col = mongoose.connection.db.collection("item_requests");

  // Raw collection on purpose: the model no longer declares the old fields.
  const pending = await col
    .find({ categoryId: { $ne: null }, $or: [{ lines: { $exists: false } }, { lines: { $size: 0 } }] })
    .toArray();
  console.log(`item_requests still on one category: ${pending.length}`);

  let done = 0;
  for (const r of pending) {
    const lineId = new mongoose.Types.ObjectId();
    const closedShort = r.status === "PARTIALLY_CLOSED" && (r.issuedQty || 0) < (r.requestedQty || 0);
    const line = {
      _id: lineId,
      categoryId: r.categoryId,
      categoryPath: r.categoryPath || "",
      trackingMethod: r.trackingMethod,
      unit: r.unit || null,
      requestedQty: r.requestedQty || 0,
      issuedQty: r.issuedQty || 0,
      closure: closedShort ? r.closure || { reason: "", at: null } : null,
    };
    const issues = (r.issues || []).map((iss) => ({ ...iss, lines: (iss.lines || []).map((l) => ({ ...l, requestLineId: lineId })) }));
    console.log(`  ${r.requestNumber} ${r.status}: ${line.categoryPath} ${line.issuedQty}/${line.requestedQty}${closedShort ? " (closed short)" : ""}`);
    if (APPLY) {
      await col.updateOne({ _id: r._id }, { $set: { lines: [line], issues } });
      done++;
    }
  }
  if (APPLY) console.log(`  → ${done} request(s) now carry lines`);

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error("Migration failed:", err);
  await mongoose.disconnect();
  process.exit(1);
});
