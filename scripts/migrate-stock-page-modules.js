/**
 * Stock page modules (2026-11-17): the one "inventory-items" module ("Inventory
 * Items") became one per page, so each can be granted on its own —
 *
 *   available-products  Available Product   READ  (VIEW_MENU)
 *   available-items     Available Item      READ  (VIEW_MENU)
 *   product-summary     Product Summary     READ  (VIEW_MENU)
 *
 * The pages are read-only, so only READ and VIEW_MENU carry across; the old
 * module's edit actions (UPDATE, DELETE, RESTORE, UPDATE_STATUS, BULK_CREATE…)
 * had no screen and their APIs are gone. Whoever held READ / VIEW_MENU on
 * "inventory-items" gets it on all three, on role defaults, department
 * restrictions, user overrides (add and remove lists alike) and per-module data
 * scopes. The old module is then switched off (isActive: false) — never
 * deleted, so its audit trail still resolves.
 *
 * Safe whether or not the backend has already started on the new code (its
 * seeder may have created the three modules already). Idempotent.
 * Dry run by default; --apply writes.
 *
 * Run: node scripts/migrate-stock-page-modules.js            (dry run)
 *      node scripts/migrate-stock-page-modules.js --apply
 */
import "dotenv/config";
import mongoose from "mongoose";
import StockModuleModel from "../models/stock.module.model.js";
import StockRoleModulePermissionModel from "../models/stock.role.module.permission.model.js";
import StockDepartmentModuleRestrictionModel from "../models/stock.department.module.restriction.model.js";
import StockUserPermissionOverrideModel from "../models/stock.user.permission.override.model.js";
import StockUserDataScopeModel from "../models/stock.user.data.scope.model.js";

const APPLY = process.argv.includes("--apply");
const OLD_KEY = "inventory-items";
const TARGETS = {
  "available-products": "Available Product",
  "available-items": "Available Item",
  "product-summary": "Product Summary",
};
const ACTIONS = ["READ", "VIEW_MENU"];
// Old actions → the new modules' actions (the same two, the rest dropped).
const carry = (actions) => (actions || []).filter((a) => ACTIONS.includes(a));

await mongoose.connect(process.env.MONGO_URI);
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${mongoose.connection.name}\n`);

// The three modules — found (name and actions set), or created.
const target = {};
for (const [key, name] of Object.entries(TARGETS)) {
  const found = await StockModuleModel.findOne({ key }).lean();
  if (found) {
    target[key] = found;
    console.log(`module ${key.padEnd(19)} exists${found.name !== name ? ` — renamed to "${name}"` : ""}`);
    if (APPLY) await StockModuleModel.updateOne({ _id: found._id }, { $set: { name, actions: ACTIONS, isActive: true } });
  } else {
    console.log(`module ${key.padEnd(19)} will be created`);
    target[key] = APPLY ? (await StockModuleModel.create({ key, name, actions: ACTIONS })).toObject() : { _id: null, key };
  }
}

const old = await StockModuleModel.findOne({ key: OLD_KEY, isActive: true }).lean();
if (!old) {
  console.log(`\nNo active "${OLD_KEY}" module — nothing to carry across.`);
} else {
  const [roles, depts, overrides, scopes] = await Promise.all([
    StockRoleModulePermissionModel.find({ moduleId: old._id }).lean(),
    StockDepartmentModuleRestrictionModel.find({ moduleId: old._id }).lean(),
    StockUserPermissionOverrideModel.find({ moduleId: old._id }).lean(),
    StockUserDataScopeModel.find({ moduleId: old._id }).lean(),
  ]);
  console.log(`\n"${OLD_KEY}": ${roles.length} role(s), ${depts.length} department restriction(s), ${overrides.length} user override(s), ${scopes.length} data scope(s)`);
  roles.forEach((r) => console.log(`  role ${r.roleId}: ${carry(r.allowedActions).join(", ") || "(nothing to carry)"} → all three`));

  if (APPLY) {
    for (const key of Object.keys(TARGETS)) {
      const moduleId = target[key]._id;
      for (const r of roles) {
        const add = carry(r.allowedActions);
        if (add.length) {
          await StockRoleModulePermissionModel.updateOne({ roleId: r.roleId, moduleId }, { $addToSet: { allowedActions: { $each: add } } }, { upsert: true });
        }
      }
      // A restriction caps what the department may hold — written even when
      // empty, or the department would gain the whole module.
      for (const d of depts) {
        await StockDepartmentModuleRestrictionModel.updateOne(
          { departmentId: d.departmentId, moduleId },
          { $set: { allowedActions: carry(d.allowedActions) } },
          { upsert: true }
        );
      }
      for (const o of overrides) {
        const addActions = carry(o.addActions);
        const removeActions = carry(o.removeActions);
        if (addActions.length || removeActions.length) {
          await StockUserPermissionOverrideModel.updateOne(
            { userId: o.userId, moduleId },
            { $addToSet: { addActions: { $each: addActions }, removeActions: { $each: removeActions } }, $setOnInsert: { reason: o.reason || "" } },
            { upsert: true }
          );
        }
      }
      for (const sc of scopes) {
        const { _id, moduleId: _old, createdAt, updatedAt, __v, ...rest } = sc; // eslint-disable-line no-unused-vars
        if (!(await StockUserDataScopeModel.exists({ userId: sc.userId, moduleId }))) {
          await StockUserDataScopeModel.create({ ...rest, moduleId });
        }
      }
    }
    await StockModuleModel.updateOne({ _id: old._id }, { $set: { isActive: false } });
  }
}

console.log(APPLY ? "\nDone — grants carried across, \"inventory-items\" switched off." : "\nNothing written — run again with --apply.");
await mongoose.disconnect();
