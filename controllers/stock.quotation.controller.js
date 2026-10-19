import mongoose from "mongoose";

import StockQuotationService from "../services/stock.quotation.service.js";
import StockTrackingOrderService from "../services/stock.tracking.order.service.js";
import {
  successResponseHandler,
  errorResponseHandler,
} from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import {
  validateQuotationPayload,
  validateReviewQuotation,
} from "../validators/stock.validator.js";

const log = getLogger(import.meta.url);

// req.user already carries everything the audit trail wants — role, branch,
// IP, user agent. This used to return only { id, name }, which is why the
// purchase-order, quotation, invoice and transfer-request audit rows recorded
// an empty role and no IP. `id` is kept alongside `_id` so older call sites
// that read actor.id keep working.
const actingUser = (req) => (req.user ? { ...req.user, id: req.user._id } : null);

export default class StockQuotationController {
  /* -------------------------------- Create ------------------------------- */
  static async createQuotation(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateQuotationPayload(req.body);
      const quotation = await StockQuotationService.createQuotation(
        req.body,
        actingUser(req),
        session,
        req.dataAccess
      );
      await session.commitTransaction();
      successResponseHandler(res, quotation, "Quotation created", 201);
    } catch (error) {
      await session.abortTransaction();
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  /* --------------------------------- Read -------------------------------- */
  static async getAllQuotations(req, res) {
    try {
      const data = await StockQuotationService.getAllQuotations(req.query, req.dataAccess);
      successResponseHandler(res, data, "Quotations fetched");
    } catch (error) {
      errorResponseHandler(res, error);
    }
  }

  static async getStatusSummary(req, res) {
    try {
      const summary = await StockQuotationService.getStatusSummary(req.dataAccess);
      successResponseHandler(res, summary, "Status summary fetched");
    } catch (error) {
      errorResponseHandler(res, error);
    }
  }

  static async getQuotationById(req, res) {
    try {
      const quotation = await StockQuotationService.getQuotationById(req.params.id, req.dataAccess);
      successResponseHandler(res, quotation, "Quotation fetched");
    } catch (error) {
      errorResponseHandler(res, error);
    }
  }

  // ?categoryIds=a,b&excludeQuotationId=… → open orders still to arrive, per category.
  static async getPendingOrders(req, res) {
    try {
      const ids = String(req.query.categoryIds || "").split(",").map((s) => s.trim()).filter(Boolean);
      const data = await StockTrackingOrderService.getPendingByCategory(ids, {
        excludeQuotationId: req.query.excludeQuotationId || null,
      });
      successResponseHandler(res, data, "Pending orders fetched successfully");
    } catch (error) {
      log.error("Error fetching pending orders", error);
      errorResponseHandler(res, error);
    }
  }

  static async getVendorsForCategory(req, res) {
    try {
      const data = await StockQuotationService.getVendorsForCategory(
        req.params.catId,
        req.dataAccess
      );
      successResponseHandler(res, data, "Vendors for category fetched");
    } catch (error) {
      errorResponseHandler(res, error);
    }
  }

  /* -------------------------------- Review ------------------------------- */
  static async reviewQuotation(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateReviewQuotation(req.body);
      const quotation = await StockQuotationService.reviewQuotation(
        req.params.id,
        req.body.decisions,
        actingUser(req),
        session,
        req.dataAccess
      );
      await session.commitTransaction();
      successResponseHandler(res, quotation, "Quotation reviewed");
    } catch (error) {
      await session.abortTransaction();
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  /* --------------------------- Delete / Restore -------------------------- */
  static async softDeleteQuotation(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const quotation = await StockQuotationService.softDeleteQuotation(
        req.params.id,
        actingUser(req),
        session,
        req.dataAccess
      );
      await session.commitTransaction();
      successResponseHandler(res, quotation, "Quotation deleted");
    } catch (error) {
      await session.abortTransaction();
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async restoreQuotation(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const quotation = await StockQuotationService.restoreQuotation(
        req.params.id,
        actingUser(req),
        session,
        req.dataAccess
      );
      await session.commitTransaction();
      successResponseHandler(res, quotation, "Quotation restored");
    } catch (error) {
      await session.abortTransaction();
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }
}