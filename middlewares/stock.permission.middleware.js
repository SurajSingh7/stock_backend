import { ACCESS_SCOPE, ENTITY_SCOPE } from "../constants/stock.enums.js";
import StockModuleModel from "../models/stock.module.model.js";
import StockRoleModulePermissionModel from "../models/stock.role.module.permission.model.js";
import StockUserPermissionOverrideModel from "../models/stock.user.permission.override.model.js";
import StockAccessScopePolicyModel from "../models/stock.access.scope.policy.model.js";
import StockUserEntityAccessModel from "../models/stock.user.entity.access.model.js";

const UNRESTRICTED_ENTITIES = { scope: ENTITY_SCOPE.ALL_ENTITIES, allowedEntityAliases: [] };

// effective actions = role default ∪ addActions, minus removeActions.
// Action + scope are resolved together per request rather than cached —
// module/role/override lookups are all indexed single-doc reads, cheap
// enough to not need the same TTL cache as the HRMS identity call.
export function requirePermission(moduleKey, action) {
  // Named (not an arrow) so scripts/check-route-permissions.js can spot it
  // by fn.name in the router stack — that's the whole audit mechanism.
  return async function permissionCheck(req, res, next) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, message: "Unauthenticated user" });
      }

      // Admin bypass — one flag, derived once in authenticate(), never a
      // second verification path.
      if (req.user.isAdmin) {
        req.accessScope = { scope: ACCESS_SCOPE.ALL_BRANCHES, allowedBranchIds: [] };
        req.entityAccess = UNRESTRICTED_ENTITIES;
        return next();
      }

      const module = await StockModuleModel.findOne({ key: moduleKey, isActive: true }).lean();
      if (!module) {
        return res.status(403).json({ success: false, message: "This module is not configured" });
      }

      const [roleDefault, override, scopePolicy, entityAccess] = await Promise.all([
        StockRoleModulePermissionModel.findOne({ roleId: req.user.roleId, moduleId: module._id }).lean(),
        StockUserPermissionOverrideModel.findOne({ userId: req.user._id, moduleId: module._id }).lean(),
        StockAccessScopePolicyModel.findOne({ userId: req.user._id, moduleId: module._id }).lean(),
        // Per-user, so no moduleId in this one.
        StockUserEntityAccessModel.findOne({ userId: req.user._id }).lean(),
      ]);

      const effectiveActions = new Set(roleDefault?.allowedActions ?? []);
      for (const a of override?.addActions ?? []) effectiveActions.add(a);
      for (const a of override?.removeActions ?? []) effectiveActions.delete(a);

      if (!effectiveActions.has(action)) {
        return res.status(403).json({ success: false, message: "You do not have permission to perform this action" });
      }

      // No explicit scope policy = OWN_BRANCH, the safe default — a user
      // never sees other branches' data just because nobody configured a
      // policy for them yet.
      req.accessScope = scopePolicy
        ? { scope: scopePolicy.scope, allowedBranchIds: scopePolicy.allowedBranchIds ?? [] }
        : { scope: ACCESS_SCOPE.OWN_BRANCH, allowedBranchIds: [] };

      // Opposite default to branch, on purpose. A user has no entity of their
      // own, so "nobody configured this yet" cannot mean "restricted to their
      // own" — a restrictive default here would hide every Purchase Order and
      // Invoice from every existing user the moment this shipped.
      req.entityAccess = entityAccess
        ? { scope: entityAccess.scope, allowedEntityAliases: entityAccess.allowedEntityAliases ?? [] }
        : UNRESTRICTED_ENTITIES;

      req.module = module;
      next();
    } catch (err) {
      console.error("Permission middleware error:", err);
      return res.status(500).json({ success: false, message: "Permission check failed" });
    }
  };
}
