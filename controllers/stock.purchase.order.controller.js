import mongoose from "mongoose";
import fs from "fs";

import StockPurchaseOrderService from "../services/stock.purchase.order.service.js";
import {
  successResponseHandler,
  errorResponseHandler,
} from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import { poPdfAbsolutePath } from "../helpers/stock.po.pdf.helper.js";
import {
  validateCreatePurchaseOrder,
  validateRejectPurchaseOrder,
  validateSendMail,
} from "../validators/stock.validator.js";

const log = getLogger(import.meta.url);

// req.user already carries everything the audit trail wants — role, branch,
// IP, user agent. This used to return only { id, name }, which is why the
// purchase-order, quotation, invoice and transfer-request audit rows recorded
// an empty role and no IP. `id` is kept alongside `_id` so older call sites
// that read actor.id keep working.
const actingUser = (req) => (req.user ? { ...req.user, id: req.user._id } : null);

export default class StockPurchaseOrderController {
  static async getCandidates(req, res) {
    try {
      const data = await StockPurchaseOrderService.getCandidates(req.query);
      successResponseHandler(res, data, "PO candidates fetched");
    } catch (error) {
      errorResponseHandler(res, error);
    }
  }

  static async getBoard(req, res) {
    try {
      const data = await StockPurchaseOrderService.getBoard(req.query, req.dataAccess);
      successResponseHandler(res, data, "PO board fetched");
    } catch (error) {
      errorResponseHandler(res, error);
    }
  }



  static async createPurchaseOrder(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateCreatePurchaseOrder(req.body);
      const po = await StockPurchaseOrderService.createPurchaseOrder(
        req.body,
        actingUser(req),
        session,
        req.dataAccess
      );
      await session.commitTransaction();
      // Only once the PO is safely committed: writing the file inside the
      // transaction would leave an orphan PDF behind if it later aborted.
      po.pdfPath = (await StockPurchaseOrderService.attachPdf(po._id)) || "";
      successResponseHandler(res, po, "Purchase order created", 201);
    } catch (error) {
      await session.abortTransaction();
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async getAllPurchaseOrders(req, res) {
    try {
      const data = await StockPurchaseOrderService.getAllPurchaseOrders(req.query, req.dataAccess);
      successResponseHandler(res, data, "Purchase orders fetched");
    } catch (error) {
      errorResponseHandler(res, error);
    }
  }

  static async getPurchaseOrderById(req, res) {
    try {
      const po = await StockPurchaseOrderService.getPurchaseOrderById(req.params.id, req.dataAccess);
      successResponseHandler(res, po, "Purchase order fetched");
    } catch (error) {
      errorResponseHandler(res, error);
    }
  }

  // Streams the generated PDF inline.
  static async getPurchaseOrderPdf(req, res) {
    try {
      const po = await StockPurchaseOrderService.getPurchaseOrderById(req.params.id, req.dataAccess);
      if (!po.pdfPath) throw new Error("PDF not generated for this PO");
      const abs = poPdfAbsolutePath(po.pdfPath);
      if (!fs.existsSync(abs)) throw new Error("PDF file missing on server");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${po.poNumber}.pdf"`);
      fs.createReadStream(abs).pipe(res);
    } catch (error) {
      errorResponseHandler(res, error);
    }
  }

  static async updatePurchaseOrder(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const po = await StockPurchaseOrderService.updatePurchaseOrder(
        req.params.id,
        req.body,
        actingUser(req),
        session,
        req.dataAccess
      );
      await session.commitTransaction();
      successResponseHandler(res, po, "Purchase order updated");
    } catch (error) {
      await session.abortTransaction();
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async approvePurchaseOrder(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const po = await StockPurchaseOrderService.approvePurchaseOrder(
        req.params.id,
        actingUser(req),
        session,
        req.dataAccess
      );
      await session.commitTransaction();
      successResponseHandler(res, po, "Purchase order approved");
    } catch (error) {
      await session.abortTransaction();
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async rejectPurchaseOrder(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateRejectPurchaseOrder(req.body);
      const po = await StockPurchaseOrderService.rejectPurchaseOrder(
        req.params.id,
        req.body.rejectedReason,
        actingUser(req),
        session,
        req.dataAccess
      );
      await session.commitTransaction();
      successResponseHandler(res, po, "Purchase order rejected");
    } catch (error) {
      await session.abortTransaction();
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  // No transaction here on purpose. Sending the mail is an external side
  // effect that cannot be rolled back, so wrapping it in one only created the
  // illusion of safety — the mail still left, and an abort afterwards just
  // erased the record of it. The service sends first, then records in a short
  // transaction of its own. See StockPurchaseOrderService.sendMail.
  static async sendMail(req, res) {
    try {
      validateSendMail(req.body);
      const data = await StockPurchaseOrderService.sendMail(
        req.params.id,
        req.body,
        actingUser(req),
        req.dataAccess
      );
      successResponseHandler(res, data, "Mail action completed");
    } catch (error) {
      errorResponseHandler(res, error);
    }
  }

  static async softDeletePurchaseOrder(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const po = await StockPurchaseOrderService.softDeletePurchaseOrder(
        req.params.id,
        actingUser(req),
        session,
        req.dataAccess
      );
      await session.commitTransaction();
      successResponseHandler(res, po, "Purchase order deleted");
    } catch (error) {
      await session.abortTransaction();
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }
}