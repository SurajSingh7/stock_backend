/**
 * "Faulty Items" (faulty-items) was renamed "Debit Note Items"
 * (debit-note-items) on 2026-11-20 — Faulty now means one of OUR units
 * waiting for repair, while this page lists units sent back to the vendor on
 * a debit note.
 *
 * Every grant points at the module's _id, so the simplest safe move is to
 * rename the module row itself: key and name change, every role default,
 * department restriction, user override and data scope keeps working.
 *
 * If the seeder already created "debit-note-items" (seed:modules was run
 * first), the old row's grants are carried onto it instead and the old row is
 * switched off (isActive: false — kept, so old audit rows still resolve).
 *
 * Dry run by default; --apply writes. Idempotent.
 *
 * Run: node scripts/rename-faulty-items-module.js            (dry run)
 *      node scripts/rename-faulty-items-module.js --apply
 */
import "dotenv/config";
import mongoose from "mongoose";
import StockModuleModel from "../models/stock.module.model.js";
import StockRoleModulePermissionModel from "../models/stock.role.module.permission.model.js";
import StockDepartmentModuleRestrictionModel from "../models/stock.department.module.restriction.model.js";
import StockUserPermissionOverrideModel from "../models/stock.user.permission.override.model.js";
import StockUserDataScopeModel from "../models/stock.user.data.scope.model.js";

const APPLY = process.argv.includes("--apply");
const OLD_KEY = "faulty-items";
const NEW_KEY = "debit-note-items";
const NEW_NAME = "Debit Note Items";

await mongoose.connect(process.env.MONGO_URI);
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${mongoose.connection.name}\n`);

const old = await StockModuleModel.findOne({ key: OLD_KEY, isActive: true }).lean();
const fresh = await StockModuleModel.findOne({ key: NEW_KEY }).lean();

if (!old) {
  console.log(`No active "${OLD_KEY}" module — nothing to do.`);
} else if (!fresh) {
  console.log(`"${OLD_KEY}" → "${NEW_KEY}" ("${NEW_NAME}"): renamed in place, every grant kept.`);
  if (APPLY) await StockModuleModel.updateOne({ _id: old._id }, { $set: { key: NEW_KEY, name: NEW_NAME } });
} else {
  const [roles, depts, overrides, scopes] = await Promise.all([
    StockRoleModulePermissionModel.find({ moduleId: old._id }).lean(),
    StockDepartmentModuleRestrictionModel.find({ moduleId: old._id }).lean(),
    StockUserPermissionOverrideModel.find({ moduleId: old._id }).lean(),
    StockUserDataScopeModel.find({ moduleId: old._id }).lean(),
  ]);
  console.log(`Both exist — carrying ${roles.length} role(s), ${depts.length} restriction(s), ${overrides.length} override(s), ${scopes.length} scope(s) onto "${NEW_KEY}", then switching "${OLD_KEY}" off.`);
  if (APPLY) {
    const moduleId = fresh._id;
    for (const r of roles)
      await StockRoleModulePermissionModel.updateOne({ roleId: r.roleId, moduleId }, { $addToSet: { allowedActions: { $each: r.allowedActions || [] } } }, { upsert: true });
    for (const d of depts)
      await StockDepartmentModuleRestrictionModel.updateOne({ departmentId: d.departmentId, moduleId }, { $set: { allowedActions: d.allowedActions || [] } }, { upsert: true });
    for (const o of overrides)
      await StockUserPermissionOverrideModel.updateOne(
        { userId: o.userId, moduleId },
        { $addToSet: { addActions: { $each: o.addActions || [] }, removeActions: { $each: o.removeActions || [] } }, $setOnInsert: { reason: o.reason || "" } },
        { upsert: true }
      );
    for (const sc of scopes) {
      const { _id, moduleId: _old, createdAt, updatedAt, __v, ...rest } = sc; // eslint-disable-line no-unused-vars
      if (!(await StockUserDataScopeModel.exists({ userId: sc.userId, moduleId }))) await StockUserDataScopeModel.create({ ...rest, moduleId });
    }
    await StockModuleModel.updateOne({ _id: moduleId }, { $set: { name: NEW_NAME, isActive: true } });
    await StockModuleModel.updateOne({ _id: old._id }, { $set: { isActive: false } });
  }
}
if (!APPLY) console.log("\nNothing written — run again with --apply.");
await mongoose.disconnect();
