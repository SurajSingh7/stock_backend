import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import StockInventoryItemService from "../services/stock.inventory.item.service.js";
import StockProductStockService from "../services/stock.product.stock.service.js";
import {
  validateUpdateItemStatus,
} from "../validators/stock.validator.js";

const log = getLogger(import.meta.url);

export default class StockInventoryItemController {
  static async getAllInventoryItems(req, res) {
    try {
      const { skip, limit, page } = paginate(req.query);
      const { productDefinitionId, categoryId, branchId, status, approvalStatus, search, showInactive, sourceType, condition } =
        req.query;
      const { data, total } = await StockInventoryItemService.getAllInventoryItems(
        {
          skip,
          limit,
          productDefinitionId,
          categoryId,
          branchId,
          status,
          approvalStatus,
          search,
          showInactive: showInactive === "true",
          sourceType,
          condition,
        },
        req.dataAccess
      );
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

  static async getInventoryCards(req, res) {
    try {
      const { skip, limit, page } = paginate(req.query);
      const { search, categoryId, productDefinitionId, branchId, status, sourceType, condition, vendorId, warranty, from, to } = req.query;
      const { data, total, listFields } = await StockInventoryItemService.getInventoryCards(
        {
          skip,
          limit,
          search,
          categoryId,
          productDefinitionId,
          branchId,
          status,
          sourceType,
          condition,
          vendorId,
          warranty,
          from,
          to,
        },
        req.dataAccess
      );
      successResponseHandler(
        res,
        { ...paginateReturn(data, total, page, limit), meta: { listFields } },
        "Inventory cards fetched successfully"
      );
    } catch (error) {
      log.error("Error fetching inventory cards", error);
      errorResponseHandler(res, error);
    }
  }

  static async getItemTimeline(req, res) {
    try {
      const data = await StockInventoryItemService.getItemTimeline(req.params.id, req.dataAccess);
      successResponseHandler(res, data, "Item timeline fetched successfully");
    } catch (error) {
      log.error("Error fetching item timeline", error);
      errorResponseHandler(res, error);
    }
  }

  static async getProductInventorySummary(req, res) {
    try {
      const { skip, limit, page } = paginate(req.query);
      const { search, categoryId, productDefinitionId, branchId, stockStatus } = req.query;
      const { data, total } = await StockInventoryItemService.getProductInventorySummary(
        {
          skip,
          limit,
          search,
          categoryId,
          productDefinitionId,
          branchId,
          stockStatus,
        },
        req.dataAccess
      );
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

  // Product Inventory: each product against its alert threshold, branch by branch.
  static async getProductStock(req, res) {
    try {
      const data = await StockProductStockService.list(req.query, req.dataAccess);
      successResponseHandler(res, data, "Product stock fetched successfully");
    } catch (error) {
      log.error("Error fetching product stock", error);
      errorResponseHandler(res, error);
    }
  }

  // Stock Summary: everything received, and where it all is now.
  static async getStockSummaryReport(req, res) {
    try {
      const data = await StockProductStockService.summary(req.query, req.dataAccess);
      successResponseHandler(res, data, "Stock summary fetched successfully");
    } catch (error) {
      log.error("Error fetching stock summary", error);
      errorResponseHandler(res, error);
    }
  }

  // Product Inventory → History: what came in, and where it is now.
  static async getProductStockHistory(req, res) {
    try {
      const data = await StockProductStockService.history(req.params.defId, { branchId: req.query.branchId }, req.dataAccess);
      successResponseHandler(res, data, "Product history fetched successfully");
    } catch (error) {
      log.error("Error fetching product history", error);
      errorResponseHandler(res, error);
    }
  }

  static async getReceivingHistory(req, res) {
    try {
      const { branchId, status } = req.query;
      const data = await StockInventoryItemService.getReceivingHistory(req.params.defId, { branchId, status }, req.dataAccess);
      successResponseHandler(res, data, "Receiving history fetched successfully");
    } catch (error) {
      log.error("Error fetching receiving history", error);
      errorResponseHandler(res, error);
    }
  }

  static async getInventoryItemById(req, res) {
    try {
      const data = await StockInventoryItemService.getInventoryItemById(req.params.id, req.dataAccess);
      successResponseHandler(res, data, "Inventory item fetched successfully");
    } catch (error) {
      log.error("Error fetching inventory item", error);
      errorResponseHandler(res, error);
    }
  }

  static async getStockSummary(req, res) {
    try {
      const data = await StockInventoryItemService.getStockSummary(req.params.defId, req.dataAccess);
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
        req.user,
        session,
        req.dataAccess
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
        req.user,
        session,
        req.dataAccess
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
      const data = await StockInventoryItemService.softDeleteInventoryItem(
        req.params.id,
        req.user,
        session,
        req.dataAccess
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
      const data = await StockInventoryItemService.restoreInventoryItem(req.params.id, req.user, session, req.dataAccess);
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
