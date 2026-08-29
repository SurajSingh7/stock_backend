import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockInvoiceService from "../services/stock.invoice.service.js";
import { toPublicInvoicePath, deleteInvoiceFile } from "../helpers/stock.invoice.upload.helper.js";
import {
  validateCreateInvoice,
  validateUpdateInvoice,
  validateRejectInvoice,
} from "../validators/stock.validator.js";
import { scopeCtxFromReq } from "../helpers/branch.scope.helper.js";
import { entityCtxFromReq } from "../helpers/entity.scope.helper.js";

const log = getLogger(import.meta.url);

const actingUser = (req) => ({
  id: req.user?._id || req.userId || null,
  name: req.user?.name || req.user?.fullName || "",
});

// Invoice create/update arrive as multipart/form-data (to carry the optional
// invoice file alongside the rest of the payload) — the JSON body is sent as
// a single "data" field. Same convention as stock.product.definition.controller.js.
function parseBody(req) {
  if (req.body && typeof req.body.data === "string") {
    return JSON.parse(req.body.data);
  }
  return req.body || {};
}

export default class StockInvoiceController {
  static async createInvoice(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const body = parseBody(req);
      validateCreateInvoice(body);
      if (req.file) body.invoiceFile = toPublicInvoicePath(req.file.filename);

      const data = await StockInvoiceService.createInvoice(
        req.params.id,
        body,
        actingUser(req),
        session,
        scopeCtxFromReq(req),
        entityCtxFromReq(req)
      );
      await session.commitTransaction();
      log.info("Invoice created");
      successResponseHandler(res, data, "Invoice created successfully", 201);
    } catch (error) {
      await session.abortTransaction();
      if (req.file) deleteInvoiceFile(toPublicInvoicePath(req.file.filename));
      log.error("Error creating invoice", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  // Bootstraps the "Add Items" / edit-invoice branch field. Read-only and
  // scoped to the caller — see StockInvoiceService.getReceivingBranches.
  static async getReceivingBranches(req, res) {
    try {
      const data = await StockInvoiceService.getReceivingBranches(scopeCtxFromReq(req));
      successResponseHandler(res, data, "Receiving branches fetched successfully");
    } catch (error) {
      log.error("Error fetching receiving branches", error);
      errorResponseHandler(res, error);
    }
  }

  static async getBoard(req, res) {
    try {
      const data = await StockInvoiceService.getBoard(req.query, scopeCtxFromReq(req), entityCtxFromReq(req));
      successResponseHandler(res, data, "Invoices fetched successfully");
    } catch (error) {
      log.error("Error fetching invoices board", error);
      errorResponseHandler(res, error);
    }
  }

  static async getInvoiceById(req, res) {
    try {
      const data = await StockInvoiceService.getInvoiceById(req.params.id, scopeCtxFromReq(req), entityCtxFromReq(req));
      successResponseHandler(res, data, "Invoice fetched successfully");
    } catch (error) {
      log.error("Error fetching invoice", error);
      errorResponseHandler(res, error);
    }
  }

  static async updateInvoice(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const body = parseBody(req);
      validateUpdateInvoice(body);
      if (req.file) body.invoiceFile = toPublicInvoicePath(req.file.filename);

      const data = await StockInvoiceService.updateInvoice(
        req.params.id,
        body,
        actingUser(req),
        session,
        scopeCtxFromReq(req),
        entityCtxFromReq(req)
      );
      await session.commitTransaction();
      log.info("Invoice updated");
      successResponseHandler(res, data, "Invoice resubmitted for approval");
    } catch (error) {
      await session.abortTransaction();
      if (req.file) deleteInvoiceFile(toPublicInvoicePath(req.file.filename));
      log.error("Error updating invoice", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async approveInvoice(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockInvoiceService.approveInvoice(req.params.id, actingUser(req), session, entityCtxFromReq(req));
      await session.commitTransaction();
      log.info("Invoice approved");
      successResponseHandler(res, data, "Invoice approved");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error approving invoice", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async rejectInvoice(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateRejectInvoice(req.body);
      const data = await StockInvoiceService.rejectInvoice(
        req.params.id,
        req.body.reason,
        actingUser(req),
        session,
        entityCtxFromReq(req)
      );
      await session.commitTransaction();
      log.info("Invoice rejected");
      successResponseHandler(res, data, "Invoice rejected");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error rejecting invoice", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }
}
