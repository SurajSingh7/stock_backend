/**
 * One-off: give existing vendors a branch.
 *
 * Order matters. This has to run BEFORE `vendors` is registered in
 * config/data.scope.registry.js — registering a dimension makes every user
 * default to OWN, so a vendor with branchId: null would become invisible to
 * everyone except admins, with no error to explain why.
 *
 * Source, in order of trust:
 *   1. createdBy.branchId — the branch the creator was in at the time.
 *   2. The branch of the creator's HRMS account today (older rows predate the
 *      snapshot carrying a branch).
 *   3. --default <branchId>, for rows where neither is known.
 *
 * Run: node scripts/backfill-vendor-branch.js [--dry] [--default <branchId>]
 */
import mongoose from "mongoose";
import { mongoUri, hrmsApiUrl, hrmsSvcApiKey } from "../config/env.config.js";
import { createHttpClient } from "../helpers/http.helper.js";

const DRY = process.argv.includes("--dry");
const defaultIdx = process.argv.indexOf("--default");
const DEFAULT_BRANCH = defaultIdx !== -1 ? process.argv[defaultIdx + 1] : null;

const hrms = createHttpClient({
  baseURL: hrmsApiUrl,
  headers: { "x-api-key": hrmsSvcApiKey },
  timeout: 8000,
});

// One lookup per user, not per vendor.
const branchCache = new Map();
const branchOfUser = async (userId) => {
  const key = String(userId);
  if (branchCache.has(key)) return branchCache.get(key);
  let branch = null;
  try {
    const res = await hrms.get(`/internal/user-context/${key}`);
    const user = res.data?.user ?? res.data?.data?.user;
    branch = user?.branch ?? null;
  } catch {
    branch = null; // deleted account, or HRMS down — falls through to default
  }
  branchCache.set(key, branch);
  return branch;
};

await mongoose.connect(mongoUri);
const vendors = mongoose.connection.db.collection("vendors");

const rows = await vendors
  .find({ $or: [{ branchId: null }, { branchId: { $exists: false } }] })
  .project({ name: 1, createdBy: 1 })
  .toArray();

let fromSnapshot = 0;
let fromHrms = 0;
let fromDefault = 0;
let unresolved = 0;

for (const v of rows) {
  let branchId = v.createdBy?.branchId ?? null;
  let source = "snapshot";

  if (!branchId && v.createdBy?.userId) {
    branchId = await branchOfUser(v.createdBy.userId);
    source = "hrms";
  }
  if (!branchId && DEFAULT_BRANCH) {
    branchId = DEFAULT_BRANCH;
    source = "default";
  }

  if (!branchId) {
    console.log(`  ${String(v.name).padEnd(24)} — no branch found, left null`);
    unresolved++;
    continue;
  }

  if (source === "snapshot") fromSnapshot++;
  else if (source === "hrms") fromHrms++;
  else fromDefault++;

  console.log(`  ${String(v.name).padEnd(24)} → ${branchId}  (${source})`);
  // Driver, not Mongoose: the actor-stamp hooks would rewrite updatedBy with
  // whoever is running this script.
  if (!DRY) {
    await vendors.updateOne(
      { _id: v._id },
      { $set: { branchId: new mongoose.Types.ObjectId(String(branchId)) } }
    );
  }
}

console.log("");
console.log(`${DRY ? "[dry run] would set" : "set"} ${fromSnapshot + fromHrms + fromDefault} vendor branch(es)`);
console.log(`  from createdBy.branchId : ${fromSnapshot}`);
console.log(`  from HRMS lookup        : ${fromHrms}`);
console.log(`  from --default          : ${fromDefault}`);
if (unresolved) {
  console.log(`  STILL NULL              : ${unresolved}  ← assign these before registering the scope`);
}

await mongoose.disconnect();
