import { getLogger } from "../helpers/logger.helper.js";
import { handled } from "../helpers/controller.transaction.helper.js";
import StockInventoryReportService from "../services/stock.inventory.report.service.js";

const log = getLogger(import.meta.url);

/* Stock Reports — see services/stock.inventory.report.service.js. */
export default class StockInventoryReportController {
  static position = handled(log, "Stock position fetched successfully", (req) => StockInventoryReportService.position(req.query, req.dataAccess));
  static value = handled(log, "Stock value fetched successfully", (req) => StockInventoryReportService.value(req.query, req.dataAccess));
  static warranty = handled(log, "Warranty report fetched successfully", (req) => StockInventoryReportService.warranty(req.query, req.dataAccess));
  static subscribers = handled(log, "Subscriber holdings fetched successfully", (req) => StockInventoryReportService.subscribers(req.query, req.dataAccess));
  static repairs = handled(log, "Repair ageing fetched successfully", (req) => StockInventoryReportService.repairs(req.query, req.dataAccess));
}
