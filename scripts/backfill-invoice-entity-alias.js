// One-time backfill: invoices created before `entityAlias` existed have no
// such field, so an entity-scoped user would not see them at all (or, with
// unassigned treated as visible, would see every one of them regardless of
// entity). Copies the alias down from each invoice's tracking order.
//
// Idempotent — only touches invoices that still have no alias. Safe to re-run.
//   node scripts/backfill-invoice-entity-alias.js          (dry run)
//   node scripts/backfill-invoice-entity-alias.js --apply  (writes)
import mongoose from "mongoose";
import StockInvoiceModel from "../models/stock.invoice.model.js";
import StockTrackingOrderModel from "../models/stock.tracking.order.model.js";
import { mongoUri } from "../config/env.config.js";

const apply = process.argv.includes("--apply");

const run = async () => {
  await mongoose.connect(mongoUri);

  const pending = await StockInvoiceModel.find({
    $or: [{ entityAlias: { $exists: false } }, { entityAlias: "" }],
  })
    .select("_id trackingOrderId")
    .lean();

  console.log(`${pending.length} invoice(s) without an entity alias.`);
  if (pending.length === 0) {
    await mongoose.disconnect();
    return;
  }

  const trackingIds = [...new Set(pending.map((i) => String(i.trackingOrderId)))];
  const trackings = await StockTrackingOrderModel.find({ _id: { $in: trackingIds } })
    .select("_id buyerEntity.alias")
    .lean();
  const aliasByTracking = new Map(trackings.map((t) => [String(t._id), t.buyerEntity?.alias || ""]));

  let resolved = 0;
  let unresolved = 0;
  const ops = [];
  for (const invoice of pending) {
    const alias = aliasByTracking.get(String(invoice.trackingOrderId)) || "";
    if (!alias) {
      unresolved++;
      continue;
    }
    resolved++;
    ops.push({
      updateOne: { filter: { _id: invoice._id }, update: { $set: { entityAlias: alias } } },
    });
  }

  console.log(`  resolvable: ${resolved}`);
  console.log(`  unresolvable (tracking order has no entity): ${unresolved}`);

  if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --apply to write.");
  } else if (ops.length) {
    const res = await StockInvoiceModel.bulkWrite(ops);
    console.log(`\nUpdated ${res.modifiedCount} invoice(s).`);
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
