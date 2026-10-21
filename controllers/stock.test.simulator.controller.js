import { getLogger } from "../helpers/logger.helper.js";
import { inTransaction, handled, actingUser } from "../helpers/controller.transaction.helper.js";
import StockTestSimulatorService, { TEST_SERVICE_TYPES } from "../services/stock.test.simulator.service.js";
import StockItemRequestService from "../services/stock.item.request.service.js";

const log = getLogger(import.meta.url);

/* 🧪 TEST ONLY — Request Simulator. See services/stock.test.simulator.service.js. */
export default class StockTestSimulatorController {
  static meta = handled(log, "Simulator options fetched successfully", async () => ({
    serviceTypes: TEST_SERVICE_TYPES,
    branches: await StockItemRequestService.catalogBranches(),
    categories: await StockItemRequestService.catalogCategories(),
    // Shown as a note: leaves that cannot be requested by quantity yet.
    mixedCategories: await StockItemRequestService.catalogMixedCategories(),
  }));

  static listSubscribers = handled(log, "Test subscribers fetched successfully", (req) =>
    StockTestSimulatorService.listSubscribers({ search: req.query.search })
  );

  static createSubscriber = handled(log, "Test subscriber added", (req) => StockTestSimulatorService.createSubscriber(req.body));

  static sendRequest = inTransaction(
    log,
    "Request sent",
    (req, session) => StockTestSimulatorService.sendRequest(req.params.subscriberId, req.body, actingUser(req), session),
    { status: 201 }
  );

  static resendRequest = inTransaction(log, "Request sent again", (req, session) =>
    StockTestSimulatorService.resendRequest(req.params.requestId, req.body, actingUser(req), session)
  );

  static getRequest = handled(log, "Request fetched successfully", (req) => StockTestSimulatorService.getRequest(req.params.requestId));
}
