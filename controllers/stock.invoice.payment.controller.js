import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { paginateReturn } from "../helpers/pagination.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockInvoicePaymentService from "../services/stock.invoice.payment.service.js";
import { groupProofsBySplit, deletePaymentProofFile } from "../helpers/stock.payment.upload.helper.js";
import {
  validateSchedulePayment,
  validateCreateAdjustment,
  validateUpdateAdjustment,
  validatePaymentApprovalDecision,
  validateRecordPayment,
} from "../validators/stock.validator.js";

/*
  The JSON half of a multipart request. Same convention as
  StockInvoiceController: everything that is not a file travels in one `data`
  field, so nested arrays survive the trip intact.
*/
function parseBody(req) {
  if (req.body && typeof req.body.data === "string") {
    return JSON.parse(req.body.data);
  }
  return req.body || {};
}

const log = getLogger(import.meta.url);

/*
  The payment side of an invoice, for three different screens.

  Which MODULE a request came through matters and is passed down: scope is
  resolved per module, so the stock team's view of an invoice and the account
  team's view of the same invoice can legitimately differ. Each handler names
  its own key rather than letting the service guess.

  Adjustments are created, edited and withdrawn by ACCOUNTS only. The Invoice
  List reads them and nothing more — the stock team's request-and-review round
  trip has been removed, not merely hidden.
*/
const MODULE = {
  INVOICE_LIST: "invoice-list",
  PAYMENTS: "payments",
  PAYMENT_APPROVAL: "payment-approval",
};

export default class StockInvoicePaymentController {
  /*
    Every write here is one transaction with the same commit/abort shape, so it
    is written once — the same pattern as StockTrackingOrderController.txn.
  */
  static txn(run, okMessage) {
    return async (req, res) => {
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        const data = await run(req, session);
        await session.commitTransaction();
        successResponseHandler(res, data, okMessage);
      } catch (error) {
        await session.abortTransaction();
        log.error(okMessage + " failed", error);
        errorResponseHandler(res, error);
      } finally {
        await session.endSession();
      }
    };
  }

  /* ── Reads ─────────────────────────────────────────────────────────── */

  // Shared by all three screens; they differ only in the module they arrive
  // through, and therefore in what each is scoped to see.
  static list(moduleKey) {
    return async (req, res) => {
      try {
        const { data, total, page, limit } = await StockInvoicePaymentService.getList(
          req.query,
          req.dataAccess,
          moduleKey
        );
        successResponseHandler(
          res,
          paginateReturn(data, total, page, limit),
          "Invoice list fetched successfully"
        );
      } catch (error) {
        log.error("Error fetching invoice payment list", error);
        errorResponseHandler(res, error);
      }
    };
  }

  static getList = StockInvoicePaymentController.list(MODULE.INVOICE_LIST);
  static getPaymentsList = StockInvoicePaymentController.list(MODULE.PAYMENTS);
  static getApprovalList = StockInvoicePaymentController.list(MODULE.PAYMENT_APPROVAL);

  /*
    Feeds the Credit Note page: which units of this invoice can still be
    written off, and why the rest cannot.

    ?adjustmentId is passed when EDITING one — its own claims must not count as
    "already taken", or every unit it already holds would come back blocked.
  */
  static async getCreditableItems(req, res) {
    try {
      const data = await StockInvoicePaymentService.getCreditableItems(
        req.params.id,
        req.dataAccess,
        MODULE.PAYMENTS,
        req.query.adjustmentId || null
      );
      successResponseHandler(res, data, "Creditable items fetched successfully");
    } catch (error) {
      log.error("Error fetching creditable items", error);
      errorResponseHandler(res, error);
    }
  }

  static listAdjustments(moduleKey) {
    return async (req, res) => {
      try {
        const data = await StockInvoicePaymentService.listAdjustments(
          req.params.id,
          req.dataAccess,
          moduleKey
        );
        successResponseHandler(res, data, "Adjustments fetched successfully");
      } catch (error) {
        log.error("Error fetching adjustments", error);
        errorResponseHandler(res, error);
      }
    };
  }

  // Three read-only views of the same rows, one per audience. Each carries its
  // own module so each is scoped to what that team may see.
  static getAdjustments = StockInvoicePaymentController.listAdjustments(MODULE.INVOICE_LIST);
  static getAdjustmentsForAccounts = StockInvoicePaymentController.listAdjustments(MODULE.PAYMENTS);
  static getAdjustmentsForApproval = StockInvoicePaymentController.listAdjustments(MODULE.PAYMENT_APPROVAL);

  /* ── Writes ────────────────────────────────────────────────────────── */

  static schedulePayment = StockInvoicePaymentController.txn(
    (req, session) => {
      validateSchedulePayment(req.body);
      return StockInvoicePaymentService.schedulePayment(
        req.params.id, req.body, req.user, session, req.dataAccess
      );
    },
    "Payment schedule updated"
  );

  static createAdjustment = StockInvoicePaymentController.txn(
    (req, session) => {
      validateCreateAdjustment(req.body);
      return StockInvoicePaymentService.createAdjustment(
        req.params.id, req.body, req.user, session, req.dataAccess, { moduleKey: MODULE.PAYMENTS }
      );
    },
    "Adjustment saved"
  );

  // :id here is the ADJUSTMENT, not the invoice.
  static updateAdjustment = StockInvoicePaymentController.txn(
    (req, session) => {
      validateUpdateAdjustment(req.body);
      return StockInvoicePaymentService.updateAdjustment(
        req.params.id, req.body, req.user, session, req.dataAccess, MODULE.PAYMENTS
      );
    },
    "Adjustment updated"
  );

  static deleteAdjustment = StockInvoicePaymentController.txn(
    (req, session) =>
      StockInvoicePaymentService.deleteAdjustment(
        req.params.id, req.body, req.user, session, req.dataAccess, MODULE.PAYMENTS
      ),
    "Adjustment withdrawn"
  );

  static sendForApproval = StockInvoicePaymentController.txn(
    (req, session) =>
      StockInvoicePaymentService.sendForPaymentApproval(
        req.params.id, req.body, req.user, session, req.dataAccess, MODULE.PAYMENTS
      ),
    "Sent for payment approval"
  );

  static decideApproval = StockInvoicePaymentController.txn(
    (req, session) => {
      validatePaymentApprovalDecision(req.body);
      return StockInvoicePaymentService.decidePaymentApproval(
        req.params.id, req.body, req.user, session, req.dataAccess, MODULE.PAYMENT_APPROVAL
      );
    },
    "Payment approval decision saved"
  );

  /*
    Recording a payment and its splits, each with its own proof files.

    Not using txn(): multer has already written the uploads to disk before this
    runs, so a failure has to delete them as well as abort the transaction.
    Leaving them behind would fill the disk with files no record points at.
  */
  static async recordPayment(req, res) {
    // Collected before anything can throw, so the cleanup path always knows
    // what was written even if parsing the body fails.
    const bySplit = groupProofsBySplit(req.files);
    const allProofs = [...bySplit.values()].flat();

    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const body = parseBody(req);
      validateRecordPayment(body);

      // Each file goes back to the split it was uploaded for.
      const splits = body.splits.map((s, i) => ({ ...s, proofs: bySplit.get(i) || [] }));

      const data = await StockInvoicePaymentService.recordPayment(
        req.params.id,
        { ...body, splits },
        req.user,
        session,
        req.dataAccess,
        MODULE.PAYMENTS
      );
      await session.commitTransaction();
      successResponseHandler(res, data, "Payment recorded");
    } catch (error) {
      await session.abortTransaction();
      allProofs.forEach((p) => deletePaymentProofFile(p));
      log.error("Error recording payment", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }
}
