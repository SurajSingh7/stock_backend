/**
 * One-shot migration for the item-status rename FAULTY → DEBITED.
 *
 * FAULTY was only ever set by an accepted debit note: it meant "the money for
 * this unit came back off the invoice and the unit goes back to the vendor".
 * It is renamed for what it actually records, so that a unit of OURS breaking
 * in use (paid for, to be repaired or claimed under warranty) can get a status
 * of its own without the two ever being confused — one shared status would let
 * the same unit be recovered twice. Nothing about what these rows mean changes;
 * only the stored string.
 *
 * Idempotent: re-running finds nothing to do. Read-only unless --apply is
 * passed, so the default is a dry run you can inspect first.
 *
 * Run: node scripts/rename-faulty-to-debited.js [--apply]
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

  // Raw collections on purpose: the model's enum no longer accepts FAULTY, and
  // a migration must be able to read the rows it exists to fix.
  for (const name of ["inventory_items", "inventory_item_movements"]) {
    const col = db.collection(name);
    const pending = await col.countDocuments({ status: "FAULTY" });
    console.log(`${name} on FAULTY: ${pending}`);
    if (pending && APPLY) {
      const res = await col.updateMany({ status: "FAULTY" }, { $set: { status: "DEBITED" } });
      console.log(`  → ${res.modifiedCount} renamed to DEBITED`);
    }
  }

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error("Migration failed:", err);
  await mongoose.disconnect();
  process.exit(1);
});
