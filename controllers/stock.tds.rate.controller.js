import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import StockTdsRateService from "../services/stock.tds.rate.service.js";
import { validateCreateTdsRate, validateUpdateTdsRate } from "../validators/stock.validator.js";

const log = getLogger(import.meta.url);

export default class StockTdsRateController {
  static async createTdsRate(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateCreateTdsRate(req.body);
      const data = await StockTdsRateService.createTdsRate(req.body, req.user, session);
      await session.commitTransaction();
      log.info("TDS rate created");
      successResponseHandler(res, data, "TDS rate created successfully", 201);
    } catch (error) {
      await session.abortTransaction();
      log.error("Error creating TDS rate", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async getAllTdsRates(req, res) {
    try {
      const { skip, limit, page } = paginate(req.query);
      const { search, showInactive } = req.query;
      const { data, total } = await StockTdsRateService.getAllTdsRates({
        skip,
        limit,
        search,
        showInactive: showInactive === "true",
      });
      successResponseHandler(res, paginateReturn(data, total, page, limit), "TDS rates fetched successfully");
    } catch (error) {
      log.error("Error fetching TDS rates", error);
      errorResponseHandler(res, error);
    }
  }

  static async getTdsRateById(req, res) {
    try {
      const data = await StockTdsRateService.getTdsRateById(req.params.id);
      successResponseHandler(res, data, "TDS rate fetched successfully");
    } catch (error) {
      log.error("Error fetching TDS rate", error);
      errorResponseHandler(res, error);
    }
  }

  static async updateTdsRate(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateUpdateTdsRate(req.body);
      const data = await StockTdsRateService.updateTdsRate(req.params.id, req.body, req.user, session);
      await session.commitTransaction();
      log.info("TDS rate updated");
      successResponseHandler(res, data, "TDS rate updated successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error updating TDS rate", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async softDeleteTdsRate(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockTdsRateService.softDeleteTdsRate(req.params.id, req.user, session);
      await session.commitTransaction();
      log.info("TDS rate soft deleted");
      successResponseHandler(res, data, "TDS rate deleted successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error deleting TDS rate", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async restoreTdsRate(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockTdsRateService.restoreTdsRate(req.params.id, req.user, session);
      await session.commitTransaction();
      log.info("TDS rate restored");
      successResponseHandler(res, data, "TDS rate restored successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error restoring TDS rate", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }
}
