import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockTransferRequestService from "../services/stock.transfer.request.service.js";
import {
  validateCreateTransferRequest,
  validateProcessTransferRequest,
  validateRejectTransferRequest,
} from "../validators/stock.validator.js";
import { scopeCtxFromReq } from "../helpers/branch.scope.helper.js";

const log = getLogger(import.meta.url);

const actingUser = (req) => ({
  id: req.user?._id || req.userId || null,
  name: req.user?.name || req.user?.fullName || "",
});

export default class StockTransferRequestController {
  static async createTransferRequest(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateCreateTransferRequest(req.body);
      const data = await StockTransferRequestService.createTransferRequest(req.body, actingUser(req), session);
      await session.commitTransaction();
      log.info("Transfer request created");
      successResponseHandler(res, data, "Transfer request created successfully", 201);
    } catch (error) {
      await session.abortTransaction();
      log.error("Error creating transfer request", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async getBoard(req, res) {
    try {
      const data = await StockTransferRequestService.getBoard(req.query, scopeCtxFromReq(req));
      successResponseHandler(res, data, "Transfer requests fetched successfully");
    } catch (error) {
      log.error("Error fetching transfer requests board", error);
      errorResponseHandler(res, error);
    }
  }

  static async getTransferRequestById(req, res) {
    try {
      const data = await StockTransferRequestService.getTransferRequestById(req.params.id, scopeCtxFromReq(req));
      successResponseHandler(res, data, "Transfer request fetched successfully");
    } catch (error) {
      log.error("Error fetching transfer request", error);
      errorResponseHandler(res, error);
    }
  }

  static async processTransferRequest(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateProcessTransferRequest(req.body);
      const data = await StockTransferRequestService.processTransferRequest(
        req.params.id,
        req.body,
        actingUser(req),
        session
      );
      await session.commitTransaction();
      log.info("Transfer request processed");
      successResponseHandler(res, data, "Transfer request processed successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error processing transfer request", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async rejectTransferRequest(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateRejectTransferRequest(req.body);
      const data = await StockTransferRequestService.rejectTransferRequest(
        req.params.id,
        req.body,
        actingUser(req),
        session
      );
      await session.commitTransaction();
      log.info("Transfer request rejected");
      successResponseHandler(res, data, "Transfer request rejected");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error rejecting transfer request", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }
}
