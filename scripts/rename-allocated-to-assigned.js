/**
 * One-shot migration for the item-status rename ALLOCATED → ASSIGNED.
 *
 * ALLOCATED was in the enum from the start but no flow ever set it. Issuing an
 * Item Request is the first thing that puts a unit with somebody, and it calls
 * that ASSIGNED. Any stray ALLOCATED row (set by hand through the old generic
 * status endpoint) is carried over so the enum can drop the old value.
 *
 * Idempotent; dry run unless --apply is passed.
 *
 * Run: node scripts/rename-allocated-to-assigned.js [--apply]
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

  // Raw collections: the model's enum no longer accepts ALLOCATED.
  for (const name of ["inventory_items", "inventory_item_movements"]) {
    const col = db.collection(name);
    const pending = await col.countDocuments({ status: "ALLOCATED" });
    console.log(`${name} on ALLOCATED: ${pending}`);
    if (pending && APPLY) {
      const res = await col.updateMany({ status: "ALLOCATED" }, { $set: { status: "ASSIGNED" } });
      console.log(`  → ${res.modifiedCount} renamed to ASSIGNED`);
    }
  }

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error("Migration failed:", err);
  await mongoose.disconnect();
  process.exit(1);
});
