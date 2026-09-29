import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { paginateReturn } from "../helpers/pagination.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockVendorLedgerService from "../services/stock.vendor.ledger.service.js";

const log = getLogger(import.meta.url);

/*
  Read-only, all four of them.

  A ledger never writes: every figure on it already happened somewhere else —
  an invoice was approved, a credit note accepted, a payment recorded. Giving
  this module a write action would create a second way to change a balance,
  and then two places to look when one is wrong.
*/
export default class StockVendorLedgerController {
  // One row per vendor: period totals, plus outstanding and ageing as on today.
  static async getVendorSummary(req, res) {
    try {
      const { data, total, page, limit } = await StockVendorLedgerService.getVendorSummary(
        req.query,
        req.dataAccess
      );
      successResponseHandler(res, paginateReturn(data, total, page, limit), "Vendor ledger fetched successfully");
    } catch (error) {
      log.error("Error fetching vendor ledger summary", error);
      errorResponseHandler(res, error);
    }
  }

  // Twelve months of one year for one vendor, balance carried forward.
  static async getVendorLedger(req, res) {
    try {
      const data = await StockVendorLedgerService.getVendorLedger(
        req.params.vendorId,
        req.query,
        req.dataAccess
      );
      successResponseHandler(res, data, "Vendor ledger fetched successfully");
    } catch (error) {
      log.error("Error fetching vendor ledger", error);
      errorResponseHandler(res, error);
    }
  }

  /*
    One vendor's invoices, one row each.

    Sits between the vendor rollup and the month detail: the rollup cannot say
    WHICH invoice a figure came from, and the month view splits one invoice
    across however many months its payments landed in.
  */
  static async getVendorInvoices(req, res) {
    try {
      const { data, total, page, limit } = await StockVendorLedgerService.getVendorInvoices(
        req.params.vendorId,
        req.query,
        req.dataAccess
      );
      successResponseHandler(res, paginateReturn(data, total, page, limit), "Vendor invoices fetched successfully");
    } catch (error) {
      log.error("Error fetching vendor ledger invoices", error);
      errorResponseHandler(res, error);
    }
  }

  // The documents behind one month's figures.
  static async getMonthDetail(req, res) {
    try {
      const data = await StockVendorLedgerService.getMonthDetail(
        req.params.vendorId,
        req.query,
        req.dataAccess
      );
      successResponseHandler(res, data, "Month detail fetched successfully");
    } catch (error) {
      log.error("Error fetching vendor ledger month detail", error);
      errorResponseHandler(res, error);
    }
  }
}
