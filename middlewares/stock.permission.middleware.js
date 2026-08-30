import { DATA_SCOPE, ENTITY_SCOPE } from "../constants/stock.enums.js";
import StockModuleModel from "../models/stock.module.model.js";
import StockRoleModulePermissionModel from "../models/stock.role.module.permission.model.js";
import StockDepartmentModuleRestrictionModel from "../models/stock.department.module.restriction.model.js";
import StockUserPermissionOverrideModel from "../models/stock.user.permission.override.model.js";
import StockUserDataScopeModel from "../models/stock.user.data.scope.model.js";

/* ── Layer 1: what may they DO ─────────────────────────────────────────────
 *   role actions ∩ department actions  →  base
 *   base + addActions − removeActions  →  effective
 * A missing role grant denies. A missing department restriction does NOT —
 * departments only ever narrow what a role already gave.
 */
const resolveEffectiveActions = (roleDefault, departmentRestriction, override) => {
  const roleActions = roleDefault?.allowedActions ?? [];

  const base = departmentRestriction
    ? roleActions.filter((a) => (departmentRestriction.allowedActions ?? []).includes(a))
    : roleActions;

  const effective = new Set(base);
  // Applied after the intersection, so an override can deliberately restore
  // something the department removed — that is its stated purpose.
  for (const a of override?.addActions ?? []) effective.add(a);
  for (const a of override?.removeActions ?? []) effective.delete(a);
  return effective;
};

/* ── Layer 2: WHOSE ROWS may they touch ────────────────────────────────────
 * Global row is the user's default; a module row overrides only the
 * dimensions it explicitly configured. Merging per dimension (not per
 * document) is why each one carries a `configured` flag.
 */
const UNCONFIGURED = {
  branch: { scope: DATA_SCOPE.OWN, allowedBranchIds: [] },
  // No OWN for entity, and never an implicit ALL: an unconfigured user has
  // been granted no entity and therefore sees none.
  entity: { scope: ENTITY_SCOPE.SELECTED, allowedEntityAliases: [] },
  recordOwnership: { scope: DATA_SCOPE.OWN, allowedUserIds: [] },
};

const pickDimension = (dimension, globalRow, moduleRow) => {
  const fromModule = moduleRow?.[dimension];
  if (fromModule?.configured) return fromModule;
  const fromGlobal = globalRow?.[dimension];
  if (fromGlobal?.configured) return fromGlobal;
  return UNCONFIGURED[dimension];
};

const resolveDataAccess = (globalRow, moduleRow, user) => ({
  branch: pickDimension("branch", globalRow, moduleRow),
  entity: pickDimension("entity", globalRow, moduleRow),
  recordOwnership: pickDimension("recordOwnership", globalRow, moduleRow),
  userBranchId: user.branchId ?? null,
  userId: user._id,
  bypass: false,
});

export function requirePermission(moduleKey, action) {
  // Named (not an arrow) so scripts/check-route-permissions.js can spot it
  // by fn.name in the router stack — that's the whole audit mechanism.
  return async function permissionCheck(req, res, next) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, message: "Unauthenticated user" });
      }

      // Admin bypasses both layers — actions and data scope. Without this the
      // first admin could never configure anyone's access, including their own.
      if (req.user.isAdmin) {
        req.dataAccess = { ...UNCONFIGURED, bypass: true, userId: req.user._id, userBranchId: req.user.branchId ?? null };
        return next();
      }

      const module = await StockModuleModel.findOne({ key: moduleKey, isActive: true }).lean();
      if (!module) {
        return res.status(403).json({ success: false, message: "This module is not configured" });
      }

      const [roleDefault, departmentRestriction, override, globalScope, moduleScope] = await Promise.all([
        StockRoleModulePermissionModel.findOne({ roleId: req.user.roleId, moduleId: module._id }).lean(),
        req.user.departmentId
          ? StockDepartmentModuleRestrictionModel.findOne({ departmentId: req.user.departmentId, moduleId: module._id }).lean()
          : null,
        StockUserPermissionOverrideModel.findOne({ userId: req.user._id, moduleId: module._id }).lean(),
        StockUserDataScopeModel.findOne({ userId: req.user._id, moduleId: null }).lean(),
        StockUserDataScopeModel.findOne({ userId: req.user._id, moduleId: module._id }).lean(),
      ]);

      const effectiveActions = resolveEffectiveActions(roleDefault, departmentRestriction, override);
      if (!effectiveActions.has(action)) {
        return res.status(403).json({ success: false, message: "You do not have permission to perform this action" });
      }

      req.dataAccess = resolveDataAccess(globalScope, moduleScope, req.user);
      req.module = module;
      next();
    } catch (err) {
      console.error("Permission middleware error:", err);
      return res.status(500).json({ success: false, message: "Permission check failed" });
    }
  };
}

// Exported so the admin "what can this user actually see/do" preview resolves
// through exactly the same code the request path uses — the two can't drift.
export { resolveEffectiveActions, resolveDataAccess, UNCONFIGURED };
