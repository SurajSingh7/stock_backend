import crypto from "crypto";
import StockModuleModel from "../models/stock.module.model.js";
import StockRoleModulePermissionModel from "../models/stock.role.module.permission.model.js";
import StockUserPermissionOverrideModel from "../models/stock.user.permission.override.model.js";
import StockUserDataScopeModel from "../models/stock.user.data.scope.model.js";
import StockAccessDelegationModel from "../models/stock.access.delegation.model.js";
import StockDepartmentModuleRestrictionModel from "../models/stock.department.module.restriction.model.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import { DATA_SCOPE, DATA_SCOPE_ARRAY, ENTITY_SCOPE, ENTITY_SCOPE_ARRAY } from "../constants/stock.enums.js";
import { resolveEffectiveActions, resolveDataAccess } from "../middlewares/stock.permission.middleware.js";
import { DATA_SCOPE_REGISTRY } from "../config/data.scope.registry.js";

const ENTITY_TYPE = "Permission";

const getModuleOrThrow = async (moduleId) => {
  const module = await StockModuleModel.findById(moduleId);
  if (!module) throw new Error("Module not found");
  return module;
};

export default class StockAccessControlService {
  // Each module carries its data-scope dimensions alongside its actions, so the
  // admin screens can show what is grantable AND what will be filtered without
  // anyone having to open config/data.scope.registry.js to find out.
  getAllModules = async () => {
    const modules = await StockModuleModel.find({ isActive: true }).sort({ name: 1 }).lean();
    return modules.map((m) => {
      const dims = DATA_SCOPE_REGISTRY[m.key];
      return {
        ...m,
        // undefined = not registered at all, which is a configuration bug the
        // UI should surface rather than quietly render as "unscoped".
        scopeDimensions: dims === undefined ? null : Object.keys(dims),
        scopeFields: dims ?? null,
      };
    });
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
  /* ── Data access — three dimensions, global + optional module override ──
   * One collection, one merge rule. A row with moduleId:null is the user's
   * global default; a row with a moduleId overrides only the dimensions it
   * explicitly configures. Each dimension carries `configured` so "override
   * says OWN" is distinguishable from "override says nothing" — OWN is also
   * the schema default, so the flag is the only way to tell them apart.
   */

  #validateDimensions = ({ branch, entity, recordOwnership }) => {
    if (branch?.configured) {
      if (!DATA_SCOPE_ARRAY.includes(branch.scope)) throw new Error("Invalid branch scope");
      if (branch.scope === DATA_SCOPE.SELECTED && !(branch.allowedBranchIds || []).length) {
        throw new Error("Pick at least one branch, or choose Own / All");
      }
    }
    if (entity?.configured) {
      if (!ENTITY_SCOPE_ARRAY.includes(entity.scope)) throw new Error("Invalid entity scope");
      if (entity.scope === ENTITY_SCOPE.SELECTED && !(entity.allowedEntityAliases || []).length) {
        throw new Error("Pick at least one entity, or choose All entities");
      }
    }
    if (recordOwnership?.configured) {
      if (!DATA_SCOPE_ARRAY.includes(recordOwnership.scope)) throw new Error("Invalid record ownership scope");
      if (recordOwnership.scope === DATA_SCOPE.SELECTED && !(recordOwnership.allowedUserIds || []).length) {
        throw new Error("Pick at least one user, or choose Own / All");
      }
    }
  };

  #normalise = (dims) => ({
    branch: {
      configured: !!dims.branch?.configured,
      scope: dims.branch?.scope ?? DATA_SCOPE.OWN,
      allowedBranchIds: dims.branch?.scope === DATA_SCOPE.SELECTED ? dims.branch.allowedBranchIds || [] : [],
    },
    entity: {
      configured: !!dims.entity?.configured,
      scope: dims.entity?.scope ?? ENTITY_SCOPE.SELECTED,
      allowedEntityAliases:
        dims.entity?.scope === ENTITY_SCOPE.SELECTED
          ? (dims.entity.allowedEntityAliases || []).map((a) => String(a).trim().toUpperCase()).filter(Boolean)
          : [],
    },
    recordOwnership: {
      configured: !!dims.recordOwnership?.configured,
      scope: dims.recordOwnership?.scope ?? DATA_SCOPE.OWN,
      allowedUserIds: dims.recordOwnership?.scope === DATA_SCOPE.SELECTED ? dims.recordOwnership.allowedUserIds || [] : [],
    },
  });

  // moduleId omitted/null → the user's global row.
  setDataScope = async ({ userId, moduleId = null, branch, entity, recordOwnership, actor }) => {
    if (!userId) throw new Error("userId is required");
    const module = moduleId ? await getModuleOrThrow(moduleId) : null;

    this.#validateDimensions({ branch, entity, recordOwnership });
    const dims = this.#normalise({ branch, entity, recordOwnership });

    const before = await StockUserDataScopeModel.findOne({ userId, moduleId }).lean();
    const after = await StockUserDataScopeModel.findOneAndUpdate(
      { userId, moduleId },
      { $set: { ...dims, updatedBy: actor?._id ?? null } },
      { new: true, upsert: true }
    );

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: after._id,
      action: moduleId ? "SET_MODULE_DATA_SCOPE" : "SET_GLOBAL_DATA_SCOPE",
      actor,
      before,
      after: after.toObject(),
      reason: `user=${userId}${module ? " module=" + module.key : " (global)"}`,
    });

    return after;
  };

  // Everything the Data Scope screen needs in one call: the global row plus
  // every module override, so the admin sees exactly what is configured
  // rather than having to guess which modules were customised.
  getDataScopes = async (userId) => {
    if (!userId) throw new Error("userId is required");
    const rows = await StockUserDataScopeModel.find({ userId }).populate("moduleId", "key name").lean();
    return {
      global: rows.find((r) => !r.moduleId) || null,
      moduleOverrides: rows.filter((r) => r.moduleId),
    };
  };

  clearModuleDataScope = async ({ userId, moduleId, actor }) => {
    if (!userId || !moduleId) throw new Error("userId and moduleId are required");
    const module = await getModuleOrThrow(moduleId);
    const removed = await StockUserDataScopeModel.findOneAndDelete({ userId, moduleId });
    if (!removed) throw new Error("Module override not found");

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: removed._id,
      action: "CLEAR_MODULE_DATA_SCOPE",
      actor,
      before: removed.toObject(),
      after: null,
      reason: `user=${userId} module=${module.key} — falls back to global`,
    });
    return removed;
  };

  /* ── Department restriction — a ceiling on the role, never a grant ────── */

  setDepartmentRestriction = async ({ departmentId, moduleId, allowedActions, actor }) => {
    if (!departmentId || !moduleId) throw new Error("departmentId and moduleId are required");
    const module = await getModuleOrThrow(moduleId);
    const invalid = (allowedActions || []).filter((a) => !module.actions.includes(a));
    if (invalid.length) throw new Error(`Invalid actions for this module: ${invalid.join(", ")}`);

    const before = await StockDepartmentModuleRestrictionModel.findOne({ departmentId, moduleId }).lean();
    const after = await StockDepartmentModuleRestrictionModel.findOneAndUpdate(
      { departmentId, moduleId },
      { $set: { allowedActions: allowedActions || [], updatedBy: actor?._id ?? null } },
      { new: true, upsert: true }
    );

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: after._id,
      action: "SET_DEPARTMENT_RESTRICTION",
      actor,
      before,
      after: after.toObject(),
      reason: `department=${departmentId} module=${module.key}`,
    });
    return after;
  };

  getDepartmentRestrictions = async (departmentId) => {
    if (!departmentId) throw new Error("departmentId is required");
    return StockDepartmentModuleRestrictionModel.find({ departmentId })
      .populate("moduleId", "key name actions")
      .lean();
  };

  clearDepartmentRestriction = async ({ departmentId, moduleId, actor }) => {
    if (!departmentId || !moduleId) throw new Error("departmentId and moduleId are required");
    const module = await getModuleOrThrow(moduleId);
    const removed = await StockDepartmentModuleRestrictionModel.findOneAndDelete({ departmentId, moduleId });
    if (!removed) throw new Error("Department restriction not found");

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: removed._id,
      action: "CLEAR_DEPARTMENT_RESTRICTION",
      actor,
      before: removed.toObject(),
      after: null,
      reason: `department=${departmentId} module=${module.key} — no restriction`,
    });
    return removed;
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
      StockUserDataScopeModel.find({ userId: fromUserId, moduleId: { $in: moduleIdList } }).lean(),
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

      // Only a module-level OVERRIDE is copied. B's global row is deliberately
      // left alone: delegation grants A's exceptions, not A's whole identity.
      const fromScope = scopeByModule.get(key);
      if (fromScope) {
        await StockUserDataScopeModel.findOneAndUpdate(
          { userId: toUserId, moduleId: module._id },
          {
            $set: {
              branch: fromScope.branch,
              entity: fromScope.entity,
              recordOwnership: fromScope.recordOwnership,
              updatedBy: actor?._id ?? null,
            },
          },
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
  /**
   * The admin-facing "what can this person actually do, and whose rows can
   * they touch" preview. Resolved through resolveEffectiveActions() and
   * resolveDataAccess() — the very functions requirePermission() runs — so a
   * change to the rules can never leave this screen showing something the API
   * would not actually allow.
   */
  getEffectivePermissions = async ({ userId, roleId, departmentId, branchId }) => {
    if (!userId || !roleId) throw new Error("userId and roleId are required");

    const modules = await StockModuleModel.find({ isActive: true }).sort({ name: 1 }).lean();
    const moduleIdList = modules.map((m) => m._id);

    const [roleDefaults, deptRestrictions, overrides, scopeRows] = await Promise.all([
      StockRoleModulePermissionModel.find({ roleId, moduleId: { $in: moduleIdList } }).lean(),
      departmentId
        ? StockDepartmentModuleRestrictionModel.find({ departmentId, moduleId: { $in: moduleIdList } }).lean()
        : [],
      StockUserPermissionOverrideModel.find({ userId, moduleId: { $in: moduleIdList } }).lean(),
      StockUserDataScopeModel.find({ userId }).lean(),
    ]);

    const byModule = (rows) => new Map(rows.map((r) => [String(r.moduleId), r]));
    const roleBy = byModule(roleDefaults);
    const deptBy = byModule(deptRestrictions);
    const overrideBy = byModule(overrides);
    const globalScope = scopeRows.find((r) => !r.moduleId) || null;
    const scopeBy = byModule(scopeRows.filter((r) => r.moduleId));

    const user = { _id: userId, branchId: branchId ?? null };

    return modules.map((module) => {
      const key = String(module._id);
      const actions = resolveEffectiveActions(roleBy.get(key), deptBy.get(key), overrideBy.get(key));
      const dataAccess = resolveDataAccess(globalScope, scopeBy.get(key), user);

      return {
        moduleId: module._id,
        moduleKey: module.key,
        moduleName: module.name,
        allowedActions: [...actions],
        dataAccess: {
          branch: dataAccess.branch,
          entity: dataAccess.entity,
          recordOwnership: dataAccess.recordOwnership,
        },
        // So the UI can show WHY a dimension reads the way it does.
        hasModuleOverride: scopeBy.has(key),
      };
    });
  };
}
