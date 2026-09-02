/**
 * One-off backfill for rows created before the actor-stamp plugin existed.
 *
 * Two sources, in order of trust:
 *   1. The audit log, where a CREATE row already names the real person.
 *   2. A round-robin over the known users, for everything older than the
 *      audit log itself.
 *
 * (2) is a fabrication and is only acceptable because this is dummy data the
 * team is about to delete. It is deliberately spread across several people
 * rather than stamped with one, so that ownership scope is actually
 * exercisable: log in as any of them and OWN shows a subset, not everything
 * or nothing.
 *
 * Writes go through the driver, NOT Mongoose — the plugin's hooks would
 * otherwise overwrite the very fields being set with whoever is running this.
 *
 * Run: node scripts/backfill-actor-stamps.js [--dry]
 */
import mongoose from "mongoose";
import { mongoUri } from "../config/env.config.js";

const DRY = process.argv.includes("--dry");

// Real HRMS users seen in this database's audit trail.
// Pulled from HRMS /internal/user-context, not invented — these are the four
// people who actually appear in this database's audit trail.
const USERS = [
  { userId: "67fcaeefd7d3b3e80fa8d8ab", name: "Suraj  Singh",   email: "surajsingh@gtel.in",      phone: "9695215220", roleName: "Developer" },
  { userId: "683412faf69da640da90df73", name: "Amit Batra",     email: "amit@gtel.in",            phone: "8860606963", roleName: "Admin" },
  { userId: "67fcaee4d7d3b3e80fa8d4db", name: "PRADUMM  KUMAR", email: "GISPL056@gtel.in",        phone: "7409918796", roleName: "Standard Role" },
  { userId: "6979fe225aab35a29ffdbc70", name: "Abhay Tiwari",   email: "abhaykanttiwari@gtel.in", phone: "6393216862", roleName: "Standard Role" },
];
const BY_ID = new Map(USERS.map((u) => [u.userId, u]));

const COLLECTIONS = [
  "categories", "field_definitions", "product_definitions", "vendors",
  "terms_conditions", "notifications", "branches", "inventory_items",
  "transfer_requests", "quotations", "tracking_orders", "purchase_orders",
  "invoices",
];

await mongoose.connect(mongoUri);
const db = mongoose.connection.db;

const audit = db.collection("audit_logs");
let fromAudit = 0;
let fromRoundRobin = 0;
let cursorIndex = 0;
const perUser = new Map(USERS.map((u) => [u.name, 0]));

for (const name of COLLECTIONS) {
  const exists = await db.listCollections({ name }).hasNext();
  if (!exists) continue;
  const col = db.collection(name);

  const rows = await col
    // Catches both shapes: never stamped, and stamped under the older
    // flat-ObjectId design before createdBy became an embedded snapshot.
    .find({ "createdBy.userId": { $exists: false } })
    .project({ _id: 1 })
    .toArray();
  if (!rows.length) continue;

  for (const row of rows) {
    // Prefer the truth the audit log already holds.
    const created = await audit.findOne(
      { entityId: row._id, action: "CREATE", "actor.userId": { $ne: null } },
      { sort: { createdAt: 1 } }
    );
    // The most recent event of any kind is the best "last touched by".
    const latest = await audit.findOne(
      { entityId: row._id, "actor.userId": { $ne: null } },
      { sort: { createdAt: -1 } }
    );

    let creator;
    if (created) {
      // The audit log has no phone, so fill the rest from the known user
      // where we have them — otherwise keep what the audit recorded.
      creator = BY_ID.get(String(created.actor.userId)) ?? {
        userId: String(created.actor.userId),
        name: created.actor.name || "",
        email: created.actor.email || "",
        phone: "",
        roleName: created.actor.roleName || "",
      };
      fromAudit++;
    } else {
      creator = USERS[cursorIndex++ % USERS.length];
      fromRoundRobin++;
    }
    const updater = latest
      ? BY_ID.get(String(latest.actor.userId)) ?? {
          userId: String(latest.actor.userId),
          name: latest.actor.name || "",
          email: latest.actor.email || "",
          phone: "",
          roleName: latest.actor.roleName || "",
        }
      : creator;

    perUser.set(creator.name, (perUser.get(creator.name) ?? 0) + 1);

    if (!DRY) {
      await col.updateOne(
        { _id: row._id },
        {
          $set: {
            createdBy: { ...creator, userId: new mongoose.Types.ObjectId(creator.userId) },
            updatedBy: { ...updater, userId: new mongoose.Types.ObjectId(updater.userId) },
          },
          // Flat fields from the previous shape — the actor now lives in one
          // object, and leaving both would be two places to read the same thing.
          $unset: { createdByName: "", updatedByName: "", deletedByName: "" },
        }
      );
    }
  }
  console.log(`  ${name.padEnd(22)} ${rows.length} row(s)`);
}

console.log("");
console.log(`${DRY ? "[dry run] would stamp" : "stamped"} ${fromAudit + fromRoundRobin} row(s)`);
console.log(`  from the audit log : ${fromAudit}`);
console.log(`  round-robin        : ${fromRoundRobin}`);
console.log("");
console.log("createdBy distribution:");
for (const [name, n] of perUser) console.log(`  ${name.padEnd(20)} ${n}`);

await mongoose.disconnect();
