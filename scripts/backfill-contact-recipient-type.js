/**
 * One-off: stamp recipientType onto vendor contacts saved before the field
 * existed.
 *
 * Why this and not a fallback in the query: the schema default is NONE now
 * (emailing is opt-in), so code that read a missing value as "TO" would be
 * wrong the moment anyone deliberately chose NONE. Better to make the existing
 * intent explicit in the data once than to carry a fallback that contradicts
 * the default forever.
 *
 * TO is the honest value for these rows — they ARE the addresses PO mail goes
 * to today, and flipping them to NONE would silently stop every vendor's mail.
 *
 * Run: node scripts/backfill-contact-recipient-type.js [--dry]
 */
import mongoose from "mongoose";
import { mongoUri } from "../config/env.config.js";

const DRY = process.argv.includes("--dry");

await mongoose.connect(mongoUri);
const vendors = mongoose.connection.db.collection("vendors");

const rows = await vendors
  .find({ "contacts.recipientType": { $exists: false } })
  .project({ name: 1, contacts: 1 })
  .toArray();

let stamped = 0;
for (const v of rows) {
  const next = (v.contacts || []).map((c) =>
    c.recipientType === undefined ? { ...c, recipientType: "TO" } : c
  );
  const changed = next.filter((c, i) => c.recipientType !== v.contacts[i]?.recipientType).length;
  if (!changed) continue;

  console.log(`  ${String(v.name).padEnd(24)} ${changed} contact(s)`);
  stamped += changed;
  // Written through the driver so no model hook re-derives the default.
  if (!DRY) await vendors.updateOne({ _id: v._id }, { $set: { contacts: next } });
}

console.log("");
console.log(`${DRY ? "[dry run] would stamp" : "stamped"} ${stamped} contact(s) as TO`);
await mongoose.disconnect();
