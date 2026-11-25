/**
 * "stock-reports" (Stock → Stock Reports: position, value, warranty, with
 * subscribers, repairs ageing) was removed on 2026-11-19 — Item Summary,
 * Product Summary, Available Item and Repair & Warranty cover what it showed.
 * No route, page or seeder uses it any more. This switches the module off
 * (isActive: false) — kept, not deleted, so old audit rows still name it.
 *
 * Dry run by default; --apply writes. Idempotent.
 *
 * Run: node scripts/retire-stock-reports-module.js            (dry run)
 *      node scripts/retire-stock-reports-module.js --apply
 */
import "dotenv/config";
import mongoose from "mongoose";
import StockModuleModel from "../models/stock.module.model.js";
import StockRoleModulePermissionModel from "../models/stock.role.module.permission.model.js";

const APPLY = process.argv.includes("--apply");
await mongoose.connect(process.env.MONGO_URI);
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${mongoose.connection.name}\n`);

const mod = await StockModuleModel.findOne({ key: "stock-reports", isActive: true }).lean();
if (!mod) {
  console.log("No active stock-reports module — nothing to do.");
} else {
  const grants = await StockRoleModulePermissionModel.countDocuments({ moduleId: mod._id });
  console.log(`stock-reports is active; ${grants} role(s) still hold it.`);
  if (APPLY) {
    await StockModuleModel.updateOne({ _id: mod._id }, { $set: { isActive: false } });
    console.log("Switched off.");
  } else {
    console.log("Nothing written — run again with --apply.");
  }
}
await mongoose.disconnect();
