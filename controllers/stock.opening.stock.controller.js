import { errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import { inTransaction, handled, actingUser } from "../helpers/controller.transaction.helper.js";
import StockOpeningStockService from "../services/stock.opening.stock.service.js";
import { validateCreateOpeningStock, validateUpdateOpeningStock } from "../validators/stock.validator.js";
import { OPENING_STOCK_KIND } from "../constants/stock.enums.js";

const log = getLogger(import.meta.url);

/*
  The same handlers serve both screens — Opening Stock (STORE) and Opening
  Issued Stock (ISSUED). Each is mounted on its own path and module, and the
  kind is fixed here by the route, never read from the request.
*/
const entryHandlers = (kind) => {
  const what = kind === OPENING_STOCK_KIND.ISSUED ? "Opening issued stock entry" : "Opening stock entry";
  return {
    getFormOptions: handled(log, `${what} form options fetched successfully`, (req) =>
      StockOpeningStockService.getFormOptions(req.dataAccess)
    ),

    searchProducts: handled(log, "Products fetched successfully", (req) => {
      const ids = String(req.query.ids || "").split(",").map((s) => s.trim()).filter(Boolean);
      return StockOpeningStockService.searchProducts({ search: req.query.search || "", productIds: ids });
    }),

    list: handled(log, `${what} list fetched successfully`, async (req) => {
      const { skip, limit, page } = paginate(req.query);
      const { status, branchId, search } = req.query;
      const { data, total } = await StockOpeningStockService.list({ skip, limit, status, branchId, search, kind }, req.dataAccess);
      return paginateReturn(data, total, page, limit);
    }),

    getById: handled(log, `${what} fetched successfully`, (req) => StockOpeningStockService.getById(req.params.id, kind, req.dataAccess)),

    // Every write runs in one transaction: a posted entry and the items it
    // created commit together or not at all.
    create: inTransaction(
      log,
      `${what} created`,
      (req, session) => {
        validateCreateOpeningStock(req.body);
        return StockOpeningStockService.create(req.body, kind, actingUser(req), session, req.dataAccess);
      },
      { status: 201 }
    ),

    update: inTransaction(log, `${what} saved`, (req, session) => {
      validateUpdateOpeningStock(req.body);
      return StockOpeningStockService.update(req.params.id, req.body, kind, actingUser(req), session, req.dataAccess);
    }),

    remove: inTransaction(log, `${what} deleted`, (req, session) =>
      StockOpeningStockService.remove(req.params.id, kind, actingUser(req), session, req.dataAccess)
    ),

    post: inTransaction(log, `${what} posted to stock`, (req, session) =>
      StockOpeningStockService.post(req.params.id, kind, actingUser(req), session, req.dataAccess)
    ),
  };
};

export const StockOpeningIssuedStockController = entryHandlers(OPENING_STOCK_KIND.ISSUED);

// getFormOptions, searchProducts, list, getById, create, update, remove, post.
export default class StockOpeningStockController {
  static {
    Object.assign(StockOpeningStockController, entryHandlers(OPENING_STOCK_KIND.STORE));
  }

  // Excel is Opening Stock only — an issued entry is one person's few items.
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
