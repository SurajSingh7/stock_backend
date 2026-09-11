/**
 * One-shot migration: warranty moves from whole YEARS to whole MONTHS.
 *
 * Field renames (value × 12):
 *   product_definitions.warrantyYears                            -> warrantyMonths
 *   vendors.assignedProducts[].products[].overrides.warrantyYears -> warrantyMonths
 *   quotations.items[].warrantyYears                             -> warrantyMonths
 *                                                                  (+ defaultWarrantyMonths, same value —
 *                                                                   nothing before this was ever overridden)
 *   quotations.categoryApprovals[].selections[].warrantyYears    -> warrantyMonths
 *
 * Product definitions and vendors are PRODUCTION data — take a backup
 * (mongodump) before running with --apply.
 *
 * Idempotent: only documents still holding a `warrantyYears` key are touched,
 * and each write re-asserts that in its filter, so a re-run (or a row a newer
 * backend already rewrote) is left alone. Read-only unless --apply is passed.
 *
 * Values that land outside 1–120 months, or are not whole months, are still
 * migrated (the data holds them today) but are LISTED — the API now refuses
 * to save them, so fix those products/vendors from the UI afterwards.
 *
 * Run: node scripts/migrate-warranty-to-months.js [--apply]
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import { isValidWarrantyMonths } from "../helpers/stock.warranty.helper.js";
dotenv.config();

const APPLY = process.argv.includes("--apply");

const toMonths = (years) =>
  years === null || years === undefined || years === "" ? null : Number(years) * 12;

const outOfRange = [];
const checkRange = (months, where) => {
  if (months !== null && !isValidWarrantyMonths(months)) outOfRange.push(`${where} = ${months} months`);
};

// Moves `warrantyYears` to `warrantyMonths` on one plain object, in place.
// Returns true when something changed.
const convertKey = (obj, where, { withDefault = false } = {}) => {
  if (!obj || typeof obj !== "object" || !Object.prototype.hasOwnProperty.call(obj, "warrantyYears")) {
    return false;
  }
  if (obj.warrantyMonths === undefined) obj.warrantyMonths = toMonths(obj.warrantyYears);
  if (withDefault && obj.defaultWarrantyMonths === undefined) obj.defaultWarrantyMonths = obj.warrantyMonths;
  delete obj.warrantyYears;
  checkRange(obj.warrantyMonths, where);
  return true;
};

const run = async () => {
  const db = mongoose.connection.db;
  const summary = {};

  /* ── 1. product_definitions ───────────────────────────────────────────── */
  const products = await db
    .collection("product_definitions")
    .find({ warrantyYears: { $exists: true } }, { projection: { name: 1, warrantyYears: 1, warrantyMonths: 1 } })
    .toArray();
  console.info(`\n[1] product_definitions still on warrantyYears: ${products.length}`);
  products.forEach((p) => {
    const months = p.warrantyMonths ?? toMonths(p.warrantyYears);
    console.info(`    ${p.name}: ${p.warrantyYears} yr -> ${months} months`);
    checkRange(months, `product "${p.name}"`);
  });

  /* ── 2. vendors (nested overrides) ────────────────────────────────────── */
  const vendors = await db
    .collection("vendors")
    .find(
      { "assignedProducts.products.overrides.warrantyYears": { $exists: true } },
      { projection: { name: 1, assignedProducts: 1 } }
    )
    .toArray();
  let overrideCount = 0;
  vendors.forEach((v) =>
    (v.assignedProducts || []).forEach((ap) =>
      (ap.products || []).forEach((p) => {
        if (convertKey(p.overrides, `vendor "${v.name}" product ${p.productId}`)) overrideCount += 1;
      })
    )
  );
  console.info(`\n[2] vendors with year-based overrides: ${vendors.length} (${overrideCount} override(s))`);

  /* ── 3. quotations (testing data) ─────────────────────────────────────── */
  const quotations = await db
    .collection("quotations")
    .find(
      {
        $or: [
          { "items.warrantyYears": { $exists: true } },
          { "categoryApprovals.selections.warrantyYears": { $exists: true } },
        ],
      },
      { projection: { quotationNumber: 1, items: 1, categoryApprovals: 1 } }
    )
    .toArray();
  quotations.forEach((q) => {
    (q.items || []).forEach((it) =>
      convertKey(it, `quotation ${q.quotationNumber} item ${it._id}`, { withDefault: true })
    );
    (q.categoryApprovals || []).forEach((ca) =>
      (ca.selections || []).forEach((s) => convertKey(s, `quotation ${q.quotationNumber} selection`))
    );
  });
  console.info(`\n[3] quotations with year-based lines: ${quotations.length}`);

  if (outOfRange.length) {
    console.warn(`\nWARN — ${outOfRange.length} value(s) outside 1–120 whole months (fix from the UI after migrating):`);
    outOfRange.forEach((l) => console.warn(`    ${l}`));
  }

  if (!APPLY) {
    console.info("\nDry run — nothing written. Re-run with --apply to make these changes.");
    return { dryRun: true };
  }

  /* ── 4. Write ─────────────────────────────────────────────────────────── */
  const prodResult = await db.collection("product_definitions").updateMany(
    { warrantyYears: { $exists: true }, warrantyMonths: { $exists: false } },
    [
      {
        $set: {
          warrantyMonths: {
            $cond: [{ $eq: [{ $ifNull: ["$warrantyYears", null] }, null] }, null, { $multiply: ["$warrantyYears", 12] }],
          },
        },
      },
      { $unset: "warrantyYears" },
    ]
  );
  // Rows that somehow already carry both keys: keep the months, drop the years.
  const prodCleanup = await db
    .collection("product_definitions")
    .updateMany({ warrantyYears: { $exists: true } }, { $unset: { warrantyYears: "" } });
  summary.products = prodResult.modifiedCount + prodCleanup.modifiedCount;

  summary.vendors = 0;
  for (const v of vendors) {
    const r = await db.collection("vendors").updateOne(
      { _id: v._id, "assignedProducts.products.overrides.warrantyYears": { $exists: true } },
      { $set: { assignedProducts: v.assignedProducts } }
    );
    summary.vendors += r.modifiedCount;
  }

  summary.quotations = 0;
  for (const q of quotations) {
    const r = await db.collection("quotations").updateOne(
      { _id: q._id },
      { $set: { items: q.items, categoryApprovals: q.categoryApprovals } }
    );
    summary.quotations += r.modifiedCount;
  }

  console.info(
    `\n    migrated: ${summary.products} product(s), ${summary.vendors} vendor(s), ${summary.quotations} quotation(s)`
  );

  const leftover = {
    products: await db.collection("product_definitions").countDocuments({ warrantyYears: { $exists: true } }),
    vendors: await db
      .collection("vendors")
      .countDocuments({ "assignedProducts.products.overrides.warrantyYears": { $exists: true } }),
    quotations: await db.collection("quotations").countDocuments({
      $or: [
        { "items.warrantyYears": { $exists: true } },
        { "categoryApprovals.selections.warrantyYears": { $exists: true } },
      ],
    }),
  };
  console.info(`    remaining warrantyYears: ${JSON.stringify(leftover)}`);
  return summary;
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
