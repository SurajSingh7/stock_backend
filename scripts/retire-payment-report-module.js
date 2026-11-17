/**
 * "payment-report" is a module left in the database from before the reports
 * were split (it became Paid — "paid-report"). No route, page or seeder uses
 * it any more, and the Modules & Actions screen flags it as unregistered.
 * This switches it off (isActive: false) — kept, not deleted, so old audit
 * rows still name it.
 *
 * Dry run by default; --apply writes. Idempotent.
 *
 * Run: node scripts/retire-payment-report-module.js            (dry run)
 *      node scripts/retire-payment-report-module.js --apply
 */
import "dotenv/config";
import mongoose from "mongoose";
import StockModuleModel from "../models/stock.module.model.js";
import StockRoleModulePermissionModel from "../models/stock.role.module.permission.model.js";

const APPLY = process.argv.includes("--apply");
await mongoose.connect(process.env.MONGO_URI);
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${mongoose.connection.name}\n`);

const mod = await StockModuleModel.findOne({ key: "payment-report", isActive: true }).lean();
if (!mod) {
  console.log("No active payment-report module — nothing to do.");
} else {
  const grants = await StockRoleModulePermissionModel.countDocuments({ moduleId: mod._id });
  console.log(`payment-report is active; ${grants} role(s) still hold it (Paid has its own module, paid-report).`);
  if (APPLY) {
    await StockModuleModel.updateOne({ _id: mod._id }, { $set: { isActive: false } });
    console.log("Switched off.");
  } else {
    console.log("Nothing written — run again with --apply.");
  }
}
await mongoose.disconnect();
