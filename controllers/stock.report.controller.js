import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { paginateReturn } from "../helpers/pagination.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockReportService from "../services/stock.report.service.js";
import StockVendorLedgerService from "../services/stock.vendor.ledger.service.js";

const log = getLogger(import.meta.url);

/*
  Four report modules, four permission surfaces.

  Each handler passes its OWN module key down, because requirePermission
  resolves the data scope per module: that is what lets somebody be
  branch-limited on Billing while seeing every branch on the overview. Passing
  a shared key would quietly give all four the same scope.

  Billing and Vendor Outstanding Overview call the vendor ledger's summary rather than having
  their own service code. They are the same figures read with different
  columns — the difference is entirely in what the screen shows and what it
  defaults its filters to. Two implementations of that arithmetic would drift
  into two answers, which is the failure this module is meant to end.

  Read-only, all four. Every number here already happened somewhere else.
*/
const MODULE = {
  BILLING: "billing-report",
  PAID: "paid-report",
  TRANSACTIONS: "transaction-register",
  BREAKUP: "invoice-breakup",
  ACCOUNT: "account-summary",
};

export default class StockReportController {
  /* ── Billing: what each vendor billed us in the chosen period ── */
  static async getBilling(req, res) {
    try {
      const { data, total, page, limit } = await StockVendorLedgerService.getVendorSummary(
        req.query,
        req.dataAccess,
        MODULE.BILLING
      );
      successResponseHandler(res, paginateReturn(data, total, page, limit), "Billing report fetched successfully");
    } catch (error) {
      log.error("Error fetching billing report", error);
      errorResponseHandler(res, error);
    }
  }

  /*
    Transaction register: payments, debit notes and misc charges.

    One handler for all four tabs. `type` picks which kind of row comes back,
    and ALL interleaves them by date — so the screen's tabs are a query
    parameter rather than four endpoints whose filters would have to be kept
    in step with each other.
  */
  static async getTransactions(req, res) {
    try {
      const { data, total, page, limit } = await StockReportService.getTransactionRegister(
        req.query,
        req.dataAccess,
        MODULE.TRANSACTIONS
      );
      successResponseHandler(res, paginateReturn(data, total, page, limit), "Transaction register fetched successfully");
    } catch (error) {
      log.error("Error fetching transaction register", error);
      errorResponseHandler(res, error);
    }
  }

  /*
    The invoices behind one vendor's row, on Billing and on the overview.

    Both hand off to the same getInvoiceBreakup the Invoice Breakup page uses:
    it already returns everything either drill-down needs — the tax split and
    extra charges for Billing, billing through to balance due for the
    overview. The two screens differ only in which columns they render and
    whether they pass a period.

    Separate routes rather than reusing /reports/invoice-breakup because
    permission is per module: somebody holding only billing-report:READ would
    get a 403 from that endpoint, and a drill-down that 403s is worse than no
    drill-down. vendorId comes off the path so a caller cannot widen it.
  */
  /* ── Paid: what has actually gone out, per vendor ── */
  static async getPaid(req, res) {
    try {
      const { data, total, page, limit } = await StockReportService.getPaymentSummary(
        req.query,
        req.dataAccess,
        MODULE.PAID
      );
      successResponseHandler(res, paginateReturn(data, total, page, limit), "Paid report fetched successfully");
    } catch (error) {
      log.error("Error fetching paid report", error);
      errorResponseHandler(res, error);
    }
  }

  /*
    The payments behind one vendor's row on Paid.

    Hands off to the transaction register with type=PAYMENT, so the rows here
    and the rows on that page are literally the same rows — the drill-down
    cannot drift from the register it mirrors.
  */
  static async getPaidPayments(req, res) {
    try {
      const { data, total, page, limit } = await StockReportService.getTransactionRegister(
        { ...req.query, vendorId: req.params.vendorId, type: "PAYMENT" },
        req.dataAccess,
        MODULE.PAID
      );
      successResponseHandler(res, paginateReturn(data, total, page, limit), "Vendor payments fetched successfully");
    } catch (error) {
      log.error("Error fetching vendor payments", error);
      errorResponseHandler(res, error);
    }
  }

  /*
    Vendor Outstanding Overview — billing through to what is still due, one row per
    vendor. The period picks invoices by INVOICE DATE (billedFrom/billedTo),
    and every figure on them is as on today, so each row adds up:
    Net Payable − Paid − Written Off = Balance Due.
  */
  static async getAccountSummary(req, res) {
    try {
      const { from, to, ...rest } = req.query;
      const { data, total, page, limit } = await StockVendorLedgerService.getVendorSummary(
        { ...rest, billedFrom: from, billedTo: to },
        req.dataAccess,
        MODULE.ACCOUNT
      );
      successResponseHandler(res, paginateReturn(data, total, page, limit), "Vendor account summary fetched successfully");
    } catch (error) {
      log.error("Error fetching vendor account summary", error);
      errorResponseHandler(res, error);
    }
  }

  static async getAccountSummaryInvoices(req, res) {
    try {
      const { data, total, page, limit } = await StockReportService.getInvoiceBreakup(
        { ...req.query, vendorId: req.params.vendorId },
        req.dataAccess,
        MODULE.ACCOUNT
      );
      successResponseHandler(res, paginateReturn(data, total, page, limit), "Vendor invoices fetched successfully");
    } catch (error) {
      log.error("Error fetching account summary invoices for vendor", error);
      errorResponseHandler(res, error);
    }
  }

  static async getBillingInvoices(req, res) {
    try {
      const { data, total, page, limit } = await StockReportService.getInvoiceBreakup(
        { ...req.query, vendorId: req.params.vendorId },
        req.dataAccess,
        MODULE.BILLING
      );
      successResponseHandler(res, paginateReturn(data, total, page, limit), "Vendor invoices fetched successfully");
    } catch (error) {
      log.error("Error fetching billing invoices for vendor", error);
      errorResponseHandler(res, error);
    }
  }

  /* ── Invoice breakup: how each amount was arrived at ── */
  static async getInvoiceBreakup(req, res) {
    try {
      const { data, total, page, limit } = await StockReportService.getInvoiceBreakup(
        req.query,
        req.dataAccess,
        MODULE.BREAKUP
      );
      successResponseHandler(res, paginateReturn(data, total, page, limit), "Invoice breakup fetched successfully");
    } catch (error) {
      log.error("Error fetching invoice breakup", error);
      errorResponseHandler(res, error);
    }
  }
}
