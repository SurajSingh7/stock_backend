import { getLogger } from "../helpers/logger.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import { inTransaction, handled, actingUser } from "../helpers/controller.transaction.helper.js";
import StockRepairService from "../services/stock.repair.service.js";

const log = getLogger(import.meta.url);

/* Repair & Warranty — see services/stock.repair.service.js for the flow. */
const step = (label, fn) =>
  inTransaction(log, label, (req, session) => fn(req.params.id, req.body, actingUser(req), session, req.dataAccess));

export default class StockRepairController {
  static list = handled(log, "Repair list fetched successfully", async (req) => {
    const { page, limit } = paginate(req.query);
    const { data, total } = await StockRepairService.list(req.query, req.dataAccess);
    return paginateReturn(data, total, page, limit);
  });

  static counts = handled(log, "Repair counts fetched successfully", (req) => StockRepairService.counts(req.query, req.dataAccess));
  static vendors = handled(log, "Vendors fetched successfully", () => StockRepairService.vendorOptions());

  static reportFaulty = step("Unit reported faulty", (...a) => StockRepairService.reportFaulty(...a));
  static sendForRepair = step("Sent for repair", (...a) => StockRepairService.sendForRepair(...a));
  static repairResult = step("Repair result saved", (...a) => StockRepairService.repairResult(...a));
  static sendClaim = step("Warranty claim sent", (...a) => StockRepairService.sendClaim(...a));
  static claimOutcome = step("Warranty claim closed", (...a) => StockRepairService.claimOutcome(...a));
  static markOk = step("Unit marked working", (...a) => StockRepairService.markOk(...a));
  static scrap = step("Unit scrapped", (...a) => StockRepairService.scrap(...a));
}
