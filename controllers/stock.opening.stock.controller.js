import { errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import { inTransaction, handled, actingUser } from "../helpers/controller.transaction.helper.js";
import StockOpeningStockService from "../services/stock.opening.stock.service.js";
import { validateCreateOpeningStock, validateUpdateOpeningStock } from "../validators/stock.validator.js";

const log = getLogger(import.meta.url);

export default class StockOpeningStockController {
  static getFormOptions = handled(log, "Opening stock form options fetched successfully", (req) =>
    StockOpeningStockService.getFormOptions(req.dataAccess)
  );

  static searchProducts = handled(log, "Products fetched successfully", (req) => {
    const ids = String(req.query.ids || "").split(",").map((s) => s.trim()).filter(Boolean);
    return StockOpeningStockService.searchProducts({ search: req.query.search || "", productIds: ids });
  });

  static list = handled(log, "Opening stock entries fetched successfully", async (req) => {
    const { skip, limit, page } = paginate(req.query);
    const { status, branchId, search } = req.query;
    const { data, total } = await StockOpeningStockService.list({ skip, limit, status, branchId, search }, req.dataAccess);
    return paginateReturn(data, total, page, limit);
  });

  static getById = handled(log, "Opening stock entry fetched successfully", (req) =>
    StockOpeningStockService.getById(req.params.id, req.dataAccess)
  );

  // Every write runs in one transaction: a posted entry and the items it
  // created commit together or not at all.
  static create = inTransaction(
    log,
    "Opening stock entry created",
    (req, session) => {
      validateCreateOpeningStock(req.body);
      return StockOpeningStockService.create(req.body, actingUser(req), session, req.dataAccess);
    },
    { status: 201 }
  );

  static update = inTransaction(log, "Opening stock entry saved", (req, session) => {
    validateUpdateOpeningStock(req.body);
    return StockOpeningStockService.update(req.params.id, req.body, actingUser(req), session, req.dataAccess);
  });

  static remove = inTransaction(log, "Opening stock entry deleted", (req, session) =>
    StockOpeningStockService.remove(req.params.id, actingUser(req), session, req.dataAccess)
  );

  static post = inTransaction(log, "Opening stock entry posted to stock", (req, session) =>
    StockOpeningStockService.post(req.params.id, actingUser(req), session, req.dataAccess)
  );

  static async downloadTemplate(req, res) {
    try {
      const { buffer, filename } = await StockOpeningStockService.buildTemplate(req.params.productId);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(buffer);
    } catch (error) {
      log.error("Error building opening stock template", error);
      errorResponseHandler(res, error);
    }
  }

  static parseUpload = handled(log, "File read successfully", (req) =>
    StockOpeningStockService.parseUpload(req.params.productId, req.file)
  );
}

