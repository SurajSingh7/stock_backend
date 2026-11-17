/**
 * Stock Transfer modules (2026-11-16) — one page each:
 *
 *   my-stock-requests       READ, CREATE, RECEIVE   (VIEW_MENU)   My Requests
 *   stock-requests-to-us    READ, SEND, DECLINE     (VIEW_MENU)   Requests to Us
 *   stock-transfer-history  READ                    (VIEW_MENU)   Transfer History
 *
 * Grants are carried across, action by action, from the modules these replace:
 *
 *   transfer-requests (production)        stock-transfers (test data 2026-11-13…14)
 *     READ / VIEW_MENU → all three          READ / VIEW_MENU → history
 *     CREATE  → mine CREATE + RECEIVE        SEND    → to-us SEND
 *               (who asks is who receives)   RECEIVE → mine RECEIVE
 *     PROCESS → to-us SEND
 *     REJECT  → to-us DECLINE
 *     RECEIVE → mine RECEIVE
 *
 * …on role defaults, department restrictions, user overrides (add and remove
 * lists alike) and per-module data scopes. my-stock-requests loses CANCEL
 * (a request can no longer be withdrawn). The old modules are switched off
 * (isActive: false) — never deleted, so their audit trail still resolves.
 *
 * Safe whether or not the backend has already started on the new code (its
 * seeder may have created the new modules already). Idempotent.
 * Dry run by default; --apply writes.
 *
 * Run: node scripts/migrate-transfer-modules.js            (dry run)
 *      node scripts/migrate-transfer-modules.js --apply
 */
import "dotenv/config";
import mongoose from "mongoose";
import StockModuleModel from "../models/stock.module.model.js";
import StockRoleModulePermissionModel from "../models/stock.role.module.permission.model.js";
import StockDepartmentModuleRestrictionModel from "../models/stock.department.module.restriction.model.js";
import StockUserPermissionOverrideModel from "../models/stock.user.permission.override.model.js";
import StockUserDataScopeModel from "../models/stock.user.data.scope.model.js";

const APPLY = process.argv.includes("--apply");
const MINE = "my-stock-requests";
const TO_US = "stock-requests-to-us";
const HISTORY = "stock-transfer-history";
const TARGETS = {
  [MINE]: { name: "Stock Transfer · My Requests", actions: ["READ", "CREATE", "RECEIVE", "VIEW_MENU"] },
  [TO_US]: { name: "Stock Transfer · Requests to Us", actions: ["READ", "SEND", "DECLINE", "VIEW_MENU"] },
  [HISTORY]: { name: "Stock Transfer · Transfer History", actions: ["READ", "VIEW_MENU"] },
};
// source module → old action → { target module: [new actions] }
const SOURCES = {
  "transfer-requests": {
    READ: { [MINE]: ["READ"], [TO_US]: ["READ"], [HISTORY]: ["READ"] },
    VIEW_MENU: { [MINE]: ["VIEW_MENU"], [TO_US]: ["VIEW_MENU"], [HISTORY]: ["VIEW_MENU"] },
    CREATE: { [MINE]: ["CREATE", "RECEIVE"] },
    PROCESS: { [TO_US]: ["SEND"] },
    REJECT: { [TO_US]: ["DECLINE"] },
    RECEIVE: { [MINE]: ["RECEIVE"] },
  },
  "stock-transfers": {
    READ: { [HISTORY]: ["READ"] },
    VIEW_MENU: { [HISTORY]: ["VIEW_MENU"] },
    SEND: { [TO_US]: ["SEND"] },
    RECEIVE: { [MINE]: ["RECEIVE"] },
  },
};
const mapActions = (map, actions, key) => [...new Set((actions || []).flatMap((a) => map[a]?.[key] || []))];

await mongoose.connect(process.env.MONGO_URI);
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${mongoose.connection.name}\n`);

// The three modules — found (name and actions set), or created.
const target = {};
for (const [key, def] of Object.entries(TARGETS)) {
  const found = await StockModuleModel.findOne({ key }).lean();
  if (found) {
    target[key] = found;
    const sameActions = [...found.actions].sort().join() === [...def.actions].sort().join();
    console.log(`module ${key.padEnd(23)} exists${found.name !== def.name ? ` — renamed to "${def.name}"` : ""}${sameActions ? "" : ` — actions → ${def.actions.join(", ")}`}`);
    // The seeder never renames or removes actions, so both are set here.
    if (APPLY) await StockModuleModel.updateOne({ _id: found._id }, { $set: { name: def.name, actions: def.actions, isActive: true } });
  } else {
    console.log(`module ${key.padEnd(23)} will be created`);
    target[key] = APPLY ? (await StockModuleModel.create({ key, ...def })).toObject() : { _id: null, key };
  }
}

// CANCEL is gone from My Requests — off every grant that still has it.
if (target[MINE]._id) {
  const filter = { moduleId: target[MINE]._id };
  const withCancel = await StockRoleModulePermissionModel.countDocuments({ ...filter, allowedActions: "CANCEL" });
  console.log(`\n${MINE}: CANCEL removed from ${withCancel} role grant(s) (and any restriction / override)`);
  if (APPLY) {
    await StockRoleModulePermissionModel.updateMany(filter, { $pull: { allowedActions: "CANCEL" } });
    await StockDepartmentModuleRestrictionModel.updateMany(filter, { $pull: { allowedActions: "CANCEL" } });
    await StockUserPermissionOverrideModel.updateMany(filter, { $pull: { addActions: "CANCEL", removeActions: "CANCEL" } });
  }
}

for (const [sourceKey, map] of Object.entries(SOURCES)) {
  const old = await StockModuleModel.findOne({ key: sourceKey, isActive: true }).lean();
  if (!old) {
    console.log(`\n"${sourceKey}": not active — nothing to carry across.`);
    continue;
  }
  const [roles, depts, overrides, scopes] = await Promise.all([
    StockRoleModulePermissionModel.find({ moduleId: old._id }).lean(),
    StockDepartmentModuleRestrictionModel.find({ moduleId: old._id }).lean(),
    StockUserPermissionOverrideModel.find({ moduleId: old._id }).lean(),
    StockUserDataScopeModel.find({ moduleId: old._id }).lean(),
  ]);
  console.log(`\n"${sourceKey}": ${roles.length} role(s), ${depts.length} department restriction(s), ${overrides.length} user override(s), ${scopes.length} data scope(s)`);

  for (const key of Object.keys(TARGETS)) {
    for (const r of roles) {
      const add = mapActions(map, r.allowedActions, key);
      if (add.length) console.log(`  role ${r.roleId} → ${key}: ${add.join(", ")}`);
      if (APPLY && add.length) {
        await StockRoleModulePermissionModel.updateOne(
          { roleId: r.roleId, moduleId: target[key]._id },
          { $addToSet: { allowedActions: { $each: add } } },
          { upsert: true }
        );
      }
    }
    for (const d of depts) {
      // A restriction caps what the department may hold. Merged, so a second
      // source widens the cap rather than replacing the first one's.
      const allowed = mapActions(map, d.allowedActions, key);
      if (APPLY) {
        await StockDepartmentModuleRestrictionModel.updateOne(
          { departmentId: d.departmentId, moduleId: target[key]._id },
          { $addToSet: { allowedActions: { $each: allowed } } },
          { upsert: true }
        );
      }
    }
    for (const o of overrides) {
      const addActions = mapActions(map, o.addActions, key);
      const removeActions = mapActions(map, o.removeActions, key);
      if (APPLY && (addActions.length || removeActions.length)) {
        await StockUserPermissionOverrideModel.updateOne(
          { userId: o.userId, moduleId: target[key]._id },
          { $addToSet: { addActions: { $each: addActions }, removeActions: { $each: removeActions } }, $setOnInsert: { reason: o.reason || "" } },
          { upsert: true }
        );
      }
    }
    for (const s of scopes) {
      const { _id, moduleId, createdAt, updatedAt, __v, ...rest } = s; // eslint-disable-line no-unused-vars
      if (APPLY && !(await StockUserDataScopeModel.exists({ userId: s.userId, moduleId: target[key]._id }))) {
        await StockUserDataScopeModel.create({ ...rest, moduleId: target[key]._id });
      }
    }
  }
  if (APPLY) await StockModuleModel.updateOne({ _id: old._id }, { $set: { isActive: false } });
}

console.log(APPLY ? "\nDone — grants carried across, old modules switched off." : "\nNothing written — run again with --apply.");
await mongoose.disconnect();
