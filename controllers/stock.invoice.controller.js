import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockInvoiceService from "../services/stock.invoice.service.js";
import { emitAlertEvent, refreshAlerts } from "../services/stock.alert.dispatcher.service.js";
import { toPublicInvoicePath, deleteInvoiceFile } from "../helpers/stock.invoice.upload.helper.js";
import {
  validateCreateInvoice,
  validateUpdateInvoice,
  validateSaveItems,
  validateRejectInvoice,
} from "../validators/stock.validator.js";

const log = getLogger(import.meta.url);

// req.user already carries everything the audit trail wants — role, branch,
// IP, user agent. This used to return only { id, name }, which is why the
// purchase-order, quotation, invoice and transfer-request audit rows recorded
// an empty role and no IP. `id` is kept alongside `_id` so older call sites
// that read actor.id keep working.
const actingUser = (req) => (req.user ? { ...req.user, id: req.user._id } : null);

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
  // Add Invoice → upload: what the invoice says, read by Claude.
  static async readInvoiceFile(req, res) {
    try {
      if (!req.file) throw new Error("Upload the invoice file first");
      const data = await StockInvoiceService.readInvoiceFile(req.params.id, req.file, req.user, req.dataAccess);
      successResponseHandler(res, data, "Invoice read");
    } catch (error) {
      log.error("Error reading invoice file", error);
      errorResponseHandler(res, error);
    }
  }

  // Add Items — Save as Draft (submit=false) or Submit (submit=true).
  static async saveItems(req, res) {
    const session = await mongoose.startSession();
    const submit = req.body?.submit === true;
    try {
      session.startTransaction();
      validateSaveItems(req.body);
      const data = await StockInvoiceService.saveItems(
        req.params.id, req.body, actingUser(req), session, req.dataAccess, { submit }
      );
      await session.commitTransaction();
      if (submit) emitAlertEvent("INVOICE_SUBMITTED", req.params.id, { actor: req.user });
      successResponseHandler(res, data, submit ? "Invoice submitted for approval" : "Draft saved");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error saving invoice items", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  // ⋮ → Partial submit ON / OFF.
  static async setPartialSubmit(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      if (typeof req.body?.on !== "boolean") throw new Error("on must be true or false");
      const data = await StockInvoiceService.setPartialSubmit(req.params.id, req.body.on, actingUser(req), session, req.dataAccess);
      await session.commitTransaction();
      successResponseHandler(res, data, req.body.on ? "Partial submit turned on" : "Partial submit turned off");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error setting partial submit", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async approveEntry(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockInvoiceService.approveEntry(req.params.id, req.params.entryId, actingUser(req), session, req.dataAccess);
      await session.commitTransaction();
      refreshAlerts(req.params.id);
      successResponseHandler(res, data, "Entry approved");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error approving entry", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async rejectEntry(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateRejectInvoice(req.body);
      const data = await StockInvoiceService.rejectEntry(
        req.params.id, req.params.entryId, req.body.reason, actingUser(req), session, req.dataAccess
      );
      await session.commitTransaction();
      refreshAlerts(req.params.id);
      emitAlertEvent("INVOICE_REJECTED", req.params.id, { actor: req.user });
      successResponseHandler(res, data, "Entry rejected");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error rejecting entry", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async deleteInvoice(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockInvoiceService.deleteInvoice(req.params.id, actingUser(req), session, req.dataAccess);
      await session.commitTransaction();
      refreshAlerts(req.params.id);
      successResponseHandler(res, data, "Invoice deleted");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error deleting invoice", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

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
        req.dataAccess,
        req.dataAccess
      );
      await session.commitTransaction();
      log.info("Invoice added");
      successResponseHandler(res, data, "Invoice added", 201);
    } catch (error) {
      await session.abortTransaction();
      if (req.file) deleteInvoiceFile(toPublicInvoicePath(req.file.filename));
      log.error("Error creating invoice", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async getBoard(req, res) {
    try {
      const data = await StockInvoiceService.getBoard(req.query, req.dataAccess);
      successResponseHandler(res, data, "Invoices fetched successfully");
    } catch (error) {
      log.error("Error fetching invoices board", error);
      errorResponseHandler(res, error);
    }
  }

  static async getInvoiceById(req, res) {
    try {
      const data = await StockInvoiceService.getInvoiceById(req.params.id, req.dataAccess, { entryId: req.query.entryId || null });
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
        req.dataAccess,
        req.dataAccess
      );
      await session.commitTransaction();
      log.info("Invoice edited");
      successResponseHandler(res, data, "Invoice updated");
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
      const data = await StockInvoiceService.approveInvoice(req.params.id, actingUser(req), session, req.dataAccess);
      await session.commitTransaction();
      log.info("Invoice approved");
      refreshAlerts(req.params.id);
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
        req.dataAccess
      );
      await session.commitTransaction();
      log.info("Invoice rejected");
      refreshAlerts(req.params.id);
      emitAlertEvent("INVOICE_REJECTED", req.params.id, { actor: req.user });
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
