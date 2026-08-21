import { ACCESS_SCOPE } from "../constants/stock.enums.js";

// One-liner for controllers: `scopeCtxFromReq(req)` → what the helpers above expect.
export const scopeCtxFromReq = (req) => ({ accessScope: req.accessScope, branchId: req.user?.branchId });

// scopeCtx = { accessScope: req.accessScope, branchId: req.user.branchId }
// (services stay decoupled from Express — controllers build this from req).
// Exported for the rare case a plain filter object won't do (e.g. an
// aggregation $expr) and the caller needs the raw branch id list itself.
// null means unrestricted (ALL_BRANCHES / admin) — always check for that.
export const resolveBranchIds = ({ accessScope, branchId } = {}) => {
  const scope = accessScope?.scope;
  if (scope === ACCESS_SCOPE.OWN_BRANCH) {
    // Guard the id itself, not the stringified result: String(null) is the
    // truthy string "null", which .filter(Boolean) happily keeps and Mongo
    // then rejects with a CastError. Branchless users are a normal case
    // (sales/HR staff), so this has to resolve to "nothing", not crash.
    return branchId ? [String(branchId)] : [];
  }
  if (scope === ACCESS_SCOPE.SPECIFIC_BRANCHES) return (accessScope?.allowedBranchIds || []).map(String);
  return null; // ALL_BRANCHES, admin, or no scope at all — unrestricted
};

// For list queries — adds an $in (single field) or $or (multiple fields,
// e.g. transfer-requests' two locations) condition. If the caller already
// set one of `fields` (e.g. a `?warehouseId=` query filter), intersects
// with the branch scope instead of overwriting it — a filter for a
// warehouse outside scope correctly yields zero rows rather than leaking
// out-of-scope data or silently ignoring the caller's own filter. Not for
// by-id lookups (a single _id can't be intersected this way) — use
// isWithinBranchScope for those.
export function applyBranchScopeToFilter(filter, scopeCtx, fields) {
  const branchIds = resolveBranchIds(scopeCtx);
  if (branchIds === null) return filter;

  const fieldList = Array.isArray(fields) ? fields : [fields];
  if (fieldList.length === 1) {
    const field = fieldList[0];
    const existing = filter[field];
    if (existing === undefined) {
      filter[field] = { $in: branchIds };
    } else {
      const existingIds = existing && typeof existing === "object" && existing.$in
        ? existing.$in.map(String)
        : [String(existing)];
      filter[field] = { $in: existingIds.filter((id) => branchIds.includes(id)) };
    }
  } else {
    filter.$or = fieldList.map((f) => ({ [f]: { $in: branchIds } }));
  }
  return filter;
}

// For a single already-fetched record/doc — true if it's within scope.
// Use this for getById-style lookups instead of the filter helper, since
// the query already pins _id (or another field) and can't take a second
// conflicting condition on the same key.
export function isWithinBranchScope(record, scopeCtx, fields) {
  const branchIds = resolveBranchIds(scopeCtx);
  if (branchIds === null) return true;
  if (!record) return false;

  const fieldList = Array.isArray(fields) ? fields : [fields];
  return fieldList.some((f) => {
    const value = record[f];
    // Handles both a plain ObjectId/string and a populated sub-document.
    const id = value && typeof value === "object" ? value._id : value;
    return id && branchIds.includes(String(id));
  });
}
