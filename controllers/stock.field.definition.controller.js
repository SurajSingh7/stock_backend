import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import StockFieldDefinitionService from "../services/stock.field.definition.service.js";
import {
  validateCreateFieldDefinition,
  validateUpdateFieldDefinition,
} from "../validators/stock.validator.js";

const log = getLogger(import.meta.url);

export default class StockFieldDefinitionController {
  static async createFieldDefinition(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateCreateFieldDefinition(req.body);
      const data = await StockFieldDefinitionService.createFieldDefinition(req.body, req.user, session);
      await session.commitTransaction();
      log.info("Stock field definition created");
      successResponseHandler(res, data, "Field definition created successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error creating field definition", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async getAllFieldDefinitions(req, res) {
    try {
      const { skip, limit, page } = paginate(req.query);
      const { search, inputType, showInactive } = req.query;
      const { data, total } = await StockFieldDefinitionService.getAllFieldDefinitions({
        skip,
        limit,
        search,
        inputType,
        showInactive: showInactive === "true",
      });
      successResponseHandler(
        res,
        paginateReturn(data, total, page, limit),
        "Field definitions fetched successfully"
      );
    } catch (error) {
      log.error("Error fetching field definitions", error);
      errorResponseHandler(res, error);
    }
  }

  static async getFieldDefinitionById(req, res) {
    try {
      const data = await StockFieldDefinitionService.getFieldDefinitionById(req.params.id);
      successResponseHandler(res, data, "Field definition fetched successfully");
    } catch (error) {
      log.error("Error fetching field definition", error);
      errorResponseHandler(res, error);
    }
  }

  static async updateFieldDefinition(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateUpdateFieldDefinition(req.body);
      const data = await StockFieldDefinitionService.updateFieldDefinition(
        req.params.id,
        req.body,
        req.user,
        session
      );
      await session.commitTransaction();
      log.info("Stock field definition updated");
      successResponseHandler(res, data, "Field definition updated successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error updating field definition", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async softDeleteFieldDefinition(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockFieldDefinitionService.softDeleteFieldDefinition(
        req.params.id,
        req.user,
        session
      );
      await session.commitTransaction();
      log.info("Stock field definition soft deleted");
      successResponseHandler(res, data, "Field definition deleted successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error deleting field definition", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async restoreFieldDefinition(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockFieldDefinitionService.restoreFieldDefinition(
        req.params.id,
        req.user,
        session
      );
      await session.commitTransaction();
      log.info("Stock field definition restored");
      successResponseHandler(res, data, "Field definition restored successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error restoring field definition", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }
}
