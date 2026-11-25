/**
 * One-shot migration for the repair redesign (2026-11-19).
 *
 *   inventory_items
 *     status AT_VENDOR        → IN_REPAIR, repair.type WARRANTY (a claim went to a vendor;
 *                               repair.inWarranty false → PAID)
 *     status IN_REPAIR        → repair.type IN_HOUSE (it was our own bench)
 *     status VENDOR_REPLACED  → REPLACED
 *     repair.kind             → removed (repair.type replaces it)
 *
 *   inventory_item_movements
 *     status AT_VENDOR / VENDOR_REPLACED → IN_REPAIR / REPLACED
 *     type CLAIM_SENT                   → SENT_FOR_REPAIR
 *     type CLAIM_RETURNED               → REPAIRED
 *     type CLAIM_REJECTED, REPAIR_FAILED → NOT_REPAIRED
 *     type VENDOR_REPLACED              → REPLACED
 *     ref.type WARRANTY_CLAIM           → REPAIR
 *
 * Idempotent: re-running finds nothing to do. Read-only unless --apply is
 * passed, so the default is a dry run you can inspect first.
 *
 * Run: node scripts/migrate-repair-statuses.js [--apply]
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
  const db = mongoose.connection.db;

  // Raw collections on purpose: the models no longer accept the old values.
  const step = async (col, label, filter, update) => {
    const n = await db.collection(col).countDocuments(filter);
    console.log(`${col}: ${label} — ${n}`);
    if (n && APPLY) {
      const res = await db.collection(col).updateMany(filter, update);
      console.log(`  → ${res.modifiedCount} updated`);
    }
  };

  const items = "inventory_items";
  await step(items, "AT_VENDOR out of warranty → IN_REPAIR · PAID", { status: "AT_VENDOR", "repair.inWarranty": false },
    { $set: { status: "IN_REPAIR", "repair.type": "PAID" }, $unset: { "repair.kind": "" } });
  await step(items, "AT_VENDOR → IN_REPAIR · WARRANTY", { status: "AT_VENDOR" },
    { $set: { status: "IN_REPAIR", "repair.type": "WARRANTY" }, $unset: { "repair.kind": "" } });
  await step(items, "IN_REPAIR without a type → IN_HOUSE", { status: "IN_REPAIR", "repair.type": { $in: [null] } },
    { $set: { "repair.type": "IN_HOUSE" }, $unset: { "repair.kind": "" } });
  await step(items, "VENDOR_REPLACED → REPLACED", { status: "VENDOR_REPLACED" }, { $set: { status: "REPLACED" } });
  await step(items, "leftover repair.kind removed", { "repair.kind": { $exists: true } }, { $unset: { "repair.kind": "" } });

  const moves = "inventory_item_movements";
  await step(moves, "status AT_VENDOR → IN_REPAIR", { status: "AT_VENDOR" }, { $set: { status: "IN_REPAIR" } });
  await step(moves, "status VENDOR_REPLACED → REPLACED", { status: "VENDOR_REPLACED" }, { $set: { status: "REPLACED" } });
  await step(moves, "CLAIM_SENT → SENT_FOR_REPAIR", { type: "CLAIM_SENT" }, { $set: { type: "SENT_FOR_REPAIR" } });
  await step(moves, "CLAIM_RETURNED → REPAIRED", { type: "CLAIM_RETURNED" }, { $set: { type: "REPAIRED" } });
  await step(moves, "CLAIM_REJECTED / REPAIR_FAILED → NOT_REPAIRED", { type: { $in: ["CLAIM_REJECTED", "REPAIR_FAILED"] } }, { $set: { type: "NOT_REPAIRED" } });
  await step(moves, "VENDOR_REPLACED → REPLACED", { type: "VENDOR_REPLACED" }, { $set: { type: "REPLACED" } });
  await step(moves, "ref WARRANTY_CLAIM → REPAIR", { "ref.type": "WARRANTY_CLAIM" }, { $set: { "ref.type": "REPAIR" } });

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error("Migration failed:", err);
  await mongoose.disconnect();
  process.exit(1);
});
