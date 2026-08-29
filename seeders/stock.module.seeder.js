import mongoose from "mongoose";
import dotenv from "dotenv";
import StockModuleModel from "../models/stock.module.model.js";
import { STANDARD_ACTIONS } from "../constants/stock.enums.js";
dotenv.config();

// One entry per resource in routes/v1.stock.routes.js. `key` matches the
// route prefix so requirePermission(key, action) reads naturally at the
// call site. Only inserts what's missing — an admin's later edits to a
// module's action list (via the access-control API) are never overwritten
// on restart.
const MODULE_DEFINITIONS = [
  { key: "field-definitions", name: "Field Definitions", actions: STANDARD_ACTIONS },
  { key: "categories", name: "Categories", actions: [...STANDARD_ACTIONS, "REORDER", "MOVE", "TOGGLE_TYPE"] },
  { key: "product-definitions", name: "Product Definitions", actions: STANDARD_ACTIONS },
  { key: "vendors", name: "Vendors", actions: STANDARD_ACTIONS },
  { key: "terms-conditions", name: "Terms & Conditions", actions: STANDARD_ACTIONS },
  { key: "inventory-items", name: "Inventory Items", actions: [...STANDARD_ACTIONS, "BULK_CREATE", "UPDATE_STATUS"] },
  { key: "quotations", name: "Quotations", actions: [...STANDARD_ACTIONS, "REVIEW", "DISABLE_VENDOR", "ENABLE_VENDOR"] },
  { key: "purchase-orders", name: "Purchase Orders", actions: ["CREATE", "READ", "UPDATE", "DELETE", "APPROVE", "REJECT", "SEND_MAIL"] },
  { key: "tracking-orders", name: "Tracking Orders", actions: ["READ", "ADD_ENTITY", "MARK_NOT_REQUIRED"] },
  { key: "invoices", name: "Invoices", actions: ["CREATE", "READ", "UPDATE", "APPROVE", "REJECT"] },
  { key: "branches", name: "Branches", actions: STANDARD_ACTIONS },
  { key: "transfer-requests", name: "Transfer Requests", actions: ["CREATE", "READ", "PROCESS", "REJECT"] },
  { key: "notifications", name: "Notifications", actions: STANDARD_ACTIONS },
];

export const seedModules = async () => {
  try {
    const existingKeys = new Set((await StockModuleModel.find({}, "key").lean()).map((m) => m.key));
    const missing = MODULE_DEFINITIONS.filter((m) => !existingKeys.has(m.key));
    if (missing.length === 0) return { seeded: false, count: 0 };

    await StockModuleModel.insertMany(missing);
    console.info(`Seeded ${missing.length} module(s): ${missing.map((m) => m.key).join(", ")}`);
    return { seeded: true, count: missing.length };
  } catch (error) {
    console.error("Error seeding modules:", error);
    throw error;
  }
};

// ─── Run as standalone script ─────────────────────────────────────────────────
// node seeders/stock.module.seeder.js
if (process.argv[1].includes("stock.module.seeder")) {
  const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/stock_db";
  mongoose
    .connect(MONGO_URI)
    .then(async () => {
      await seedModules();
      await mongoose.disconnect();
      process.exit(0);
    })
    .catch((err) => {
      console.error("DB connection error:", err);
      process.exit(1);
    });
}
