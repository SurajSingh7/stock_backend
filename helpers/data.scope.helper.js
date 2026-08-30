import mongoose from "mongoose";
import { DATA_SCOPE, ENTITY_SCOPE } from "../constants/stock.enums.js";
import { resolveModuleScopeFields } from "../config/data.scope.registry.js";

/**
 * Turns a resolved data-access context into query filters and row predicates.
 *
 * Nothing in here decides WHICH dimensions apply — that comes from the
 * registry, keyed by module. Services therefore cannot forget a dimension:
 * they hand over req.dataAccess and the module key, and every applicable
 * filter is applied for them.
 */

class DataScopeError extends Error {}

/** Thrown when a protected query runs without a resolved context. Fail closed. */
const assertContext = (dataAccess, moduleKey) => {
  if (!dataAccess) {
    throw new DataScopeError(
      `Data scope missing for module "${moduleKey}" — the route is not going ` +
        `through requirePermission(), or the service was called without req.dataAccess.`
    );
  }
};

const toObjectIds = (ids) =>
  ids.filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));

/* ── Per-dimension allow-lists ────────────────────────────────────────────── */
/* Each returns null for "unrestricted", or an array (possibly empty, which    */
/* legitimately means "nothing"). Callers must test `=== null`, never          */
/* truthiness — an empty array is a real restriction, not an absent one.       */

const branchAllowList = ({ branch, userBranchId }) => {
  if (branch.scope === DATA_SCOPE.ALL) return null;
  if (branch.scope === DATA_SCOPE.SELECTED) return (branch.allowedBranchIds || []).map(String);
  // OWN — and the attribute it depends on must exist. Per the spec: a missing
  // attribute denies, it never silently widens to everything.
  if (!userBranchId) {
    throw new DataScopeError("No branch is assigned to your account — ask an administrator to set one.");
  }
  return [String(userBranchId)];
};

const entityAllowList = ({ entity }) => {
  if (entity.scope === ENTITY_SCOPE.ALL) return null;
  // SELECTED, including the unconfigured default — an empty list means the
  // user has not been granted any entity yet and sees none.
  return (entity.allowedEntityAliases || []).map((a) => String(a).toUpperCase());
};

const ownershipAllowList = ({ recordOwnership, userId }) => {
  if (recordOwnership.scope === DATA_SCOPE.ALL) return null;
  if (recordOwnership.scope === DATA_SCOPE.SELECTED) return (recordOwnership.allowedUserIds || []).map(String);
  if (!userId) throw new DataScopeError("Cannot resolve record ownership without an authenticated user.");
  return [String(userId)];
};

/**
 * Builds the AND-ed clauses for whichever dimensions apply to this module.
 * Returns [] when the module is registered as unscoped.
 */
export function buildScopeClauses(dataAccess, moduleKey) {
  assertContext(dataAccess, moduleKey);
  if (dataAccess.bypass) return []; // admin

  const fields = resolveModuleScopeFields(moduleKey); // throws if unregistered
  const clauses = [];

  const add = (fieldSpec, allowed, cast) => {
    if (allowed === null) return; // unrestricted on this dimension
    const values = cast ? cast(allowed) : allowed;
    const paths = Array.isArray(fieldSpec) ? fieldSpec : [fieldSpec];
    // Multiple paths = the record qualifies if ANY of them matches, e.g. a
    // transfer request belongs to both its requesting and source branch.
    clauses.push(
      paths.length === 1
        ? { [paths[0]]: { $in: values } }
        : { $or: paths.map((p) => ({ [p]: { $in: values } })) }
    );
  };

  if (fields.branch) add(fields.branch, branchAllowList(dataAccess), toObjectIds);
  if (fields.entity) add(fields.entity, entityAllowList(dataAccess));
  if (fields.ownership) add(fields.ownership, ownershipAllowList(dataAccess), toObjectIds);

  return clauses;
}

/**
 * Raw allow-list for one dimension — for the few places a plain filter object
 * will not do: an aggregation `$expr`, or a `$match` that must be pre-cast to
 * ObjectIds because .aggregate() (unlike .find()) never auto-casts.
 *
 * Returns null for unrestricted. Callers MUST test `=== null`; an empty array
 * is a real "allowed nothing", and treating it as falsy would invert the rule.
 */
export function resolveDimensionAllowList(dataAccess, dimension) {
  if (!dataAccess) throw new DataScopeError(`Data scope missing while resolving "${dimension}".`);
  if (dataAccess.bypass) return null;
  if (dimension === "branch") return branchAllowList(dataAccess);
  if (dimension === "entity") return entityAllowList(dataAccess);
  if (dimension === "ownership") return ownershipAllowList(dataAccess);
  throw new DataScopeError(`Unknown data-scope dimension "${dimension}".`);
}

/**
 * Mutates `filter` in place with every applicable scope clause, AND-ed.
 * Uses $and so it can never collide with an $or the caller already set.
 */
export function applyDataScope(filter, dataAccess, moduleKey) {
  const clauses = buildScopeClauses(dataAccess, moduleKey);
  if (clauses.length) filter.$and = [...(filter.$and || []), ...clauses];
  return filter;
}

/** Same rules, for a single already-fetched record: by-id reads and writes. */
export function isWithinDataScope(record, dataAccess, moduleKey) {
  assertContext(dataAccess, moduleKey);
  if (dataAccess.bypass) return true;
  if (!record) return false;

  const fields = resolveModuleScopeFields(moduleKey);

  const readPath = (path) => path.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), record);
  const idOf = (v) => (v && typeof v === "object" && v._id ? v._id : v); // populated or raw

  const passes = (fieldSpec, allowed, normalise = (v) => String(v)) => {
    if (allowed === null) return true;
    const paths = Array.isArray(fieldSpec) ? fieldSpec : [fieldSpec];
    return paths.some((p) => {
      const raw = idOf(readPath(p));
      if (raw === undefined || raw === null || raw === "") return false;
      return allowed.includes(normalise(raw));
    });
  };

  if (fields.branch && !passes(fields.branch, branchAllowList(dataAccess))) return false;
  if (fields.entity && !passes(fields.entity, entityAllowList(dataAccess), (v) => String(v).toUpperCase())) return false;
  if (fields.ownership && !passes(fields.ownership, ownershipAllowList(dataAccess))) return false;

  return true;
}

/**
 * Explicit escape hatch for internal system calculations that must see every
 * row regardless of who is asking — e.g. summing already-received quantities
 * across ALL invoices of a tracking order to enforce the over-receipt cap.
 * Scoping those would silently corrupt the arithmetic.
 *
 * Named so it is greppable: scripts/check-data-scope.js treats any other raw
 * query on a scoped model inside a service as a finding.
 */
export function unscopedInternalQuery(reason) {
  if (!reason) throw new Error("unscopedInternalQuery() requires a reason, for the audit trail.");
  return { __unscopedReason: reason };
}

export { DataScopeError };
