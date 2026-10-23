import { getLogger } from "../helpers/logger.helper.js";
import { inTransaction, handled, actingUser } from "../helpers/controller.transaction.helper.js";
import StockEmployeeItemService from "../services/stock.employee.item.service.js";

const log = getLogger(import.meta.url);

/* Employee Items — see services/stock.employee.item.service.js. */
export default class StockEmployeeItemController {
  static pending = handled(log, "Pending assignments fetched successfully", (req) => StockEmployeeItemService.pending(req.query, req.dataAccess));
  static available = handled(log, "Available units fetched successfully", (req) => StockEmployeeItemService.available(req.query, req.dataAccess));
  static employees = handled(log, "Employees fetched successfully", (req) => StockEmployeeItemService.employees(req.query, req.dataAccess));
  static employeeItems = handled(log, "Employee items fetched successfully", (req) => StockEmployeeItemService.employeeItems(req.query.key, req.dataAccess));

  static assign = inTransaction(log, "Assigned to employee", (req, session) =>
    StockEmployeeItemService.assign(req.body, actingUser(req), session, req.dataAccess)
  );

  static returnItems = inTransaction(log, "Received back from employee", (req, session) =>
    StockEmployeeItemService.returnItems(req.body, actingUser(req), session, req.dataAccess)
  );
}
