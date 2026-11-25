import { getLogger } from "../helpers/logger.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import { inTransaction, handled, actingUser } from "../helpers/controller.transaction.helper.js";
import StockLostEntryService from "../services/stock.lost.entry.service.js";

const log = getLogger(import.meta.url);

/*
  Lost Items and Dead Items — one service (services/stock.lost.entry.service.js),
  two families. Each family gets the same set of handlers; the routes pick
  the family and its modules.
*/
const handlersFor = (family) => {
  const listFor = (side) =>
    handled(log, "Entries fetched successfully", async (req) => {
      const { page, limit } = paginate(req.query);
      const { data, total, counts } = await StockLostEntryService.list(req.query, req.dataAccess, family, side);
      return { ...paginateReturn(data, total, page, limit), meta: { counts } };
    });
  // The family decides which types its pickers may ask for.
  const withType = (req) => ({ ...req.query, type: family === "dead" ? "DEAD" : req.query.type === "FOUND" ? "FOUND" : "LOST" });
  return {
    list: listFor("items"),
    approvalList: listFor("approval"),
    getById: handled(log, "Entry fetched successfully", (req) => StockLostEntryService.getById(req.params.id, req.dataAccess, family, "items")),
    approvalGetById: handled(log, "Entry fetched successfully", (req) => StockLostEntryService.getById(req.params.id, req.dataAccess, family, "approval")),
    unitOptions: handled(log, "Units fetched successfully", (req) => StockLostEntryService.unitOptions(withType(req), req.dataAccess)),
    batchSources: handled(log, "Stock fetched successfully", (req) => StockLostEntryService.batchSources(withType(req), req.dataAccess)),
    create: inTransaction(log, "Entry sent for approval", (req, session) => StockLostEntryService.create(req.body, actingUser(req), session, req.dataAccess, family), { status: 201 }),
    update: inTransaction(log, "Entry sent for approval again", (req, session) => StockLostEntryService.update(req.params.id, req.body, actingUser(req), session, req.dataAccess, family)),
    approve: inTransaction(log, "Entry approved", (req, session) => StockLostEntryService.approve(req.params.id, req.body, actingUser(req), session, req.dataAccess, family)),
    reject: inTransaction(log, "Entry rejected", (req, session) => StockLostEntryService.reject(req.params.id, req.body, actingUser(req), session, req.dataAccess, family)),
  };
};

export const LostEntryController = handlersFor("lost");
export const DeadEntryController = handlersFor("dead");
