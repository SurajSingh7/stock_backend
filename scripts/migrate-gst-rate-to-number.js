/**
 * One-shot migration for the GST-rates-as-data change.
 *
 * Two things happened in that commit:
 *   1. product_definitions.gstRate went from String ("18") to Number (18),
 *      matching how quotation and purchase-order lines have always stored it.
 *      Rows written before the change still hold the String.
 *   2. The slab list moved out of GST_RATES_ARRAY into the gstrates collection.
 *      The seeder writes the CURRENT slabs; a database can legitimately hold
 *      products priced at an older one (12%, 28%) that the seeder does not.
 *
 * So this does both halves:
 *   - casts every String gstRate to a Number, and
 *   - back-fills a gstrates row for any rate the data uses but the collection
 *     lacks, created INACTIVE (retired) — visible under the Inactive filter,
 *     restorable, and absent from the pickers that price new work. That keeps
 *     old products readable without quietly re-legalising a withdrawn slab.
 *
 * Idempotent: re-running finds nothing to do. Read-only unless --apply is
 * passed, so the default is a dry run you can inspect first.
 *
 * Run: node scripts/migrate-gst-rate-to-number.js [--apply]
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import StockGstRateModel from "../models/stock.gst.rate.model.js";
dotenv.config();

const APPLY = process.argv.includes("--apply");
const PRODUCTS = "product_definitions";

const run = async () => {
  const db = mongoose.connection.db;

  /* ── 1. String gstRate -> Number ──────────────────────────────────────── */
  const stringRated = await db
    .collection(PRODUCTS)
    .find({ gstRate: { $type: "string" } }, { projection: { name: 1, gstRate: 1 } })
    .toArray();

  console.info(`\n[1] product_definitions with a String gstRate: ${stringRated.length}`);

  const unparsable = stringRated.filter((p) => !Number.isFinite(Number(p.gstRate)));
  if (unparsable.length) {
    // Refuse the whole migration rather than write NaN into a tax field.
    console.error(
      `    ABORT — ${unparsable.length} row(s) hold a gstRate that is not a number: ` +
        unparsable.map((p) => `${p.name}=${JSON.stringify(p.gstRate)}`).join(", ")
    );
    return { aborted: true };
  }

  const byValue = stringRated.reduce((acc, p) => {
    acc[p.gstRate] = (acc[p.gstRate] || 0) + 1;
    return acc;
  }, {});
  Object.entries(byValue).forEach(([v, n]) => console.info(`    "${v}" -> ${Number(v)}  (${n} product(s))`));

  /* ── 2. gstrates rows for every rate the data actually uses ───────────── */
  // Numbers already migrated on an earlier run count too, so a re-run still
  // sees the full picture.
  const numericRates = await db.collection(PRODUCTS).distinct("gstRate", { gstRate: { $type: "number" } });
  const usedRates = [...new Set([...numericRates, ...stringRated.map((p) => Number(p.gstRate))])].sort(
    (a, b) => a - b
  );

  const existing = await StockGstRateModel.find({ rate: { $in: usedRates } })
    .select("rate isActive")
    .lean();
  const existingRates = new Set(existing.map((r) => r.rate));
  const missing = usedRates.filter((r) => !existingRates.has(r));

  console.info(`\n[2] rates in use: ${usedRates.join(", ") || "(none)"}`);
  console.info(`    already in gstrates: ${[...existingRates].sort((a, b) => a - b).join(", ") || "(none)"}`);
  console.info(`    to create as RETIRED: ${missing.join(", ") || "(none)"}`);

  if (!APPLY) {
    console.info("\nDry run — nothing written. Re-run with --apply to make these changes.");
    return { dryRun: true };
  }

  /* ── 3. Write ─────────────────────────────────────────────────────────── */
  for (const rate of missing) {
    await StockGstRateModel.create({
      rate,
      label: `${rate}%`,
      description: "Withdrawn slab — retained because existing products are priced at it.",
      order: 90 + rate / 100, // sorts below the seeded ladder, still in rate order
      isActive: false,
      deletedAt: new Date(),
    });
    console.info(`    created retired gstrates row: ${rate}%`);
  }

  let converted = 0;
  for (const product of stringRated) {
    const result = await db
      .collection(PRODUCTS)
      // Re-assert the String type in the filter so a concurrent write that
      // already fixed this row is not overwritten with a stale value.
      .updateOne({ _id: product._id, gstRate: { $type: "string" } }, { $set: { gstRate: Number(product.gstRate) } });
    converted += result.modifiedCount;
  }
  console.info(`\n    converted ${converted} product_definitions gstRate value(s) to Number`);

  const leftover = await db.collection(PRODUCTS).countDocuments({ gstRate: { $type: "string" } });
  console.info(`    remaining String gstRate values: ${leftover}`);
  return { converted, retired: missing.length, leftover };
};

mongoose
  .connect(process.env.MONGO_URI || "mongodb://localhost:27017/erp")
  .then(async () => {
    const result = await run();
    await mongoose.disconnect();
    process.exit(result?.aborted ? 1 : 0);
  })
  .catch((err) => {
    console.error("DB connection error:", err);
    process.exit(1);
  });
