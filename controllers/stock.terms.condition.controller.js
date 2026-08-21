import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import StockTermsConditionService from "../services/stock.terms.condition.service.js";
import {
  validateCreateTermsCondition,
  validateUpdateTermsCondition,
} from "../validators/stock.validator.js";

const log = getLogger(import.meta.url);

export default class StockTermsConditionController {
  static async createTermsCondition(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateCreateTermsCondition(req.body);
      const data = await StockTermsConditionService.createTermsCondition(req.body, req.user, session);
      await session.commitTransaction();
      log.info("Terms & Conditions created");
      successResponseHandler(res, data, "Terms & Conditions created successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error creating Terms & Conditions", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async getAllTermsConditions(req, res) {
    try {
      const { skip, limit, page } = paginate(req.query);
      const { search, status, showInactive } = req.query;
      const { data, total } = await StockTermsConditionService.getAllTermsConditions({
        skip,
        limit,
        search,
        status,
        showInactive: showInactive === "true",
      });
      successResponseHandler(
        res,
        paginateReturn(data, total, page, limit),
        "Terms & Conditions fetched successfully"
      );
    } catch (error) {
      log.error("Error fetching Terms & Conditions", error);
      errorResponseHandler(res, error);
    }
  }

  static async getTermsConditionById(req, res) {
    try {
      const data = await StockTermsConditionService.getTermsConditionById(req.params.id);
      successResponseHandler(res, data, "Terms & Conditions fetched successfully");
    } catch (error) {
      log.error("Error fetching Terms & Conditions by id", error);
      errorResponseHandler(res, error);
    }
  }

  static async updateTermsCondition(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateUpdateTermsCondition(req.body);
      const data = await StockTermsConditionService.updateTermsCondition(req.params.id, req.body, req.user, session);
      await session.commitTransaction();
      log.info("Terms & Conditions updated");
      successResponseHandler(res, data, "Terms & Conditions updated successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error updating Terms & Conditions", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async softDeleteTermsCondition(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockTermsConditionService.softDeleteTermsCondition(
        req.params.id,
        req.user,
        session
      );
      await session.commitTransaction();
      log.info("Terms & Conditions soft deleted");
      successResponseHandler(res, data, "Terms & Conditions deleted successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error deleting Terms & Conditions", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async restoreTermsCondition(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockTermsConditionService.restoreTermsCondition(req.params.id, req.user, session);
      await session.commitTransaction();
      log.info("Terms & Conditions restored");
      successResponseHandler(res, data, "Terms & Conditions restored successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error restoring Terms & Conditions", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  // Read-only lookup the PO create screen calls to show which term will be
  // auto-attached (vendor-specific match, else the Default) before submit.
  static async resolveForVendor(req, res) {
    try {
      const data = await StockTermsConditionService.resolveForVendor(req.params.vendorId);
      successResponseHandler(res, data, "Applicable Terms & Conditions resolved successfully");
    } catch (error) {
      log.error("Error resolving Terms & Conditions for vendor", error);
      errorResponseHandler(res, error);
    }
  }
}
