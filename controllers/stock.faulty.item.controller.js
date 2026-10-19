import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { paginateReturn } from "../helpers/pagination.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockFaultyItemService from "../services/stock.faulty.item.service.js";

const log = getLogger(import.meta.url);

// Read-only: every figure here comes from a debit note raised elsewhere.
export default class StockFaultyItemController {
  static async getList(req, res) {
    try {
      const { data, total, page, limit } = await StockFaultyItemService.getList(req.query, req.dataAccess);
      successResponseHandler(res, paginateReturn(data, total, page, limit), "Faulty items fetched successfully");
    } catch (error) {
      log.error("Error fetching faulty items", error);
      errorResponseHandler(res, error);
    }
  }

  static async getVendorSummary(req, res) {
    try {
      const data = await StockFaultyItemService.getVendorSummary(req.query, req.dataAccess);
      successResponseHandler(res, data, "Faulty items by vendor fetched successfully");
    } catch (error) {
      log.error("Error fetching faulty items by vendor", error);
      errorResponseHandler(res, error);
    }
  }

  static async getUnits(req, res) {
    try {
      const data = await StockFaultyItemService.getUnits(req.params.debitNoteId, req.params.lineIndex, req.dataAccess);
      successResponseHandler(res, data, "Faulty units fetched successfully");
    } catch (error) {
      log.error("Error fetching faulty units", error);
      errorResponseHandler(res, error);
    }
  }
}
