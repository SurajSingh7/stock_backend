import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { paginateReturn } from "../helpers/pagination.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockDebitNoteItemService from "../services/stock.debit.note.item.service.js";

const log = getLogger(import.meta.url);

// Read-only: every figure here comes from a debit note raised elsewhere.
export default class StockDebitNoteItemController {
  static async getList(req, res) {
    try {
      const { data, total, page, limit } = await StockDebitNoteItemService.getList(req.query, req.dataAccess);
      successResponseHandler(res, paginateReturn(data, total, page, limit), "Debit note items fetched successfully");
    } catch (error) {
      log.error("Error fetching debit note items", error);
      errorResponseHandler(res, error);
    }
  }

  static async getVendorSummary(req, res) {
    try {
      const data = await StockDebitNoteItemService.getVendorSummary(req.query, req.dataAccess);
      successResponseHandler(res, data, "Debit note items by vendor fetched successfully");
    } catch (error) {
      log.error("Error fetching debit note items by vendor", error);
      errorResponseHandler(res, error);
    }
  }

  static async getUnits(req, res) {
    try {
      const data = await StockDebitNoteItemService.getUnits(req.params.debitNoteId, req.params.lineIndex, req.dataAccess);
      successResponseHandler(res, data, "Debited units fetched successfully");
    } catch (error) {
      log.error("Error fetching debited units", error);
      errorResponseHandler(res, error);
    }
  }
}
