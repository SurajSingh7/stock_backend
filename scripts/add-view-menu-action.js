/**
 * One-off: introduce the VIEW_MENU action without anyone's navigation
 * disappearing.
 *
 * Two halves, and both are required:
 *
 *   1. Add VIEW_MENU to every module's action list. The seeder only INSERTS
 *      modules it does not find, so a new action on an existing module never
 *      reaches the database on its own.
 *
 *   2. Grant VIEW_MENU everywhere a module is already granted. Nav items ask
 *      for VIEW_MENU from the moment this ships, so without this step every
 *      user's menu empties out. Backfilling makes the change opt-OUT: today's
 *      navigation is preserved exactly, and the client removes VIEW_MENU only
 *      where they actually want a module hidden.
 *
 * Run: node scripts/add-view-menu-action.js [--dry]
 */
import mongoose from "mongoose";
import { mongoUri } from "../config/env.config.js";

const DRY = process.argv.includes("--dry");
const ACTION = "VIEW_MENU";

await mongoose.connect(mongoUri);
const db = mongoose.connection.db;

/* ── 1. modules ─────────────────────────────────────────────────────────── */
const modules = await db.collection("modules").find({}).project({ key: 1, actions: 1 }).toArray();
let moduleCount = 0;
for (const m of modules) {
  if ((m.actions || []).includes(ACTION)) continue;
  console.log(`  module  ${String(m.key).padEnd(22)} + ${ACTION}`);
  moduleCount++;
  if (!DRY) {
    await db.collection("modules").updateOne({ _id: m._id }, { $addToSet: { actions: ACTION } });
  }
}

/* ── 2. existing grants ─────────────────────────────────────────────────── */
const moduleName = new Map(modules.map((m) => [String(m._id), m.key]));

// Role defaults: a role that can do anything with a module keeps its menu.
const roleGrants = await db.collection("role_module_permissions").find({}).toArray();
let roleCount = 0;
for (const g of roleGrants) {
  if ((g.allowedActions || []).includes(ACTION)) continue;
  console.log(`  role    ${String(moduleName.get(String(g.moduleId))).padEnd(22)} role=${g.roleId}`);
  roleCount++;
  if (!DRY) {
    await db
      .collection("role_module_permissions")
      .updateOne({ _id: g._id }, { $addToSet: { allowedActions: ACTION } });
  }
}

// User overrides: same reasoning. Only rows that ADD something get the menu —
// an override that exists purely to REMOVE actions is not granting access and
// must not start granting a menu.
const overrides = await db.collection("user_permission_overrides").find({}).toArray();
let overrideCount = 0;
let skipped = 0;
for (const o of overrides) {
  if ((o.addActions || []).includes(ACTION)) continue;
  if (!(o.addActions || []).length) {
    skipped++;
    continue;
  }
  console.log(`  user    ${String(moduleName.get(String(o.moduleId))).padEnd(22)} user=${o.userId}`);
  overrideCount++;
  if (!DRY) {
    await db
      .collection("user_permission_overrides")
      .updateOne({ _id: o._id }, { $addToSet: { addActions: ACTION } });
  }
}

console.log("");
console.log(`${DRY ? "[dry run] would update" : "updated"}:`);
console.log(`  modules          : ${moduleCount}`);
console.log(`  role grants      : ${roleCount}`);
console.log(`  user overrides   : ${overrideCount}`);
if (skipped) console.log(`  skipped (remove-only overrides, grant nothing) : ${skipped}`);

await mongoose.disconnect();
