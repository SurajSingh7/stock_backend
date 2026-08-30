import mongoose from "mongoose";

import StockQuotationService from "../services/stock.quotation.service.js";
import {
  successResponseHandler,
  errorResponseHandler,
} from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import {
  validateCreateQuotation,
  validateReviewQuotation,
} from "../validators/stock.validator.js";

const log = getLogger(import.meta.url);

const actingUser = (req) => ({
  id: req.user?._id || req.userId || null,
  name: req.user?.name || req.user?.fullName || "",
});

export default class StockQuotationController {
  /* -------------------------------- Create ------------------------------- */
  static async createQuotation(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateCreateQuotation(req.body);
      const quotation = await StockQuotationService.createQuotation(
        req.body,
        actingUser(req),
        session
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

  static async getVendorsForCategory(req, res) {
    try {
      const data = await StockQuotationService.getVendorsForCategory(
        req.params.catId
      );
      successResponseHandler(res, data, "Vendors for category fetched");
    } catch (error) {
      errorResponseHandler(res, error);
    }
  }

  /* -------------------------------- Update ------------------------------- */
  static async updateQuotation(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const quotation = await StockQuotationService.updateQuotation(
        req.params.id,
        req.body,
        actingUser(req),
        session
      );
      await session.commitTransaction();
      successResponseHandler(res, quotation, "Quotation updated");
    } catch (error) {
      await session.abortTransaction();
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
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
        session
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
        session
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
        session
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