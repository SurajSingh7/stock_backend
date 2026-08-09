import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import StockInventoryItemService from "../services/stock.inventory.item.service.js";
import {
  validateCreateInventoryItem,
  validateBulkCreateInventoryItems,
  validateUpdateItemStatus,
} from "../validators/stock.validator.js";

const log = getLogger(import.meta.url);

export default class StockInventoryItemController {
  static async createInventoryItem(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateCreateInventoryItem(req.body);
      const receivedBy = req.user?._id ?? req.userId ?? null;
      const data = await StockInventoryItemService.createInventoryItem(
        { ...req.body, receivedBy },
        session
      );
      await session.commitTransaction();
      log.info("Stock inventory item created");
      successResponseHandler(res, data, "Inventory item created successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error creating inventory item", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async bulkCreateInventoryItems(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateBulkCreateInventoryItems(req.body);
      const receivedBy = req.user?._id ?? req.userId ?? null;
      const data = await StockInventoryItemService.bulkCreateInventoryItems(
        { ...req.body, receivedBy },
        session
      );
      await session.commitTransaction();
      log.info(`Stock inventory bulk created: ${data.created} items`);
      successResponseHandler(res, data, `${data.created} inventory items created successfully`);
    } catch (error) {
      await session.abortTransaction();
      log.error("Error bulk creating inventory items", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async getAllInventoryItems(req, res) {
    try {
      const { skip, limit, page } = paginate(req.query);
      const { productDefinitionId, categoryId, warehouseId, status, approvalStatus, search, showInactive } =
        req.query;
      const { data, total } = await StockInventoryItemService.getAllInventoryItems({
        skip,
        limit,
        productDefinitionId,
        categoryId,
        warehouseId,
        status,
        approvalStatus,
        search,
        showInactive: showInactive === "true",
      });
      successResponseHandler(
        res,
        paginateReturn(data, total, page, limit),
        "Inventory items fetched successfully"
      );
    } catch (error) {
      log.error("Error fetching inventory items", error);
      errorResponseHandler(res, error);
    }
  }

  static async getProductInventorySummary(req, res) {
    try {
      const { skip, limit, page } = paginate(req.query);
      const { search, categoryId, productDefinitionId, warehouseId, stockStatus } = req.query;
      const { data, total } = await StockInventoryItemService.getProductInventorySummary({
        skip,
        limit,
        search,
        categoryId,
        productDefinitionId,
        warehouseId,
        stockStatus,
      });
      successResponseHandler(
        res,
        paginateReturn(data, total, page, limit),
        "Product inventory summary fetched successfully"
      );
    } catch (error) {
      log.error("Error fetching product inventory summary", error);
      errorResponseHandler(res, error);
    }
  }

  static async getReceivingHistory(req, res) {
    try {
      const { warehouseId } = req.query;
      const data = await StockInventoryItemService.getReceivingHistory(req.params.defId, { warehouseId });
      successResponseHandler(res, data, "Receiving history fetched successfully");
    } catch (error) {
      log.error("Error fetching receiving history", error);
      errorResponseHandler(res, error);
    }
  }

  static async getInventoryItemById(req, res) {
    try {
      const data = await StockInventoryItemService.getInventoryItemById(req.params.id);
      successResponseHandler(res, data, "Inventory item fetched successfully");
    } catch (error) {
      log.error("Error fetching inventory item", error);
      errorResponseHandler(res, error);
    }
  }

  static async getStockSummary(req, res) {
    try {
      const data = await StockInventoryItemService.getStockSummary(req.params.defId);
      successResponseHandler(res, data, "Stock summary fetched successfully");
    } catch (error) {
      log.error("Error fetching stock summary", error);
      errorResponseHandler(res, error);
    }
  }

  static async updateInventoryItem(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockInventoryItemService.updateInventoryItem(
        req.params.id,
        req.body,
        session
      );
      await session.commitTransaction();
      log.info("Stock inventory item updated");
      successResponseHandler(res, data, "Inventory item updated successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error updating inventory item", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async updateItemStatus(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateUpdateItemStatus(req.body);
      const data = await StockInventoryItemService.updateItemStatus(
        req.params.id,
        req.body.status,
        session
      );
      await session.commitTransaction();
      log.info("Stock inventory item status updated");
      successResponseHandler(res, data, "Item status updated successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error updating inventory item status", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async softDeleteInventoryItem(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const deletedBy = req.user?._id ?? req.userId ?? null;
      const data = await StockInventoryItemService.softDeleteInventoryItem(
        req.params.id,
        deletedBy,
        session
      );
      await session.commitTransaction();
      log.info("Stock inventory item soft deleted");
      successResponseHandler(res, data, "Inventory item deleted successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error deleting inventory item", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async restoreInventoryItem(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockInventoryItemService.restoreInventoryItem(req.params.id, session);
      await session.commitTransaction();
      log.info("Stock inventory item restored");
      successResponseHandler(res, data, "Inventory item restored successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error restoring inventory item", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }
}
