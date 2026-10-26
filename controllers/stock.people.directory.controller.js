import { getLogger } from "../helpers/logger.helper.js";
import { handled } from "../helpers/controller.transaction.helper.js";
import StockPeopleDirectoryService from "../services/stock.people.directory.service.js";

const log = getLogger(import.meta.url);

/* People Directory — see services/stock.people.directory.service.js. */
export default class StockPeopleDirectoryController {
  static search = handled(log, "People fetched successfully", (req) =>
    StockPeopleDirectoryService.search({ q: req.query.q, kind: req.query.kind })
  );

  // Each is one document — no transaction needed.
  static select = handled(log, "Person selected", (req) => StockPeopleDirectoryService.select(req.body));
  static create = handled(log, "Person added to the directory", (req) => StockPeopleDirectoryService.createManual(req.body));
}
