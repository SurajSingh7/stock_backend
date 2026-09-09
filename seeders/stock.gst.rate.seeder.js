import mongoose from "mongoose";
import StockGstRateModel from "../models/stock.gst.rate.model.js";
import dotenv from "dotenv";
dotenv.config();

/**
 * Starting GST slabs.
 *
 * This replaces the old hardcoded `GST_RATES_ARRAY = ["0","5","12","18","28"]`
 * — the array that could only be corrected by a developer, which is exactly
 * why these are rows now.
 *
 * ⚠️ CONFIRM WITH FINANCE BEFORE PRODUCTION. These are the current slabs to the
 * best of our knowledge, but a GST slab is a legal figure and this file is not
 * the authority on it. The point of this module is that whatever ships here can
 * be corrected from the UI without a deploy — so an approximate seed is
 * recoverable, and getting it exact is a five-minute admin task, not a release.
 */
const SEED_DATA = [
  { rate: 0, label: "0%", description: "Exempt / nil-rated goods and services", order: 1 },
  { rate: 5, label: "5%", description: "Merit rate — essentials and mass-consumption items", order: 2 },
  { rate: 18, label: "18%", description: "Standard rate — most goods and services", order: 3 },
  { rate: 40, label: "40%", description: "Demerit rate — sin and luxury goods", order: 4 },
];

export const seedGstRates = async () => {
  try {
    let seeded = 0;
    let skipped = 0;

    for (const item of SEED_DATA) {
      // Matched on the rate alone, including retired rows: re-running the
      // seeder must never resurrect a slab an admin deliberately deactivated.
      const exists = await StockGstRateModel.findOne({ rate: item.rate }).lean();
      if (exists) {
        skipped++;
        continue;
      }
      await StockGstRateModel.create(item);
      seeded++;
    }

    console.info(`Stock GST rates seeded: ${seeded} created, ${skipped} skipped`);
    return { seeded, skipped };
  } catch (error) {
    console.error("Error seeding stock GST rates:", error);
    throw error;
  }
};

// ─── Run as standalone script ─────────────────────────────────────────────────
// node seeders/stock.gst.rate.seeder.js
if (process.argv[1].includes("stock.gst.rate.seeder")) {
  const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/erp";
  mongoose
    .connect(MONGO_URI)
    .then(async () => {
      await seedGstRates();
      await mongoose.disconnect();
      process.exit(0);
    })
    .catch((err) => {
      console.error("DB connection error:", err);
      process.exit(1);
    });
}
