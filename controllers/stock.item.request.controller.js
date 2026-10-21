import { getLogger } from "../helpers/logger.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import { inTransaction, handled, actingUser } from "../helpers/controller.transaction.helper.js";
import StockItemRequestService from "../services/stock.item.request.service.js";
import { ITEM_REQUEST_CHANNEL } from "../constants/stock.enums.js";

const log = getLogger(import.meta.url);

/* Store side — the Item Requests screens of this app. */
export default class StockItemRequestController {
  static list = handled(log, "Item requests fetched successfully", async (req) => {
    const { page, limit } = paginate(req.query);
    const { data, total } = await StockItemRequestService.list(req.query, req.dataAccess);
    return paginateReturn(data, total, page, limit);
  });

  static statusCounts = handled(log, "Item request counts fetched successfully", (req) =>
    StockItemRequestService.statusCounts(req.query, req.dataAccess)
  );

  static getById = handled(log, "Item request fetched successfully", (req) =>
    StockItemRequestService.getById(req.params.id, req.dataAccess)
  );

  static availableUnits = handled(log, "Available units fetched successfully", (req) =>
    StockItemRequestService.availableUnits(req.params.id, { search: req.query.search, productId: req.query.productId }, req.dataAccess)
  );

  static issue = inTransaction(log, "Items issued", (req, session) =>
    StockItemRequestService.issue(req.params.id, req.body, actingUser(req), session, req.dataAccess)
  );

  static shortClose = inTransaction(log, "Item request short-closed", (req, session) =>
    StockItemRequestService.shortClose(req.params.id, req.body?.reason, actingUser(req), session, req.dataAccess)
  );

  static reject = inTransaction(log, "Item request rejected", (req, session) =>
    StockItemRequestService.reject(req.params.id, req.body?.reason, actingUser(req), session, req.dataAccess)
  );

  static subscribersWithItems = handled(log, "Subscribers fetched successfully", (req) =>
    StockItemRequestService.subscribersWithItems({ search: req.query.search }, req.dataAccess)
  );

  static subscriberItems = handled(log, "Subscriber items fetched successfully", (req) =>
    StockItemRequestService.subscriberItems(req.params.subscriberId, req.dataAccess)
  );
}

/*
  Requester side over the external API — the NOC / broadband website calls
  these server-to-server with its API key. Everything is channel EXTERNAL_API,
  so it only ever sees and edits its own requests.
*/
const EXTERNAL = ITEM_REQUEST_CHANNEL.EXTERNAL_API;

export class StockExternalItemRequestController {
  static branches = handled(log, "Branches fetched successfully", () => StockItemRequestService.catalogBranches());
  static categories = handled(log, "Categories fetched successfully", () => StockItemRequestService.catalogCategories());

  static create = inTransaction(
    log,
    "Item request created",
    (req, session) => StockItemRequestService.createRequest(req.body, EXTERNAL, session),
    { status: 201 }
  );

  static resend = inTransaction(log, "Item request sent again", (req, session) =>
    StockItemRequestService.resendRequest(req.params.id, req.body, EXTERNAL, session)
  );

  static list = handled(log, "Item requests fetched successfully", (req) =>
    StockItemRequestService.listForRequester({ channel: EXTERNAL, orderId: req.query.orderId, status: req.query.status })
  );

  static getById = handled(log, "Item request fetched successfully", (req) =>
    StockItemRequestService.getForRequester(req.params.id, EXTERNAL)
  );
}
