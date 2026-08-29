import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import StockAuditLogService from "../services/stock.audit.log.service.js";

const log = getLogger(import.meta.url);

export default class StockAuditLogController {
  // Per-record timeline — e.g. the History tab on a branch's detail page.
  static async getEntityHistory(req, res) {
    try {
      const { skip, limit, page } = paginate(req.query);
      const { entityType, entityId } = req.query;
      const { data, total } = await StockAuditLogService.getEntityHistory({ entityType, entityId, skip, limit });
      successResponseHandler(res, paginateReturn(data, total, page, limit), "History fetched successfully");
    } catch (error) {
      log.error("Error fetching entity history", error);
      errorResponseHandler(res, error);
    }
  }

  // Global "who did what, when" — filterable by user / entity type / date range.
  static async getActivityLog(req, res) {
    try {
      const { skip, limit, page } = paginate(req.query);
      const { userId, entityType, from, to } = req.query;
      const { data, total } = await StockAuditLogService.getActivityLog({ userId, entityType, from, to, skip, limit });
      successResponseHandler(res, paginateReturn(data, total, page, limit), "Activity log fetched successfully");
    } catch (error) {
      log.error("Error fetching activity log", error);
      errorResponseHandler(res, error);
    }
  }
}
