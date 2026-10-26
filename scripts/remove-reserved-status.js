/**
 * One-shot cleanup after "Currently with" / RESERVED was dropped (2026-10-26).
 *
 * Opening Stock used to take a free-text "Currently with" per line and post
 * such units as RESERVED, plus a free-text pre-system note (`legacy`). Both
 * are gone: stock that is with someone is now entered through Opening Issued
 * Stock, against a real person from the People Directory. So:
 *
 *   inventory_items          RESERVED → AVAILABLE (the old "currently with"
 *                            text is printed first, so those units can be
 *                            assigned properly); heldByNote and legacy removed
 *   inventory_item_movements status RESERVED → AVAILABLE
 *   opening_stock_entries    heldBy / lastUsedBy / historyRemarks removed from lines
 *
 * Idempotent: re-running finds nothing to do. Read-only unless --apply is
 * passed, so the default is a dry run you can inspect first.
 *
 * Run: node scripts/remove-reserved-status.js [--apply]
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

  // Raw collections on purpose: the model's enum no longer accepts RESERVED,
  // and a migration must be able to read the rows it exists to fix.
  const items = db.collection("inventory_items");
  const reserved = await items.find({ status: "RESERVED" }).project({ identifiers: 1, fieldValues: 1, heldByNote: 1 }).toArray();
  console.log(`inventory_items on RESERVED: ${reserved.length}`);
  reserved.forEach((it) => {
    const label = (it.identifiers || []).map((k) => k.slice(k.indexOf(":") + 1)).join(" / ") || String(it._id);
    console.log(`  ${label} — was "currently with ${it.heldByNote || "?"}"`);
  });
  const withOldFields = await items.countDocuments({ $or: [{ heldByNote: { $exists: true } }, { legacy: { $exists: true } }] });
  console.log(`inventory_items carrying heldByNote / legacy: ${withOldFields}`);

  const moves = db.collection("inventory_item_movements");
  const reservedMoves = await moves.countDocuments({ status: "RESERVED" });
  console.log(`inventory_item_movements on RESERVED: ${reservedMoves}`);

  const entries = db.collection("opening_stock_entries");
  const oldLines = { $or: [{ "lines.heldBy": { $exists: true } }, { "lines.lastUsedBy": { $exists: true } }, { "lines.historyRemarks": { $exists: true } }] };
  const entriesWithOld = await entries.countDocuments(oldLines);
  console.log(`opening_stock_entries with old line fields: ${entriesWithOld}`);

  if (APPLY) {
    if (reserved.length) {
      const res = await items.updateMany({ status: "RESERVED" }, { $set: { status: "AVAILABLE" } });
      console.log(`  → ${res.modifiedCount} unit(s) now AVAILABLE`);
    }
    if (withOldFields) {
      const res = await items.updateMany({ $or: [{ heldByNote: { $exists: true } }, { legacy: { $exists: true } }] }, { $unset: { heldByNote: "", legacy: "" } });
      console.log(`  → old fields removed from ${res.modifiedCount} unit(s)`);
    }
    if (reservedMoves) {
      const res = await moves.updateMany({ status: "RESERVED" }, { $set: { status: "AVAILABLE" } });
      console.log(`  → ${res.modifiedCount} movement(s) now AVAILABLE`);
    }
    if (entriesWithOld) {
      const res = await entries.updateMany(oldLines, { $unset: { "lines.$[].heldBy": "", "lines.$[].lastUsedBy": "", "lines.$[].historyRemarks": "" } });
      console.log(`  → old line fields removed from ${res.modifiedCount} entr(y/ies)`);
    }
  }

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error("Migration failed:", err);
  await mongoose.disconnect();
  process.exit(1);
});
