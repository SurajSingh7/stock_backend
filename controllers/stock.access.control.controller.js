import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockAccessControlService from "../services/stock.access.control.service.js";

const log = getLogger(import.meta.url);
const service = new StockAccessControlService();

// req.user already carries everything the audit trail wants — role, branch,
// IP, user agent. This used to return only { id, name }, which is why the
// purchase-order, quotation, invoice and transfer-request audit rows recorded
// an empty role and no IP. `id` is kept alongside `_id` so older call sites
// that read actor.id keep working.
const actingUser = (req) => (req.user ? { ...req.user, id: req.user._id } : null);

export default class StockAccessControlController {
  static async getAllModules(req, res) {
    try {
      const data = await service.getAllModules();
      successResponseHandler(res, data, "Modules fetched successfully");
    } catch (error) {
      log.error("Error fetching modules", error);
      errorResponseHandler(res, error);
    }
  }

  static async setRolePermission(req, res) {
    try {
      const { roleId, moduleId, allowedActions } = req.body;
      const data = await service.setRolePermission({ roleId, moduleId, allowedActions, actor: req.user });
      log.info(`Role permission set by ${actingUser(req).name || actingUser(req).id}`);
      successResponseHandler(res, data, "Role permission saved successfully");
    } catch (error) {
      log.error("Error setting role permission", error);
      errorResponseHandler(res, error);
    }
  }

  static async getRolePermissions(req, res) {
    try {
      const data = await service.getRolePermissions(req.query.roleId);
      successResponseHandler(res, data, "Role permissions fetched successfully");
    } catch (error) {
      log.error("Error fetching role permissions", error);
      errorResponseHandler(res, error);
    }
  }

  static async setUserOverride(req, res) {
    try {
      const { userId, moduleId, addActions, removeActions } = req.body;
      const data = await service.setUserOverride({ userId, moduleId, addActions, removeActions, actor: req.user });
      log.info(`User override set by ${actingUser(req).name || actingUser(req).id}`);
      successResponseHandler(res, data, "User override saved successfully");
    } catch (error) {
      log.error("Error setting user override", error);
      errorResponseHandler(res, error);
    }
  }

  static async getUserOverrides(req, res) {
    try {
      const data = await service.getUserOverrides(req.query.userId);
      successResponseHandler(res, data, "User overrides fetched successfully");
    } catch (error) {
      log.error("Error fetching user overrides", error);
      errorResponseHandler(res, error);
    }
  }

  /* ── Data access: one global row per user, optional per-module override ── */

  static async setDataScope(req, res) {
    try {
      const { userId, moduleId, branch, entity, recordOwnership } = req.body;
      const data = await service.setDataScope({
        userId,
        moduleId: moduleId || null, // omitted / null = the user's global row
        branch,
        entity,
        recordOwnership,
        actor: req.user,
      });
      log.info(`Data scope set by ${actingUser(req).name || actingUser(req).id}`);
      successResponseHandler(res, data, "Data scope saved successfully");
    } catch (error) {
      log.error("Error setting data scope", error);
      errorResponseHandler(res, error);
    }
  }

  static async getDataScopes(req, res) {
    try {
      const data = await service.getDataScopes(req.query.userId);
      successResponseHandler(res, data, "Data scopes fetched successfully");
    } catch (error) {
      log.error("Error fetching data scopes", error);
      errorResponseHandler(res, error);
    }
  }

  static async clearModuleDataScope(req, res) {
    try {
      const { userId, moduleId } = req.body;
      const data = await service.clearModuleDataScope({ userId, moduleId, actor: req.user });
      successResponseHandler(res, data, "Module override removed — this module now follows the global scope");
    } catch (error) {
      log.error("Error clearing module data scope", error);
      errorResponseHandler(res, error);
    }
  }

  /* ── Department restriction ─────────────────────────────────────────────── */

  static async setDepartmentRestriction(req, res) {
    try {
      const { departmentId, moduleId, allowedActions } = req.body;
      const data = await service.setDepartmentRestriction({ departmentId, moduleId, allowedActions, actor: req.user });
      log.info(`Department restriction set by ${actingUser(req).name || actingUser(req).id}`);
      successResponseHandler(res, data, "Department restriction saved successfully");
    } catch (error) {
      log.error("Error setting department restriction", error);
      errorResponseHandler(res, error);
    }
  }

  static async getDepartmentRestrictions(req, res) {
    try {
      const data = await service.getDepartmentRestrictions(req.query.departmentId);
      successResponseHandler(res, data, "Department restrictions fetched successfully");
    } catch (error) {
      log.error("Error fetching department restrictions", error);
      errorResponseHandler(res, error);
    }
  }

  static async clearDepartmentRestriction(req, res) {
    try {
      const { departmentId, moduleId } = req.body;
      const data = await service.clearDepartmentRestriction({ departmentId, moduleId, actor: req.user });
      successResponseHandler(res, data, "Department restriction removed — the role's actions apply unchanged");
    } catch (error) {
      log.error("Error clearing department restriction", error);
      errorResponseHandler(res, error);
    }
  }

  static async delegateAccess(req, res) {
    try {
      const { fromUserId, toUserId, fromRoleId, moduleIds } = req.body;
      const data = await service.delegateAccess({ fromUserId, toUserId, fromRoleId, moduleIds, actor: req.user });
      log.info(`Access delegated from ${fromUserId} to ${toUserId} by ${actingUser(req).id}`);
      successResponseHandler(res, data, "Access delegated successfully", 201);
    } catch (error) {
      log.error("Error delegating access", error);
      errorResponseHandler(res, error);
    }
  }

  static async getEffectivePermissions(req, res) {
    try {
      const { userId, roleId, departmentId, branchId } = req.query;
      const data = await service.getEffectivePermissions({ userId, roleId, departmentId, branchId });
      successResponseHandler(res, data, "Effective permissions fetched successfully");
    } catch (error) {
      log.error("Error fetching effective permissions", error);
      errorResponseHandler(res, error);
    }
  }

  // What the *caller's own* session can do — the frontend's single source
  // of truth for gating buttons/menus (see usePermissions() in the plan).
  static async getMyPermissions(req, res) {
    try {
      const modules = await service.getEffectivePermissions({
        userId: req.user._id,
        roleId: req.user.roleId,
        departmentId: req.user.departmentId,
        branchId: req.user.branchId,
      });
      const data = { isAdmin: req.user.isAdmin, branchId: req.user.branchId, modules };
      successResponseHandler(res, data, "Your permissions fetched successfully");
    } catch (error) {
      log.error("Error fetching own permissions", error);
      errorResponseHandler(res, error);
    }
  }
}
