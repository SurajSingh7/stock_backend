/**
 * One-off: quotations lost their edit route (PUT /quotations/:id), so the
 * "UPDATE" action on the quotations module no longer guards anything.
 *
 * The seeder only INSERTS missing modules, so dropping UPDATE from its list
 * never reaches an existing database. This removes it everywhere it is stored
 * for the quotations module:
 *
 *   1. modules.actions                               (what is grantable)
 *   2. role_module_permissions.allowedActions        (role defaults)
 *   3. user_permission_overrides.addActions / removeActions
 *   4. department_module_restrictions.allowedActions (department ceilings)
 *
 * 2–4 matter as much as 1: the access-control service rejects any action the
 * module does not list ("Invalid actions for this module: UPDATE"), so a stale
 * grant left behind would make the next save of that role/user/department fail.
 *
 * Idempotent — a re-run finds nothing to do.
 * Run: node scripts/remove-quotation-update-action.js [--dry]
 */
import mongoose from "mongoose";
import { mongoUri } from "../config/env.config.js";

const DRY = process.argv.includes("--dry");
const MODULE_KEY = "quotations";
const ACTION = "UPDATE";

await mongoose.connect(mongoUri);
const db = mongoose.connection.db;

const module = await db.collection("modules").findOne({ key: MODULE_KEY }, { projection: { actions: 1 } });
if (!module) {
  console.log(`No "${MODULE_KEY}" module in this database — nothing to do.`);
  await mongoose.disconnect();
  process.exit(0);
}

const targets = [
  { collection: "modules", filter: { _id: module._id }, fields: ["actions"] },
  { collection: "role_module_permissions", filter: { moduleId: module._id }, fields: ["allowedActions"] },
  { collection: "user_permission_overrides", filter: { moduleId: module._id }, fields: ["addActions", "removeActions"] },
  { collection: "department_module_restrictions", filter: { moduleId: module._id }, fields: ["allowedActions"] },
];

console.log(`${DRY ? "[dry run] would remove" : "removing"} "${ACTION}" from the ${MODULE_KEY} module:`);
for (const { collection, filter, fields } of targets) {
  for (const field of fields) {
    const match = { ...filter, [field]: ACTION };
    const count = await db.collection(collection).countDocuments(match);
    if (!DRY && count) await db.collection(collection).updateMany(match, { $pull: { [field]: ACTION } });
    console.log(`  ${`${collection}.${field}`.padEnd(46)} ${count} document(s)`);
  }
}

await mongoose.disconnect();
