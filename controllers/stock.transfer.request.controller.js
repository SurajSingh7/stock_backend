import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockTransferRequestService from "../services/stock.transfer.request.service.js";
import {
  validateCreateTransferRequest,
  validateProcessTransferRequest,
  validateRejectTransferRequest,
} from "../validators/stock.validator.js";

const log = getLogger(import.meta.url);

// req.user already carries everything the audit trail wants — role, branch,
// IP, user agent. This used to return only { id, name }, which is why the
// purchase-order, quotation, invoice and transfer-request audit rows recorded
// an empty role and no IP. `id` is kept alongside `_id` so older call sites
// that read actor.id keep working.
const actingUser = (req) => (req.user ? { ...req.user, id: req.user._id } : null);

export default class StockTransferRequestController {
  static async createTransferRequest(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateCreateTransferRequest(req.body);
      const data = await StockTransferRequestService.createTransferRequest(
        req.body,
        actingUser(req),
        session,
        req.dataAccess
      );
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

  // Bootstraps the transfer screens' branch pickers — see
  // StockTransferRequestService.getFormBranches.
  static async getFormBranches(req, res) {
    try {
      const data = await StockTransferRequestService.getFormBranches(req.dataAccess);
      successResponseHandler(res, data, "Transfer branches fetched successfully");
    } catch (error) {
      log.error("Error fetching transfer branches", error);
      errorResponseHandler(res, error);
    }
  }

  static async getBoard(req, res) {
    try {
      const data = await StockTransferRequestService.getBoard(req.query, req.dataAccess);
      successResponseHandler(res, data, "Transfer requests fetched successfully");
    } catch (error) {
      log.error("Error fetching transfer requests board", error);
      errorResponseHandler(res, error);
    }
  }

  static async getTransferRequestById(req, res) {
    try {
      const data = await StockTransferRequestService.getTransferRequestById(req.params.id, req.dataAccess);
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
        session,
        req.dataAccess
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
        session,
        req.dataAccess
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
