import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockTrackingOrderService from "../services/stock.tracking.order.service.js";
import { validateAddEntity, validateMarkNotRequired } from "../validators/stock.validator.js";

const log = getLogger(import.meta.url);

export default class StockTrackingOrderController {
  static async getBoard(req, res) {
    try {
      const data = await StockTrackingOrderService.getBoard(req.query);
      successResponseHandler(res, data, "Tracking orders board fetched");
    } catch (error) {
      log.error("Error fetching tracking orders board", error);
      errorResponseHandler(res, error);
    }
  }

  static async addEntity(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateAddEntity(req.body);
      const data = await StockTrackingOrderService.addEntity(req.params.id, req.body, session);
      await session.commitTransaction();
      log.info("Entity assigned to tracking order");
      successResponseHandler(res, data, "Entity assigned successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error assigning entity", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async markNotRequired(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateMarkNotRequired(req.body);
      const data = await StockTrackingOrderService.markNotRequired(req.params.id, req.body.reason, session);
      await session.commitTransaction();
      log.info("Tracking order marked Not Required");
      successResponseHandler(res, data, "Marked as Not Required");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error marking Not Required", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }
}
