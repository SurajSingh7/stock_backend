import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { paginateReturn } from "../helpers/pagination.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockLowStockService from "../services/stock.low.stock.service.js";

const log = getLogger(import.meta.url);

// Read-only: what is at or below its threshold right now, in the caller's branches.
export default class StockLowStockController {
  static async getList(req, res) {
    try {
      const { rows, counts, total, page, limit } = await StockLowStockService.list(req.query, req.dataAccess);
      successResponseHandler(res, paginateReturn({ rows, counts }, total, page, limit), "Low stock fetched successfully");
    } catch (error) {
      log.error("Error fetching low stock", error);
      errorResponseHandler(res, error);
    }
  }
}
