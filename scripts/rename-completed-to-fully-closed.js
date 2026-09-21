/**
 * One-shot migration for the tracking-status rename.
 *
 * TRACKING_STATUS.COMPLETED became FULLY_CLOSED when SHORT_CLOSED joined it as
 * the other end state, so the two would read as the pair they are: "we received
 * everything" vs "we closed early with less". Nothing about what the status
 * MEANS changed, and no other field moves — only the stored string.
 *
 * Idempotent: re-running finds nothing to do. Read-only unless --apply is
 * passed, so the default is a dry run you can inspect first.
 *
 * Run: node scripts/rename-completed-to-fully-closed.js [--apply]
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import StockTrackingOrderModel from "../models/stock.tracking.order.model.js";
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

  // Counted before the update so the log says what WOULD change, which is the
  // whole point of the dry run.
  const pending = await StockTrackingOrderModel.countDocuments({ status: "COMPLETED" });
  console.log(`Tracking orders on COMPLETED: ${pending}`);

  if (pending === 0) {
    console.log("Nothing to do — already migrated, or no completed orders exist.");
  } else if (!APPLY) {
    const sample = await StockTrackingOrderModel.find({ status: "COMPLETED" })
      .select("_id vendorName poId")
      .limit(5)
      .lean();
    sample.forEach((t) => console.log(`  would update ${t._id} (${t.vendorName || "—"})`));
    if (pending > sample.length) console.log(`  … and ${pending - sample.length} more`);
  } else {
    const res = await StockTrackingOrderModel.updateMany(
      { status: "COMPLETED" },
      { $set: { status: "FULLY_CLOSED" } }
    );
    console.log(`Updated: ${res.modifiedCount}`);

    const leftover = await StockTrackingOrderModel.countDocuments({ status: "COMPLETED" });
    console.log(
      leftover === 0 ? "Done — no COMPLETED rows remain." : `WARNING: ${leftover} rows still on COMPLETED.`
    );
  }

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error("Migration failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
