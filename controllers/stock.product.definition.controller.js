import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import StockProductDefinitionService from "../services/stock.product.definition.service.js";
import {
  validateCreateProductDefinition,
  validateUpdateProductDefinition,
} from "../validators/stock.validator.js";

const log = getLogger(import.meta.url);

export default class StockProductDefinitionController {
  static async createProductDefinition(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateCreateProductDefinition(req.body);
      const data = await StockProductDefinitionService.createProductDefinition(
        req.body,
        session
      );
      await session.commitTransaction();
      log.info("Stock product definition created");
      successResponseHandler(res, data, "Product definition created successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error creating product definition", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async getAllProductDefinitions(req, res) {
    try {
      const { skip, limit, page } = paginate(req.query);
      const { search, categoryId, showInactive } = req.query;
      const { data, total } = await StockProductDefinitionService.getAllProductDefinitions({
        skip,
        limit,
        search,
        categoryId,
        showInactive: showInactive === "true",
      });
      successResponseHandler(
        res,
        paginateReturn(data, total, page, limit),
        "Product definitions fetched successfully"
      );
    } catch (error) {
      log.error("Error fetching product definitions", error);
      errorResponseHandler(res, error);
    }
  }

  static async getProductDefinitionById(req, res) {
    try {
      const data = await StockProductDefinitionService.getProductDefinitionById(req.params.id);
      successResponseHandler(res, data, "Product definition fetched successfully");
    } catch (error) {
      log.error("Error fetching product definition", error);
      errorResponseHandler(res, error);
    }
  }

  static async getProductDefinitionsByCategory(req, res) {
    try {
      const data = await StockProductDefinitionService.getProductDefinitionsByCategory(
        req.params.catId
      );
      successResponseHandler(res, data, "Product definitions fetched successfully");
    } catch (error) {
      log.error("Error fetching product definitions by category", error);
      errorResponseHandler(res, error);
    }
  }

  static async updateProductDefinition(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateUpdateProductDefinition(req.body);
      const data = await StockProductDefinitionService.updateProductDefinition(
        req.params.id,
        req.body,
        session
      );
      await session.commitTransaction();
      log.info("Stock product definition updated");
      successResponseHandler(res, data, "Product definition updated successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error updating product definition", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async softDeleteProductDefinition(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const deletedBy = req.user?._id ?? req.userId ?? null;
      const data = await StockProductDefinitionService.softDeleteProductDefinition(
        req.params.id,
        deletedBy,
        session
      );
      await session.commitTransaction();
      log.info("Stock product definition soft deleted");
      successResponseHandler(res, data, "Product definition deleted successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error deleting product definition", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async restoreProductDefinition(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockProductDefinitionService.restoreProductDefinition(
        req.params.id,
        session
      );
      await session.commitTransaction();
      log.info("Stock product definition restored");
      successResponseHandler(res, data, "Product definition restored successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error restoring product definition", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }
}
