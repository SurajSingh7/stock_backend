import crypto from "crypto";
import StockModuleModel from "../models/stock.module.model.js";
import StockRoleModulePermissionModel from "../models/stock.role.module.permission.model.js";
import StockUserPermissionOverrideModel from "../models/stock.user.permission.override.model.js";
import StockAccessScopePolicyModel from "../models/stock.access.scope.policy.model.js";
import StockAccessDelegationModel from "../models/stock.access.delegation.model.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import { ACCESS_SCOPE } from "../constants/stock.enums.js";

const ENTITY_TYPE = "Permission";

const getModuleOrThrow = async (moduleId) => {
  const module = await StockModuleModel.findById(moduleId);
  if (!module) throw new Error("Module not found");
  return module;
};

export default class StockAccessControlService {
  getAllModules = async () => {
    return StockModuleModel.find({ isActive: true }).sort({ name: 1 }).lean();
  };

  // Layer 1 — role default for a module. Upsert: call again to change it.
  setRolePermission = async ({ roleId, moduleId, allowedActions, actor }) => {
    if (!roleId || !moduleId) throw new Error("roleId and moduleId are required");
    const module = await getModuleOrThrow(moduleId);
    const invalid = (allowedActions || []).filter((a) => !module.actions.includes(a));
    if (invalid.length) throw new Error(`Invalid actions for this module: ${invalid.join(", ")}`);

    const before = await StockRoleModulePermissionModel.findOne({ roleId, moduleId }).lean();
    const after = await StockRoleModulePermissionModel.findOneAndUpdate(
      { roleId, moduleId },
      { $set: { allowedActions: allowedActions || [] } },
      { new: true, upsert: true }
    );

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: after._id,
      action: "SET_ROLE_PERMISSION",
      actor,
      before,
      after: after.toObject(),
      reason: `role=${roleId} module=${module.key}`,
    });

    return after;
  };

  getRolePermissions = async (roleId) => {
    if (!roleId) throw new Error("roleId is required");
    return StockRoleModulePermissionModel.find({ roleId }).populate("moduleId", "key name actions").lean();
  };

  // Layer 2 — the "same role, this one person gets more/less" case.
  setUserOverride = async ({ userId, moduleId, addActions, removeActions, actor }) => {
    if (!userId || !moduleId) throw new Error("userId and moduleId are required");
    const module = await getModuleOrThrow(moduleId);
    const invalid = [...(addActions || []), ...(removeActions || [])].filter((a) => !module.actions.includes(a));
    if (invalid.length) throw new Error(`Invalid actions for this module: ${invalid.join(", ")}`);

    const before = await StockUserPermissionOverrideModel.findOne({ userId, moduleId }).lean();
    const after = await StockUserPermissionOverrideModel.findOneAndUpdate(
      { userId, moduleId },
      { $set: { addActions: addActions || [], removeActions: removeActions || [] } },
      { new: true, upsert: true }
    );

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: after._id,
      action: "SET_USER_OVERRIDE",
      actor,
      before,
      after: after.toObject(),
      reason: `user=${userId} module=${module.key}`,
    });

    return after;
  };

  getUserOverrides = async (userId) => {
    if (!userId) throw new Error("userId is required");
    return StockUserPermissionOverrideModel.find({ userId }).populate("moduleId", "key name actions").lean();
  };

  // Layer 3 — which branches' data this user can see/act on for a module.
  setScopePolicy = async ({ userId, moduleId, scope, allowedBranchIds, actor }) => {
    if (!userId || !moduleId || !scope) throw new Error("userId, moduleId and scope are required");
    const module = await getModuleOrThrow(moduleId);
    if (scope === ACCESS_SCOPE.SPECIFIC_BRANCHES && !(allowedBranchIds || []).length) {
      throw new Error("allowedBranchIds is required when scope is SPECIFIC_BRANCHES");
    }

    const before = await StockAccessScopePolicyModel.findOne({ userId, moduleId }).lean();
    const after = await StockAccessScopePolicyModel.findOneAndUpdate(
      { userId, moduleId },
      { $set: { scope, allowedBranchIds: scope === ACCESS_SCOPE.SPECIFIC_BRANCHES ? allowedBranchIds : [] } },
      { new: true, upsert: true }
    );

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: after._id,
      action: "SET_ACCESS_SCOPE",
      actor,
      before,
      after: after.toObject(),
      reason: `user=${userId} module=${module.key}`,
    });

    return after;
  };

  getScopePolicies = async (userId) => {
    if (!userId) throw new Error("userId is required");
    return StockAccessScopePolicyModel.find({ userId }).populate("moduleId", "key name").lean();
  };

  // Snapshot copy (see stock.access.delegation.model.js) — grants User B
  // everything User A can currently do, additively on top of B's own role
  // default. Not a live link: editing A afterward never touches B. B keeps
  // their own role-derived baseline; this only ever adds, never removes.
  delegateAccess = async ({ fromUserId, toUserId, fromRoleId, moduleIds, actor }) => {
    if (!fromUserId || !toUserId || !fromRoleId) {
      throw new Error("fromUserId, toUserId and fromRoleId are required");
    }
    if (fromUserId.toString() === toUserId.toString()) {
      throw new Error("Cannot delegate a user's access to themselves");
    }

    const moduleFilter = moduleIds?.length ? { _id: { $in: moduleIds } } : {};
    const modules = await StockModuleModel.find({ ...moduleFilter, isActive: true }).lean();
    if (!modules.length) throw new Error("No matching modules to copy");

    const moduleIdList = modules.map((m) => m._id);
    const [roleDefaults, fromOverrides, fromScopes] = await Promise.all([
      StockRoleModulePermissionModel.find({ roleId: fromRoleId, moduleId: { $in: moduleIdList } }).lean(),
      StockUserPermissionOverrideModel.find({ userId: fromUserId, moduleId: { $in: moduleIdList } }).lean(),
      StockAccessScopePolicyModel.find({ userId: fromUserId, moduleId: { $in: moduleIdList } }).lean(),
    ]);

    const roleDefaultByModule = new Map(roleDefaults.map((r) => [r.moduleId.toString(), r]));
    const overrideByModule = new Map(fromOverrides.map((o) => [o.moduleId.toString(), o]));
    const scopeByModule = new Map(fromScopes.map((s) => [s.moduleId.toString(), s]));

    const batchId = crypto.randomUUID();
    const copied = [];

    for (const module of modules) {
      const key = module._id.toString();
      const roleDefault = roleDefaultByModule.get(key);
      const fromOverride = overrideByModule.get(key);

      // A's effective actions right now: role default ∪ their own adds, minus their own removes.
      const effective = new Set(roleDefault?.allowedActions ?? []);
      for (const a of fromOverride?.addActions ?? []) effective.add(a);
      for (const a of fromOverride?.removeActions ?? []) effective.delete(a);

      await StockUserPermissionOverrideModel.findOneAndUpdate(
        { userId: toUserId, moduleId: module._id },
        {
          $set: {
            addActions: [...effective],
            removeActions: [],
            delegatedFrom: fromUserId,
            delegationBatchId: batchId,
          },
        },
        { upsert: true }
      );

      const fromScope = scopeByModule.get(key);
      if (fromScope) {
        await StockAccessScopePolicyModel.findOneAndUpdate(
          { userId: toUserId, moduleId: module._id },
          { $set: { scope: fromScope.scope, allowedBranchIds: fromScope.allowedBranchIds } },
          { upsert: true }
        );
      }

      copied.push({ moduleId: module._id, moduleKey: module.key, actions: [...effective] });
    }

    const delegation = await StockAccessDelegationModel.create({
      fromUserId,
      toUserId,
      batchId,
      moduleIds: moduleIdList,
      performedBy: actor?._id ?? null,
    });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: delegation._id,
      action: "DELEGATE_ACCESS",
      actor,
      before: null,
      after: { fromUserId, toUserId, batchId, copied },
      reason: `from=${fromUserId} to=${toUserId}`,
    });

    return { delegation, copied };
  };

  // What requirePermission() would resolve to for this user, module by
  // module — the admin-facing "what can they actually do" preview.
  getEffectivePermissions = async ({ userId, roleId }) => {
    if (!userId || !roleId) throw new Error("userId and roleId are required");

    const modules = await StockModuleModel.find({ isActive: true }).sort({ name: 1 }).lean();
    const moduleIdList = modules.map((m) => m._id);
    const [roleDefaults, overrides, scopePolicies] = await Promise.all([
      StockRoleModulePermissionModel.find({ roleId, moduleId: { $in: moduleIdList } }).lean(),
      StockUserPermissionOverrideModel.find({ userId, moduleId: { $in: moduleIdList } }).lean(),
      StockAccessScopePolicyModel.find({ userId, moduleId: { $in: moduleIdList } }).lean(),
    ]);
    const roleDefaultByModule = new Map(roleDefaults.map((r) => [r.moduleId.toString(), r]));
    const overrideByModule = new Map(overrides.map((o) => [o.moduleId.toString(), o]));
    const scopeByModule = new Map(scopePolicies.map((s) => [s.moduleId.toString(), s]));

    return modules.map((module) => {
      const key = module._id.toString();
      const roleDefault = roleDefaultByModule.get(key);
      const override = overrideByModule.get(key);
      const effective = new Set(roleDefault?.allowedActions ?? []);
      for (const a of override?.addActions ?? []) effective.add(a);
      for (const a of override?.removeActions ?? []) effective.delete(a);

      const scope = scopeByModule.get(key);
      return {
        moduleId: module._id,
        moduleKey: module.key,
        moduleName: module.name,
        allowedActions: [...effective],
        scope: scope?.scope ?? ACCESS_SCOPE.OWN_BRANCH,
        allowedBranchIds: scope?.allowedBranchIds ?? [],
      };
    });
  };
}
