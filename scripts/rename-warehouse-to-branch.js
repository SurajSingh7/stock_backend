/**
 * In-place migration for the warehouse → branch rename.
 *
 * The code now speaks `branch` everywhere: the master collection is
 * `branches` and the foreign key on every stock document is `branchId`
 * (was `warehouseId`) / `requestingBranchId` / `sourceBranchId`. This
 * migration brings existing documents to those names WITHOUT deleting
 * anything — branch ids are preserved, so HRMS Logins that already store a
 * branch ObjectId keep resolving and nothing has to be re-created by hand.
 *
 * Safe to re-run: every step filters on the old field/collection still
 * being present, so a second run is a no-op rather than an error.
 *
 *   node scripts/rename-warehouse-to-branch.js            # dry run
 *   node scripts/rename-warehouse-to-branch.js --confirm  # actually writes
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

// Plain top-level field renames — { collection: { oldName: newName } }.
// The branch master itself is added at runtime: which collection holds it
// depends on whether step 1 has already renamed it (see branchMasterColl).
const FIELD_RENAMES = {
  inventory_items: { warehouseId: "branchId" },
  invoices: { warehouseId: "branchId" },
  inventory_consumptions: { warehouseId: "branchId" },
  inventory_transfer_requests: {
    requestingLocationId: "requestingBranchId",
    sourceLocationId: "sourceBranchId",
  },
};

// Every old → new key, used for the audit-log snapshot rewrite below.
const KEY_MAP = {
  warehouseId: "branchId",
  locationRole: "branchRole",
  requestingLocationId: "requestingBranchId",
  sourceLocationId: "sourceBranchId",
  warehouseThresholds: "branchThresholds",
};

// Indexes built on a renamed field are dead weight once the field is gone —
// Mongoose rebuilds the correct ones on next boot. Matched by key name.
const DEAD_INDEX_FIELDS = [
  "warehouseId",
  "locationRole",
  "requestingLocationId",
  "sourceLocationId",
  "warehouseThresholds.warehouseId",
];

// Rebuilds the threshold rows inside an audit-log snapshot. renameSnapshotKeys
// below only reaches top-level keys, so the rows nested in the (already
// renamed) branchThresholds array need this second pass of their own.
const renameThresholdRows = (field) => ({
  $cond: {
    if: { $isArray: `${field}.branchThresholds` },
    then: {
      $mergeObjects: [
        field,
        {
          branchThresholds: {
            $map: {
              input: `${field}.branchThresholds`,
              as: "t",
              in: {
                branchId: { $ifNull: ["$$t.warehouseId", "$$t.branchId"] },
                threshold: "$$t.threshold",
              },
            },
          },
        },
      ],
    },
    else: field,
  },
});

// Rewrites the top-level keys of an audit-log `before`/`after` snapshot.
const renameSnapshotKeys = (field) => ({
  $cond: {
    if: { $eq: [{ $type: field }, "object"] },
    then: {
      $arrayToObject: {
        $map: {
          input: { $objectToArray: field },
          as: "kv",
          in: {
            k: {
              $switch: {
                branches: Object.entries(KEY_MAP).map(([from, to]) => ({
                  case: { $eq: ["$$kv.k", from] },
                  then: to,
                })),
                default: "$$kv.k",
              },
            },
            v: "$$kv.v",
          },
        },
      },
    },
    else: field,
  },
});

// Everything that points at a module by ObjectId — what a module doc would
// take with it if it were deleted instead of renamed.
const countModuleGrants = async (db, moduleId) => {
  const sources = {
    roleGrants: "role_module_permissions",
    overrides: "user_permission_overrides",
    scopePolicies: "access_scope_policies",
  };
  const counts = {};
  for (const [label, coll] of Object.entries(sources)) {
    counts[label] = await db.collection(coll).countDocuments({ moduleId });
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const detail = Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return { total, detail };
};

const run = async () => {
  const confirm = process.argv.includes("--confirm");
  const uri = process.env.MONGO_URI || "mongodb://localhost:27017/stock_db";
  const act = (label) => console.info(`  ${confirm ? "" : "would "}${label}`);

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.info(`${confirm ? "APPLYING" : "DRY RUN"} on ${db.databaseName}\n`);

  const names = new Set((await db.listCollections().toArray()).map((c) => c.name));

  // ── 1. warehouses → branches ────────────────────────────────────────────
  // Mongoose may have already created an empty `branches` while building
  // indexes on boot; that placeholder has to go before the rename can land.
  if (names.has("warehouses")) {
    const docs = await db.collection("warehouses").countDocuments();
    if (names.has("branches")) {
      const placeholder = await db.collection("branches").countDocuments();
      if (placeholder > 0) {
        throw new Error(
          `Refusing to rename: "branches" already holds ${placeholder} document(s). ` +
            `Migration looks partly applied — inspect both collections by hand.`
        );
      }
      act(`drop empty placeholder collection "branches"`);
      if (confirm) await db.collection("branches").drop();
    }
    act(`rename collection "warehouses" → "branches" (${docs} docs kept)`);
    if (confirm) {
      await db.collection("warehouses").rename("branches");
      names.delete("warehouses");
    }
    names.add("branches");
  } else {
    console.info(`  skip   collection rename ("warehouses" not present)`);
  }

  // ── 2. Top-level field renames ──────────────────────────────────────────
  // On a dry run the rename above has not happened, so the branch documents
  // are still under "warehouses" — count them where they actually are, or
  // the run reports "already migrated" against the empty placeholder.
  const branchMasterColl = names.has("warehouses") ? "warehouses" : "branches";
  const fieldRenames = { ...FIELD_RENAMES, [branchMasterColl]: { locationRole: "branchRole" } };

  console.info("");
  for (const [coll, mapping] of Object.entries(fieldRenames)) {
    if (!names.has(coll)) {
      console.info(`  skip   ${coll} (does not exist)`);
      continue;
    }
    for (const [from, to] of Object.entries(mapping)) {
      // $rename refuses to overwrite, so only touch docs still on the old key.
      const n = await db.collection(coll).countDocuments({ [from]: { $exists: true } });
      if (n === 0) {
        console.info(`  skip   ${coll}.${from} (already migrated)`);
        continue;
      }
      act(`rename ${coll}.${from} → ${to} (${n} docs)`);
      if (confirm) {
        await db.collection(coll).updateMany({ [from]: { $exists: true } }, { $rename: { [from]: to } });
      }
    }
  }

  // ── 3. product_definitions.warehouseThresholds[] ────────────────────────
  // $rename cannot reach inside an array, so the sub-documents are rebuilt
  // with $map. The sub-schema is { branchId, threshold } with _id disabled.
  console.info("");
  if (names.has("product_definitions")) {
    const filter = { warehouseThresholds: { $exists: true } };
    const n = await db.collection("product_definitions").countDocuments(filter);
    if (n === 0) {
      console.info(`  skip   product_definitions.warehouseThresholds (already migrated)`);
    } else {
      act(`rebuild product_definitions.warehouseThresholds → branchThresholds (${n} docs, warehouseId → branchId inside each row)`);
      if (confirm) {
        await db.collection("product_definitions").updateMany(filter, [
          {
            $set: {
              branchThresholds: {
                $map: {
                  input: { $ifNull: ["$warehouseThresholds", []] },
                  as: "t",
                  in: { branchId: "$$t.warehouseId", threshold: "$$t.threshold" },
                },
              },
            },
          },
          { $unset: "warehouseThresholds" },
        ]);
      }
    }
  }

  // ── 4. audit_logs ───────────────────────────────────────────────────────
  // entityType is the module key; before/after are frozen entity snapshots
  // and changedFields is a list of field names — all three carry old names.
  console.info("");
  if (names.has("audit_logs")) {
    const n = await db.collection("audit_logs").countDocuments({ entityType: "warehouses" });
    if (n === 0) {
      console.info(`  skip   audit_logs.entityType (already migrated)`);
    } else {
      act(`set audit_logs.entityType "warehouses" → "branches" (${n} docs)`);
      if (confirm) {
        await db
          .collection("audit_logs")
          .updateMany({ entityType: "warehouses" }, { $set: { entityType: "branches" } });
      }
    }

    const snapshotFilter = {
      $or: [
        ...Object.keys(KEY_MAP).flatMap((k) => [{ [`before.${k}`]: { $exists: true } }, { [`after.${k}`]: { $exists: true } }]),
        { changedFields: { $in: Object.keys(KEY_MAP) } },
      ],
    };
    const snaps = await db.collection("audit_logs").countDocuments(snapshotFilter);
    if (snaps === 0) {
      console.info(`  skip   audit_logs before/after/changedFields (already migrated)`);
    } else {
      act(`rewrite audit_logs before/after top-level keys + changedFields (${snaps} docs)`);
      if (confirm) {
        await db.collection("audit_logs").updateMany(snapshotFilter, [
          {
            $set: {
              before: renameSnapshotKeys("$before"),
              after: renameSnapshotKeys("$after"),
              changedFields: {
                $map: {
                  input: { $ifNull: ["$changedFields", []] },
                  as: "f",
                  in: {
                    $switch: {
                      branches: Object.entries(KEY_MAP).map(([from, to]) => ({
                        case: { $eq: ["$$f", from] },
                        then: to,
                      })),
                      default: "$$f",
                    },
                  },
                },
              },
            },
          },
        ]);
      }
    }

    // The rows nested inside a snapshot's branchThresholds array are out of
    // reach of the top-level key rewrite above — they need their own pass.
    const rowFilter = {
      $or: [
        { "before.branchThresholds.warehouseId": { $exists: true } },
        { "after.branchThresholds.warehouseId": { $exists: true } },
      ],
    };
    const rows = await db.collection("audit_logs").countDocuments(rowFilter);
    if (rows === 0) {
      console.info(`  skip   audit_logs nested branchThresholds rows (already migrated)`);
    } else {
      act(`rewrite audit_logs nested branchThresholds[].warehouseId → branchId (${rows} docs)`);
      if (confirm) {
        await db.collection("audit_logs").updateMany(rowFilter, [
          { $set: { before: renameThresholdRows("$before"), after: renameThresholdRows("$after") } },
        ]);
      }
    }
  }

  // ── 5. modules ──────────────────────────────────────────────────────────
  // Permissions point at modules by ObjectId, so this doc must survive —
  // renaming its key in place keeps every existing grant intact.
  //
  // A server booted on the renamed code before this migration ran will have
  // seeded a *second*, grant-less "branches" module (the seeder only inserts
  // what is missing). That orphan has to go before the real doc can take the
  // key, otherwise the unique index on `key` rejects the update.
  console.info("");
  const mod = await db.collection("modules").findOne({ key: "warehouses" });
  if (!mod) {
    console.info(`  skip   modules (no "warehouses" doc — already renamed or not seeded)`);
  } else {
    const seeded = await db.collection("modules").findOne({ key: "branches" });
    if (seeded) {
      const grants = await countModuleGrants(db, seeded._id);
      if (grants.total > 0) {
        throw new Error(
          `Two module docs claim "branches": _id ${seeded._id} already carries ` +
            `${grants.total} grant(s) (${grants.detail}). Merge them by hand — ` +
            `refusing to guess which one permissions should follow.`
        );
      }
      act(`remove grant-less seeded module _id ${seeded._id} (superseded by the original)`);
      if (confirm) await db.collection("modules").deleteOne({ _id: seeded._id });
    }
    const grants = await countModuleGrants(db, mod._id);
    act(`update modules "warehouses" → "branches" (_id ${mod._id}, ${grants.total} grant(s) preserved: ${grants.detail})`);
    if (confirm) {
      await db.collection("modules").updateOne({ _id: mod._id }, { $set: { key: "branches", name: "Branches" } });
    }
  }


  // ── 6. Free-text content ────────────────────────────────────────────────
  // Field names are only half the rename — seeded copy and audit `reason`
  // strings still read "warehouse" to anyone using the app. Matched on the
  // exact current value so a re-run is a no-op and hand-edits are never
  // clobbered. Spelling inside the value is left exactly as-is.
  console.info("");
  const TEXT_FIXES = [
    ["branches", "name", "Main Warehouse Azapur", "Main Branch Azapur"],
    ["branches", "description", "Default warehouse — auto-seeded", "Default branch — auto-seeded"],
    ["audit_logs", "reason", "user=67fcaeefd7d3b3e80fa8d8ab module=warehouses", "user=67fcaeefd7d3b3e80fa8d8ab module=branches"],
  ];
  let textChanged = 0;
  for (const [coll, field, from, to] of TEXT_FIXES) {
    if (!names.has(coll)) continue;
    const n = await db.collection(coll).countDocuments({ [field]: from });
    if (n === 0) continue;
    act(`set ${coll}.${field} "${from}" → "${to}" (${n} doc${n > 1 ? "s" : ""})`);
    if (confirm) await db.collection(coll).updateMany({ [field]: from }, { $set: { [field]: to } });
    textChanged += n;
  }
  if (textChanged === 0) console.info(`  skip   no free-text "warehouse" left`);

  // ── 7. Stale indexes ────────────────────────────────────────────────────
  console.info("");
  let dropped = 0;
  for (const coll of names) {
    let indexes;
    try {
      indexes = await db.collection(coll).indexes();
    } catch {
      continue; // collection vanished mid-run
    }
    for (const idx of indexes) {
      if (idx.name === "_id_") continue;
      if (!Object.keys(idx.key).some((k) => DEAD_INDEX_FIELDS.includes(k))) continue;
      act(`drop stale index ${coll}.${idx.name} (${Object.keys(idx.key).join(", ")})`);
      if (confirm) await db.collection(coll).dropIndex(idx.name);
      dropped++;
    }
  }
  if (dropped === 0) console.info(`  skip   no stale indexes found`);

  await mongoose.disconnect();
  console.info(
    confirm
      ? "\nDone — no documents deleted. Restart the server so Mongoose rebuilds indexes."
      : "\nDry run only — re-run with --confirm to apply."
  );
};

run().catch((err) => {
  console.error(`\nMigration failed: ${err.message}`);
  process.exit(1);
});
