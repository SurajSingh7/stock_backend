import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import StockWarehouseService from "../services/stock.warehouse.service.js";
import { validateCreateWarehouse, validateUpdateWarehouse } from "../validators/stock.validator.js";
import { scopeCtxFromReq } from "../helpers/branch.scope.helper.js";

const log = getLogger(import.meta.url);

export default class StockWarehouseController {
  static async createWarehouse(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateCreateWarehouse(req.body);
      const data = await StockWarehouseService.createWarehouse(req.body, req.user, session);
      await session.commitTransaction();
      log.info("Warehouse created");
      successResponseHandler(res, data, "Warehouse created successfully", 201);
    } catch (error) {
      await session.abortTransaction();
      log.error("Error creating warehouse", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async getAllWarehouses(req, res) {
    try {
      const { skip, limit, page } = paginate(req.query);
      const { search, showInactive } = req.query;
      const { data, total } = await StockWarehouseService.getAllWarehouses(
        {
          skip,
          limit,
          search,
          showInactive: showInactive === "true",
        },
        scopeCtxFromReq(req)
      );
      successResponseHandler(res, paginateReturn(data, total, page, limit), "Warehouses fetched successfully");
    } catch (error) {
      log.error("Error fetching warehouses", error);
      errorResponseHandler(res, error);
    }
  }

  static async getActiveWarehouses(req, res) {
    try {
      const data = await StockWarehouseService.getActiveWarehouses();
      successResponseHandler(res, data, "Active warehouses fetched successfully");
    } catch (error) {
      log.error("Error fetching active warehouses", error);
      errorResponseHandler(res, error);
    }
  }

  static async getWarehouseById(req, res) {
    try {
      const data = await StockWarehouseService.getWarehouseById(req.params.id, scopeCtxFromReq(req));
      successResponseHandler(res, data, "Warehouse fetched successfully");
    } catch (error) {
      log.error("Error fetching warehouse", error);
      errorResponseHandler(res, error);
    }
  }

  static async updateWarehouse(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateUpdateWarehouse(req.body);
      const data = await StockWarehouseService.updateWarehouse(req.params.id, req.body, req.user, session);
      await session.commitTransaction();
      log.info("Warehouse updated");
      successResponseHandler(res, data, "Warehouse updated successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error updating warehouse", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async softDeleteWarehouse(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockWarehouseService.softDeleteWarehouse(req.params.id, req.user, session);
      await session.commitTransaction();
      log.info("Warehouse soft deleted");
      successResponseHandler(res, data, "Warehouse deleted successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error deleting warehouse", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async restoreWarehouse(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockWarehouseService.restoreWarehouse(req.params.id, req.user, session);
      await session.commitTransaction();
      log.info("Warehouse restored");
      successResponseHandler(res, data, "Warehouse restored successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error restoring warehouse", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }
}
