import mongoose from "mongoose";
import StockWarehouseModel from "../models/stock.warehouse.model.js";
import dotenv from "dotenv";
dotenv.config();

// Idempotent — safe to call on every app startup (see app.js) and also
// runnable standalone via `npm run seed:warehouse`.
export const seedMainWarehouse = async () => {
  try {
    const exists = await StockWarehouseModel.findOne({ code: "MAIN" }).lean();
    if (exists) return { seeded: false, warehouse: exists };

    const warehouse = await StockWarehouseModel.create({
      name: "Main Warehouse",
      code: "MAIN",
      address: "",
      description: "Default warehouse — auto-seeded",
    });
    console.info("Main Warehouse seeded");
    return { seeded: true, warehouse };
  } catch (error) {
    console.error("Error seeding Main Warehouse:", error);
    throw error;
  }
};

// ─── Run as standalone script ─────────────────────────────────────────────────
// node seeders/stock.warehouse.seeder.js
if (process.argv[1].includes("stock.warehouse.seeder")) {
  const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/erp";
  mongoose
    .connect(MONGO_URI)
    .then(async () => {
      await seedMainWarehouse();
      await mongoose.disconnect();
      process.exit(0);
    })
    .catch((err) => {
      console.error("DB connection error:", err);
      process.exit(1);
    });
}
