import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockAccessControlService from "../services/stock.access.control.service.js";

const log = getLogger(import.meta.url);
const service = new StockAccessControlService();

const actingUser = (req) => ({
  id: req.user?._id || req.userId || null,
  name: req.user?.name || req.user?.fullName || "",
});

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

  static async setScopePolicy(req, res) {
    try {
      const { userId, moduleId, scope, allowedBranchIds } = req.body;
      const data = await service.setScopePolicy({ userId, moduleId, scope, allowedBranchIds, actor: req.user });
      log.info(`Access scope set by ${actingUser(req).name || actingUser(req).id}`);
      successResponseHandler(res, data, "Access scope saved successfully");
    } catch (error) {
      log.error("Error setting access scope", error);
      errorResponseHandler(res, error);
    }
  }

  static async getScopePolicies(req, res) {
    try {
      const data = await service.getScopePolicies(req.query.userId);
      successResponseHandler(res, data, "Access scopes fetched successfully");
    } catch (error) {
      log.error("Error fetching access scopes", error);
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
      const { userId, roleId } = req.query;
      const data = await service.getEffectivePermissions({ userId, roleId });
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
      const modules = await service.getEffectivePermissions({ userId: req.user._id, roleId: req.user.roleId });
      const data = { isAdmin: req.user.isAdmin, branchId: req.user.branchId, modules };
      successResponseHandler(res, data, "Your permissions fetched successfully");
    } catch (error) {
      log.error("Error fetching own permissions", error);
      errorResponseHandler(res, error);
    }
  }
}
