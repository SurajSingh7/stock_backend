import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockTransferRequestService from "../services/stock.transfer.request.service.js";
import { emitAlertEvent, refreshAlerts } from "../services/stock.alert.dispatcher.service.js";
import {
  validateCreateTransferRequest,
  validateSendTransferRequest,
  validateDeclineTransferRequest,
  validateReportTransferProblem,
  validateCorrectTransfer,
} from "../validators/stock.validator.js";

const log = getLogger(import.meta.url);

// req.user already carries everything the audit trail wants — role, branch,
// IP, user agent. `id` is kept alongside `_id` for older call sites.
const actingUser = (req) => (req.user ? { ...req.user, id: req.user._id } : null);

/*
  One write in one transaction. After it commits, the request's open alert
  chains are re-checked and `event` (if any) goes out — every Stock Transfer
  alert is raised on the request.
*/
const inTransaction = async (req, res, { validate, run, event, message, status = 200, label }) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    if (validate) validate(req.body);
    const request = await run(session);
    await session.commitTransaction();
    refreshAlerts(request._id);
    if (event) emitAlertEvent(event, request._id, { actor: req.user });
    successResponseHandler(res, request, message, status);
  } catch (error) {
    await session.abortTransaction();
    log.error(`Error ${label}`, error);
    errorResponseHandler(res, error);
  } finally {
    await session.endSession();
  }
};

const read = async (res, fn, message, label) => {
  try {
    successResponseHandler(res, await fn(), message);
  } catch (error) {
    log.error(`Error ${label}`, error);
    errorResponseHandler(res, error);
  }
};

const board = (side) => (req, res) =>
  read(
    res,
    async () => {
      const { rows, counts, total, page, limit } = await StockTransferRequestService.getBoard(side, req.query, req.dataAccess);
      return { data: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }, meta: { counts } };
    },
    "Stock requests fetched successfully",
    `fetching ${side} stock requests`
  );

const byId = (side) => (req, res) =>
  read(res, () => StockTransferRequestService.getById(side, req.params.id, req.dataAccess), "Stock request fetched successfully", "fetching stock request");

export default class StockTransferRequestController {
  // Bootstraps the branch pickers — see StockTransferRequestService.getFormBranches.
  static getFormBranches(req, res) {
    return read(res, () => StockTransferRequestService.getFormBranches(req.dataAccess), "Transfer branches fetched successfully", "fetching transfer branches");
  }

  static categories(req, res) {
    return read(res, () => StockTransferRequestService.categories(), "Categories fetched successfully", "fetching request categories");
  }

  // The Send page: products with their free stock, and one product's free units.
  static sendOptions(req, res) {
    return read(res, () => StockTransferRequestService.sendOptions(req.params.id, req.dataAccess), "Send options fetched successfully", "fetching send options");
  }

  static sendUnits(req, res) {
    return read(res, () => StockTransferRequestService.sendUnits(req.params.id, req.query.productDefinitionId, req.dataAccess), "Units fetched successfully", "fetching units to send");
  }

  static getMine = board("mine");
  static getToUs = board("to-us");
  static getHistory = board("history");
  static getMineById = byId("mine");
  static getToUsById = byId("to-us");
  static getHistoryById = byId("history");

  static create(req, res) {
    return inTransaction(req, res, {
      validate: validateCreateTransferRequest,
      run: (session) => StockTransferRequestService.createTransferRequest(req.body, actingUser(req), session, req.dataAccess),
      event: "STOCK_REQUESTED",
      message: "Request sent",
      status: 201,
      label: "creating stock request",
    });
  }

  static send(req, res) {
    return inTransaction(req, res, {
      validate: validateSendTransferRequest,
      run: (session) => StockTransferRequestService.send(req.params.id, req.body, actingUser(req), session, req.dataAccess),
      event: "STOCK_SENT",
      message: "Stock sent",
      label: "sending stock",
    });
  }

  static decline(req, res) {
    return inTransaction(req, res, {
      validate: validateDeclineTransferRequest,
      run: (session) => StockTransferRequestService.decline(req.params.id, req.body, actingUser(req), session, req.dataAccess),
      event: "STOCK_REQUEST_DECLINED",
      message: "Request declined",
      label: "declining stock request",
    });
  }

  static receive(req, res) {
    return inTransaction(req, res, {
      run: (session) => StockTransferRequestService.receive(req.params.id, actingUser(req), session, req.dataAccess),
      event: "STOCK_RECEIVED",
      message: "Stock received",
      label: "receiving stock",
    });
  }

  static reportProblem(req, res) {
    return inTransaction(req, res, {
      validate: validateReportTransferProblem,
      run: (session) => StockTransferRequestService.reportProblem(req.params.id, req.body, actingUser(req), session, req.dataAccess),
      event: "STOCK_PROBLEM_REPORTED",
      message: "Problem reported",
      label: "reporting a transfer problem",
    });
  }

  // Back on the way — the requester is told again, as a fresh STOCK_SENT.
  static correct(req, res) {
    return inTransaction(req, res, {
      validate: validateCorrectTransfer,
      run: (session) => StockTransferRequestService.correct(req.params.id, req.body, actingUser(req), session, req.dataAccess),
      event: "STOCK_SENT",
      message: "Corrected and sent again",
      label: "correcting transfer",
    });
  }
}
