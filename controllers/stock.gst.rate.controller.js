import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import StockGstRateService from "../services/stock.gst.rate.service.js";
import { validateCreateGstRate, validateUpdateGstRate } from "../validators/stock.validator.js";

const log = getLogger(import.meta.url);

export default class StockGstRateController {
  static async createGstRate(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateCreateGstRate(req.body);
      const data = await StockGstRateService.createGstRate(req.body, req.user, session);
      await session.commitTransaction();
      log.info("GST rate created");
      successResponseHandler(res, data, "GST rate created successfully", 201);
    } catch (error) {
      await session.abortTransaction();
      log.error("Error creating GST rate", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async getAllGstRates(req, res) {
    try {
      const { skip, limit, page } = paginate(req.query);
      const { search, showInactive } = req.query;
      const { data, total } = await StockGstRateService.getAllGstRates({
        skip,
        limit,
        search,
        showInactive: showInactive === "true",
      });
      successResponseHandler(res, paginateReturn(data, total, page, limit), "GST rates fetched successfully");
    } catch (error) {
      log.error("Error fetching GST rates", error);
      errorResponseHandler(res, error);
    }
  }

  // Feeds every GST dropdown in the app. Auth-only by design — see
  // StockGstRateService.getActiveGstRates for why no module permission is asked.
  static async getActiveGstRates(req, res) {
    try {
      const data = await StockGstRateService.getActiveGstRates();
      successResponseHandler(res, data, "Active GST rates fetched successfully");
    } catch (error) {
      log.error("Error fetching active GST rates", error);
      errorResponseHandler(res, error);
    }
  }

  static async getGstRateById(req, res) {
    try {
      const data = await StockGstRateService.getGstRateById(req.params.id);
      successResponseHandler(res, data, "GST rate fetched successfully");
    } catch (error) {
      log.error("Error fetching GST rate", error);
      errorResponseHandler(res, error);
    }
  }

  static async updateGstRate(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateUpdateGstRate(req.body);
      const data = await StockGstRateService.updateGstRate(req.params.id, req.body, req.user, session);
      await session.commitTransaction();
      log.info("GST rate updated");
      successResponseHandler(res, data, "GST rate updated successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error updating GST rate", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async softDeleteGstRate(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockGstRateService.softDeleteGstRate(req.params.id, req.user, session);
      await session.commitTransaction();
      log.info("GST rate soft deleted");
      successResponseHandler(res, data, "GST rate deleted successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error deleting GST rate", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async restoreGstRate(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockGstRateService.restoreGstRate(req.params.id, req.user, session);
      await session.commitTransaction();
      log.info("GST rate restored");
      successResponseHandler(res, data, "GST rate restored successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error restoring GST rate", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }
}
