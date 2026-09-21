import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockTrackingOrderService from "../services/stock.tracking.order.service.js";
import {
  validateAddEntity,
  validateSetExclusions,
  validateResetOrder,
  validateClosureDecision,
} from "../validators/stock.validator.js";

const log = getLogger(import.meta.url);

export default class StockTrackingOrderController {
  /*
    Every write on this module is one transaction with the same commit/abort
    shape, so it is written once here instead of four times. Each route only
    supplies what it actually does.
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

  static async getBoard(req, res) {
    try {
      const data = await StockTrackingOrderService.getBoard(req.query, req.dataAccess);
      successResponseHandler(res, data, "Tracking orders board fetched");
    } catch (error) {
      log.error("Error fetching tracking orders board", error);
      errorResponseHandler(res, error);
    }
  }

  static async getDetail(req, res) {
    try {
      const data = await StockTrackingOrderService.getDetail(req.params.id, req.dataAccess);
      successResponseHandler(res, data, "Tracking order fetched");
    } catch (error) {
      log.error("Error fetching tracking order", error);
      errorResponseHandler(res, error);
    }
  }

  static async addEntity(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateAddEntity(req.body);
      const data = await StockTrackingOrderService.addEntity(req.params.id, req.body, req.user, session, req.dataAccess);
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

  static async getNotRequired(req, res) {
    try {
      const data = await StockTrackingOrderService.getNotRequired(req.query, req.dataAccess);
      successResponseHandler(res, data, "Not Required register fetched");
    } catch (error) {
      log.error("Error fetching Not Required register", error);
      errorResponseHandler(res, error);
    }
  }

  static markNotRequired = StockTrackingOrderController.txn(
    (req, session) => {
      validateSetExclusions(req.body);
      return StockTrackingOrderService.setExclusions(req.params.id, req.body, req.user, session, req.dataAccess);
    },
    "Decision saved"
  );

  static markRequired = StockTrackingOrderController.txn(
    (req, session) => StockTrackingOrderService.markRequired(req.params.id, req.user, session, req.dataAccess),
    "Vendor marked as required"
  );

  static shortCloseOrder = StockTrackingOrderController.txn(
    (req, session) => {
      validateClosureDecision(req.body);
      return StockTrackingOrderService.shortCloseOrder(req.params.id, req.body, req.user, session, req.dataAccess);
    },
    "Order short closed"
  );

  static reopenOrder = StockTrackingOrderController.txn(
    (req, session) => {
      validateClosureDecision(req.body);
      return StockTrackingOrderService.reopenOrder(req.params.id, req.body, req.user, session, req.dataAccess);
    },
    "Order reopened"
  );

  static resetOrder = StockTrackingOrderController.txn(
    (req, session) => {
      validateResetOrder(req.body);
      return StockTrackingOrderService.resetOrder(req.params.id, req.body, req.user, session, req.dataAccess);
    },
    "Order reset"
  );
}
