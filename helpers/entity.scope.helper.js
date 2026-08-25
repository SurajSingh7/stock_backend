import { ENTITY_SCOPE } from "../constants/stock.enums.js";

// Mirrors branch.scope.helper.js, with two deliberate differences:
//   1. it matches on an alias string ("GTEL"), not an ObjectId
//   2. it treats "not yet assigned" as visible to everyone (see below)

// One-liner for controllers. `req.entityAccess` is attached by requirePermission.
export const entityCtxFromReq = (req) => req.entityAccess;

// null means unrestricted (ALL_ENTITIES / admin) — always check for that
// explicitly. An empty array is NOT the same thing: it means "restricted to
// nothing", which correctly yields zero rows.
export const resolveEntityAliases = (entityAccess) => {
  if (entityAccess?.scope !== ENTITY_SCOPE.SPECIFIC_ENTITIES) return null;
  return (entityAccess.allowedEntityAliases || []).map((a) => String(a).toUpperCase());
};

// A tracking order is created before anyone picks an entity — it sits at
// ENTITY_PENDING with buyerEntity.alias === "". Those rows must stay visible
// to everyone, otherwise the person meant to assign the entity cannot see the
// very rows that need assigning, and the workflow deadlocks.
const UNASSIGNED = [null, ""];

/**
 * List queries. Intersects with any alias the caller already filtered on,
 * rather than overwriting it — asking for an out-of-scope entity yields zero
 * rows instead of silently returning your own.
 */
export function applyEntityScopeToFilter(filter, entityAccess, field, { includeUnassigned = true } = {}) {
  const aliases = resolveEntityAliases(entityAccess);
  if (aliases === null) return filter;

  const existing = filter[field];
  let allowed = aliases;
  if (existing !== undefined) {
    const existingList = existing && typeof existing === "object" && existing.$in
      ? existing.$in.map((a) => String(a).toUpperCase())
      : [String(existing).toUpperCase()];
    allowed = existingList.filter((a) => aliases.includes(a));
    delete filter[field];
  }

  const clause = includeUnassigned
    ? { $or: [{ [field]: { $in: allowed } }, { [field]: { $in: UNASSIGNED } }, { [field]: { $exists: false } }] }
    : { [field]: { $in: allowed } };

  // $and, not a bare merge: the branch helper may already own filter.$or, and
  // two $or keys on one object would silently overwrite each other.
  filter.$and = [...(filter.$and || []), clause];
  return filter;
}

/** Single already-fetched record — used for by-id reads AND before any write. */
export function isWithinEntityScope(record, entityAccess, field, { allowUnassigned = true } = {}) {
  const aliases = resolveEntityAliases(entityAccess);
  if (aliases === null) return true;
  if (!record) return false;

  // Supports a dotted path ("buyerEntity.alias") as well as a flat field.
  const value = field.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), record);
  if (value === undefined || value === null || value === "") return allowUnassigned;

  return aliases.includes(String(value).toUpperCase());
}
