import StockAuditLogModel from "../models/stock.audit.log.model.js";
import { getLogger } from "../helpers/logger.helper.js";

const log = getLogger(import.meta.url);

const diffKeys = (before, after) => {
  if (!before || !after) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.push(key);
  }
  return changed;
};

export default class StockAuditLogService {
  // Deliberately swallows its own errors — a logging failure must never
  // fail the business action it's describing. The failure is still visible
  // via the logger, just not to the caller.
  static recordAudit = async ({ entityType, entityId, action, actor, before = null, after = null, reason = "" }) => {
    // No actor at all = no signed-in user: a release script, seeder or the
    // alert worker. Say so, rather than leaving a blank "who" in the trail.
    if (!actor) actor = { name: "System", roleName: "System" };
    try {
      await StockAuditLogModel.create({
        entityType,
        entityId,
        action,
        actor: {
          // Handles both req.user (`_id`) and the older `actingUser(req)`
          // helper's minimal `{ id, name }` shape used by a few controllers.
          userId: actor?._id ?? actor?.id ?? null,
          employeeCode: actor?.employeeCode ?? "",
          name: actor?.name ?? "",
          email: actor?.email ?? "",
          roleName: actor?.roleName ?? "",
          branchId: actor?.branchId ?? null,
          ipAddress: actor?.ipAddress ?? null,
          userAgent: actor?.userAgent ?? "",
        },
        before,
        after,
        changedFields: diffKeys(before, after),
        reason,
      });
    } catch (error) {
      log.error(`Failed to record audit log for ${entityType}:${entityId} action=${action}`, error);
    }
  };

  // Per-record timeline — the "History" tab on a record's detail page.
  static getEntityHistory = async ({ entityType, entityId, skip = 0, limit = 20 }) => {
    if (!entityType || !entityId) throw new Error("entityType and entityId are required");
    const filter = { entityType, entityId };
    const [data, total] = await Promise.all([
      StockAuditLogModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      StockAuditLogModel.countDocuments(filter),
    ]);
    return { data, total };
  };

  // Global "who did what, when" — filterable by user/entity type/date range.
  static getActivityLog = async ({ userId, entityType, from, to, skip = 0, limit = 20 }) => {
    const filter = {};
    if (userId) filter["actor.userId"] = userId;
    if (entityType) filter.entityType = entityType;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }
    const [data, total] = await Promise.all([
      StockAuditLogModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      StockAuditLogModel.countDocuments(filter),
    ]);
    return { data, total };
  };
}
