import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import StockInventoryItemService from "../services/stock.inventory.item.service.js";
import StockProductStockService from "../services/stock.product.stock.service.js";

const log = getLogger(import.meta.url);

/*
  The Stock pages, read-only — each behind its own module:
    Available Product  (available-products)  getProductStock, getProductStockHistory
    Available Item     (available-items)     getInventoryCards, getReceivingHistory, getItemTimeline
    Product Summary    (product-summary)     getStockSummaryReport
  Stock is never edited here: it enters through an invoice or Opening Stock
  and moves through requests, repairs and transfers.
*/
export default class StockInventoryItemController {
  // Available Item: the units in the store right now.
  static async getInventoryCards(req, res) {
    try {
      const { skip, limit, page } = paginate(req.query);
      const { search, categoryId, productDefinitionId, branchId, status, sourceType, condition, vendorId, warranty, from, to } = req.query;
      const { data, total, listFields } = await StockInventoryItemService.getInventoryCards(
        { skip, limit, search, categoryId, productDefinitionId, branchId, status, sourceType, condition, vendorId, warranty, from, to },
        req.dataAccess
      );
      successResponseHandler(res, { ...paginateReturn(data, total, page, limit), meta: { listFields } }, "Inventory cards fetched successfully");
    } catch (error) {
      log.error("Error fetching inventory cards", error);
      errorResponseHandler(res, error);
    }
  }

  // Available Item → a unit's history.
  static async getItemTimeline(req, res) {
    try {
      const data = await StockInventoryItemService.getItemTimeline(req.params.id, req.dataAccess);
      successResponseHandler(res, data, "Item timeline fetched successfully");
    } catch (error) {
      log.error("Error fetching item timeline", error);
      errorResponseHandler(res, error);
    }
  }

  // Available Item → a batch product's receipts.
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

  // Available Product: each product against its alert threshold, branch by branch.
  static async getProductStock(req, res) {
    try {
      const data = await StockProductStockService.list(req.query, req.dataAccess);
      successResponseHandler(res, data, "Product stock fetched successfully");
    } catch (error) {
      log.error("Error fetching product stock", error);
      errorResponseHandler(res, error);
    }
  }

  // Available Product → History: what came in, and where it is now.
  static async getProductStockHistory(req, res) {
    try {
      const data = await StockProductStockService.history(req.params.defId, { branchId: req.query.branchId }, req.dataAccess);
      successResponseHandler(res, data, "Product history fetched successfully");
    } catch (error) {
      log.error("Error fetching product history", error);
      errorResponseHandler(res, error);
    }
  }

  // Product Summary: everything received, and where it all is now.
  static async getStockSummaryReport(req, res) {
    try {
      const data = await StockProductStockService.summary(req.query, req.dataAccess);
      successResponseHandler(res, data, "Stock summary fetched successfully");
    } catch (error) {
      log.error("Error fetching stock summary", error);
      errorResponseHandler(res, error);
    }
  }
}
