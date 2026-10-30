import StockAlertContactModel from "../models/stock.alert.contact.model.js";
import StockModuleModel from "../models/stock.module.model.js";
import StockRoleModulePermissionModel from "../models/stock.role.module.permission.model.js";
import StockDepartmentModuleRestrictionModel from "../models/stock.department.module.restriction.model.js";
import StockUserPermissionOverrideModel from "../models/stock.user.permission.override.model.js";
import StockUserDataScopeModel from "../models/stock.user.data.scope.model.js";
import { resolveEffectiveActions, resolveDataAccess } from "../middlewares/stock.permission.middleware.js";
import { resolveDimensionAllowList } from "../helpers/data.scope.helper.js";
import { createHttpClient } from "../helpers/http.helper.js";
import { hrmsApiUrl, hrmsSvcApiKey, adminRoleId } from "../config/env.config.js";
import { getLogger } from "../helpers/logger.helper.js";

/*
  "Everyone with access to this branch" — the BRANCH_USERS alert recipient.

  Users live in HRMS, not here, so the only people this can reach are alert
  contacts linked to a login (contact.userId). For each, HRMS's user-context
  gives the role, department and branch; the person qualifies when, on the
  event's module:

    • they hold READ — role ∩ department, ± their own override, and
    • their branch scope covers the branch — ALL, SELECTED incl. it, or OWN
      with it as their branch.

  Both resolved through resolveEffectiveActions / resolveDataAccess — the very
  functions requirePermission runs — so an alert never reaches someone the
  screens would not show the same branch to.

  Admins are left out on purpose: they bypass every scope, so including them
  would send them every branch's alerts. Add an admin to a rule by name to
  have them hear about it.

  HRMS is asked through its own short cache, separate from authenticate's —
  this runs in the background and must never change how logins behave.
*/
const log = getLogger(import.meta.url);

const hrmsApi = createHttpClient({
  baseURL: hrmsApiUrl,
  headers: { "x-api-key": hrmsSvcApiKey },
  timeout: 5000,
});

const CONTEXT_TTL_MS = 5 * 60 * 1000;
const contextCache = new Map(); // userId -> { user, expiresAt }

const hrmsUserOf = async (userId) => {
  const key = String(userId);
  const hit = contextCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.user;
  const res = await hrmsApi.get(`/internal/user-context/${encodeURIComponent(key)}`);
  const user = res?.data?.user || null;
  contextCache.set(key, { user, expiresAt: Date.now() + CONTEXT_TTL_MS });
  return user;
};

export default class StockAlertBranchAccessService {
  /**
   * @returns {{ contacts: object[], skipped: { name, reason }[] }}
   */
  static async contactsFor(branchId, moduleKey) {
    const skipped = [];
    const module = await StockModuleModel.findOne({ key: moduleKey, isActive: true }).lean();
    if (!module) return { contacts: [], skipped: [{ name: "People with branch access", reason: `module ${moduleKey} is not configured` }] };

    const linked = await StockAlertContactModel.find({ isActive: true, userId: { $ne: null } }).lean();
    if (!linked.length) return { contacts: [], skipped };

    // HRMS first: one failed lookup skips that person, not everyone.
    const people = [];
    for (const contact of linked) {
      try {
        const user = await hrmsUserOf(contact.userId);
        if (!user) skipped.push({ name: contact.name, reason: "login not found in HRMS" });
        else people.push({ contact, user });
      } catch (err) {
        log.warn(`HRMS user-context for ${contact.userId} failed: ${err.message}`);
        skipped.push({ name: contact.name, reason: "could not reach HRMS" });
      }
    }

    const nonAdmins = people.filter(({ user }) => String(user.role?._id || "") !== String(adminRoleId || ""));
    if (!nonAdmins.length) return { contacts: [], skipped };

    const roleIds = [...new Set(nonAdmins.map(({ user }) => String(user.role?._id || "")).filter(Boolean))];
    const deptIds = [...new Set(nonAdmins.map(({ user }) => String(user.department?._id || "")).filter(Boolean))];
    const userIds = nonAdmins.map(({ contact }) => contact.userId);

    const [roleRows, deptRows, overrideRows, scopeRows] = await Promise.all([
      StockRoleModulePermissionModel.find({ roleId: { $in: roleIds }, moduleId: module._id }).lean(),
      deptIds.length ? StockDepartmentModuleRestrictionModel.find({ departmentId: { $in: deptIds }, moduleId: module._id }).lean() : [],
      StockUserPermissionOverrideModel.find({ userId: { $in: userIds }, moduleId: module._id }).lean(),
      StockUserDataScopeModel.find({ userId: { $in: userIds }, $or: [{ moduleId: null }, { moduleId: module._id }] }).lean(),
    ]);
    const roleBy = new Map(roleRows.map((r) => [String(r.roleId), r]));
    const deptBy = new Map(deptRows.map((r) => [String(r.departmentId), r]));
    const overrideBy = new Map(overrideRows.map((r) => [String(r.userId), r]));
    const globalScopeBy = new Map(scopeRows.filter((r) => !r.moduleId).map((r) => [String(r.userId), r]));
    const moduleScopeBy = new Map(scopeRows.filter((r) => r.moduleId).map((r) => [String(r.userId), r]));

    const contacts = [];
    for (const { contact, user } of nonAdmins) {
      const uid = String(contact.userId);
      const actions = resolveEffectiveActions(
        roleBy.get(String(user.role?._id || "")),
        user.department?._id ? deptBy.get(String(user.department._id)) : null,
        overrideBy.get(uid)
      );
      if (!actions.has("READ")) continue;

      const dataAccess = resolveDataAccess(globalScopeBy.get(uid), moduleScopeBy.get(uid), {
        _id: contact.userId,
        branchId: user.branch ?? null,
      });
      let allow;
      try {
        allow = resolveDimensionAllowList(dataAccess, "branch");
      } catch {
        continue; // OWN with no branch assigned — sees no branch, hears about none
      }
      if (allow === null || allow.includes(String(branchId))) contacts.push(contact);
    }
    return { contacts, skipped };
  }
}
