import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import StockCategoryService from "../services/stock.category.service.js";
import {
  validateCreateCategory,
  validateUpdateCategory,
  validateMoveCategory,
  validateReorderCategories,
} from "../validators/stock.validator.js";

const log = getLogger(import.meta.url);

export default class StockCategoryController {
  static async createCategory(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateCreateCategory(req.body);
      const data = await StockCategoryService.createCategory(req.body, session);
      await session.commitTransaction();
      log.info("Stock category created");
      successResponseHandler(res, data, "Category created successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error creating stock category", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async getCategoryTree(req, res) {
    try {
      const showInactive = req.query.showInactive === "true";
      const data = await StockCategoryService.getCategoryTree(showInactive);
      successResponseHandler(res, data, "Category tree fetched successfully");
    } catch (error) {
      log.error("Error fetching category tree", error);
      errorResponseHandler(res, error);
    }
  }

  static async getCategoriesFlat(req, res) {
    try {
      const { skip, limit, page } = paginate(req.query);
      const { search, type, showInactive } = req.query;
      const { data, total } = await StockCategoryService.getCategoriesFlat({
        skip,
        limit,
        search,
        type,
        showInactive: showInactive === "true",
      });
      successResponseHandler(
        res,
        paginateReturn(data, total, page, limit),
        "Categories fetched successfully"
      );
    } catch (error) {
      log.error("Error fetching flat categories", error);
      errorResponseHandler(res, error);
    }
  }

  static async getCategoryById(req, res) {
    try {
      const data = await StockCategoryService.getCategoryById(req.params.id);
      successResponseHandler(res, data, "Category fetched successfully");
    } catch (error) {
      log.error("Error fetching category by id", error);
      errorResponseHandler(res, error);
    }
  }

  static async updateCategory(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateUpdateCategory(req.body);
      const data = await StockCategoryService.updateCategory(req.params.id, req.body, session);
      await session.commitTransaction();
      log.info("Stock category updated");
      successResponseHandler(res, data, "Category updated successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error updating stock category", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async moveCategory(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateMoveCategory(req.body);
      const data = await StockCategoryService.moveCategory(
        req.params.id,
        req.body.newParentId,
        session
      );
      await session.commitTransaction();
      log.info("Stock category moved");
      successResponseHandler(res, data, "Category moved successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error moving stock category", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async softDeleteCategory(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const deletedBy = req.user?._id ?? req.userId ?? null;
      const data = await StockCategoryService.softDeleteCategory(
        req.params.id,
        deletedBy,
        session
      );
      await session.commitTransaction();
      log.info("Stock category soft deleted");
      successResponseHandler(res, data, "Category deleted successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error deleting stock category", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async restoreCategory(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockCategoryService.restoreCategory(req.params.id, session);
      await session.commitTransaction();
      log.info("Stock category restored");
      successResponseHandler(res, data, "Category restored successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error restoring stock category", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async reorderCategories(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateReorderCategories(req.body);
      await StockCategoryService.reorderCategories(req.body.siblings, session);
      await session.commitTransaction();
      log.info("Stock categories reordered");
      successResponseHandler(res, null, "Categories reordered successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error reordering stock categories", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }
}
