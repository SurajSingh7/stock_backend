import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import StockBranchService from "../services/stock.branch.service.js";
import { validateCreateBranch, validateUpdateBranch } from "../validators/stock.validator.js";
import { scopeCtxFromReq } from "../helpers/branch.scope.helper.js";

const log = getLogger(import.meta.url);

export default class StockBranchController {
  static async createBranch(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateCreateBranch(req.body);
      const data = await StockBranchService.createBranch(req.body, req.user, session);
      await session.commitTransaction();
      log.info("Branch created");
      successResponseHandler(res, data, "Branch created successfully", 201);
    } catch (error) {
      await session.abortTransaction();
      log.error("Error creating branch", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async getAllBranches(req, res) {
    try {
      const { skip, limit, page } = paginate(req.query);
      const { search, showInactive } = req.query;
      const { data, total } = await StockBranchService.getAllBranches(
        {
          skip,
          limit,
          search,
          showInactive: showInactive === "true",
        },
        scopeCtxFromReq(req)
      );
      successResponseHandler(res, paginateReturn(data, total, page, limit), "Branches fetched successfully");
    } catch (error) {
      log.error("Error fetching branches", error);
      errorResponseHandler(res, error);
    }
  }

  static async getActiveBranches(req, res) {
    try {
      const data = await StockBranchService.getActiveBranches();
      successResponseHandler(res, data, "Active branches fetched successfully");
    } catch (error) {
      log.error("Error fetching active branches", error);
      errorResponseHandler(res, error);
    }
  }

  static async getBranchById(req, res) {
    try {
      const data = await StockBranchService.getBranchById(req.params.id, scopeCtxFromReq(req));
      successResponseHandler(res, data, "Branch fetched successfully");
    } catch (error) {
      log.error("Error fetching branch", error);
      errorResponseHandler(res, error);
    }
  }

  static async updateBranch(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateUpdateBranch(req.body);
      const data = await StockBranchService.updateBranch(req.params.id, req.body, req.user, session);
      await session.commitTransaction();
      log.info("Branch updated");
      successResponseHandler(res, data, "Branch updated successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error updating branch", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async softDeleteBranch(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockBranchService.softDeleteBranch(req.params.id, req.user, session);
      await session.commitTransaction();
      log.info("Branch soft deleted");
      successResponseHandler(res, data, "Branch deleted successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error deleting branch", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async restoreBranch(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockBranchService.restoreBranch(req.params.id, req.user, session);
      await session.commitTransaction();
      log.info("Branch restored");
      successResponseHandler(res, data, "Branch restored successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error restoring branch", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }
}
