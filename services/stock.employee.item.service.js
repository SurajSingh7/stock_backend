import mongoose from "mongoose";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import "../models/stock.branch.model.js"; // registered for the branch populates
import "../models/stock.product.definition.model.js";
import StockItemMovementService from "./stock.item.movement.service.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import StockPeopleDirectoryService from "./stock.people.directory.service.js";
import { applyDataScope, isWithinDataScope } from "../helpers/data.scope.helper.js";
import { AppError } from "../helpers/response.helper.js";
import { readReturnState, landedFields, returnStateLabel } from "../helpers/return.state.helper.js";
import {
  ITEM_STATUS,
  ITEM_APPROVAL_STATUS,
  ITEM_MOVEMENT_TYPE,
  ASSIGNEE_KIND,
} from "../constants/stock.enums.js";

/*
  Employee Items — stock with our own people (laptop, phone, test kit …).

    AVAILABLE (on the shelf) ── assign ──► ASSIGNED (EMPLOYEE)
                                              │ return
                 Working → AVAILABLE ◄────────┤
                 Faulty → FAULTY (Repair & Warranty)
                 Beyond Repair → SCRAPPED

  The person is picked from the People Directory (the people API, or typed in
  by hand there). The unit keeps a snapshot of their name and code, so the
  record still says who had it if they later leave. Stock someone already had
  before this system is entered through Opening Issued Stock instead.
*/

const MODULE_KEY = "employee-items";
const ENTITY_TYPE = "inventory-items";
const MAX_UNITS = 100;
const text = (v, max = 300) => (v === undefined || v === null ? "" : String(v).trim().slice(0, max));
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const labelOf = (item) => {
  const ids = (item.identifiers || []).map((k) => k.slice(k.indexOf(":") + 1));
  if (ids.length) return ids.join(" / ");
  const vals = Object.values(item.fieldValues || {}).filter((v) => v !== null && v !== undefined && v !== "");
  return vals.length ? vals.join(" / ") : String(item._id).slice(-6).toUpperCase();
};

const view = (it) => ({
  _id: it._id,
  label: labelOf(it),
  product: it.productDefinitionId,
  branch: it.branchId,
  quantity: it.quantity,
  status: it.status,
  condition: it.condition,
  source: it.source,
  warranty: it.warranty,
  assignedTo: it.assignedTo,
});

const POPULATE = [
  { path: "productDefinitionId", select: "name trackingMethod unit" },
  { path: "branchId", select: "name" },
];

// The employee key holdings are grouped by: employee code (the directory's
// identity for an employee), else the HRMS id older rows carry, else name.
const employeeKeyOf = (a) =>
  a?.employeeCode
    ? `code:${a.employeeCode.toUpperCase()}`
    : a?.employeeUserId
      ? `id:${a.employeeUserId}`
      : `name:${(a?.employeeName || "").toUpperCase()}`;

export default class StockEmployeeItemService {
  /* ---------------------------------------------------------------------- */
  /* Reads                                                                  */
  /* ---------------------------------------------------------------------- */

  // Shelf units to hand out — individual units only, by serial search.
  static async available({ search, branchId } = {}, dataAccess) {
    const filter = { isActive: true, status: ITEM_STATUS.AVAILABLE, approvalStatus: ITEM_APPROVAL_STATUS.APPROVED, quantity: null, lock: null };
    if (branchId && mongoose.isValidObjectId(branchId)) filter.branchId = branchId;
    if (search) filter.identifiers = { $regex: escapeRegex(String(search).trim().toUpperCase()) };
    applyDataScope(filter, dataAccess, MODULE_KEY);
    const rows = await StockInventoryItemModel.find(filter).populate(POPULATE).sort({ receivedAt: 1 }).limit(100).lean();
    return rows.map(view);
  }

  // Everyone holding something, with how many units.
  static async employees({ search } = {}, dataAccess) {
    const match = applyDataScope({ isActive: true, status: ITEM_STATUS.ASSIGNED, "assignedTo.kind": ASSIGNEE_KIND.EMPLOYEE }, dataAccess, MODULE_KEY);
    if (search) {
      const rx = { $regex: escapeRegex(String(search).trim()), $options: "i" };
      match.$or = [{ "assignedTo.employeeName": rx }, { "assignedTo.employeeCode": rx }];
    }
    const items = await StockInventoryItemModel.find(match).select("assignedTo quantity").lean();
    const byKey = new Map();
    for (const it of items) {
      const key = employeeKeyOf(it.assignedTo);
      const row = byKey.get(key) || {
        key,
        employeeUserId: it.assignedTo.employeeUserId,
        employeeName: it.assignedTo.employeeName,
        employeeCode: it.assignedTo.employeeCode,
        phone: it.assignedTo.phone || "",
        units: 0,
        lastAssignedAt: null,
      };
      row.units += 1;
      if (!row.lastAssignedAt || it.assignedTo.assignedAt > row.lastAssignedAt) row.lastAssignedAt = it.assignedTo.assignedAt;
      byKey.set(key, row);
    }
    return [...byKey.values()].sort((a, b) => new Date(b.lastAssignedAt || 0) - new Date(a.lastAssignedAt || 0));
  }

  static async employeeItems(key, dataAccess) {
    const k = String(key || "");
    const [kind, value] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
    const filter = { isActive: true, status: ITEM_STATUS.ASSIGNED, "assignedTo.kind": ASSIGNEE_KIND.EMPLOYEE };
    if (kind === "id" && mongoose.isValidObjectId(value)) filter["assignedTo.employeeUserId"] = value;
    else if (kind === "code") filter["assignedTo.employeeCode"] = { $regex: `^${escapeRegex(value)}$`, $options: "i" };
    else if (kind === "name") filter["assignedTo.employeeName"] = { $regex: `^${escapeRegex(value)}$`, $options: "i" };
    else throw new AppError("Invalid employee", 400);
    applyDataScope(filter, dataAccess, MODULE_KEY);
    const rows = await StockInventoryItemModel.find(filter).populate(POPULATE).sort({ "assignedTo.assignedAt": -1 }).lean();
    return rows.map(view);
  }

  /* ---------------------------------------------------------------------- */
  /* Assign — shelf units to one employee from the People Directory          */
  /* body: { itemIds: [...], personId, note? }                              */
  /* ---------------------------------------------------------------------- */

  static async assign(body, user, session, dataAccess) {
    const ids = [...new Set((Array.isArray(body?.itemIds) ? body.itemIds : []).map(String))];
    if (!ids.length) throw new AppError("Choose at least one unit to assign", 400);
    if (ids.length > MAX_UNITS) throw new AppError(`Invalid: at most ${MAX_UNITS} units at a time`, 400);
    if (ids.some((id) => !mongoose.isValidObjectId(id))) throw new AppError("Invalid unit selected", 400);

    if (!body?.personId) throw new AppError("Choose the employee", 400);
    const person = await StockPeopleDirectoryService.getActive(body.personId, session);
    if (person.kind !== ASSIGNEE_KIND.EMPLOYEE) throw new AppError("Only an employee can be chosen here", 400);
    const { name, employeeCode } = person;
    const note = text(body?.note, 500);

    const items = await StockInventoryItemModel.find({
      _id: { $in: ids },
      isActive: true,
      approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
      status: ITEM_STATUS.AVAILABLE,
      lock: null,
    }).session(session);
    if (items.length !== ids.length)
      throw new AppError(`${ids.length - items.length} chosen unit(s) are no longer free to assign — refresh`, 409);
    items.forEach((it) => {
      if (!isWithinDataScope(it, dataAccess, MODULE_KEY)) throw new Error("Inventory item not found");
    });

    const now = new Date();
    const assignedTo = StockPeopleDirectoryService.assigneeOf(person, { assignedAt: now, note });
    const movements = [];
    for (const it of items) {
      const before = it.toObject();
      // The status in the filter is the guard against the same unit being
      // assigned twice at once.
      const res = await StockInventoryItemModel.updateOne(
        { _id: it._id, status: before.status },
        { $set: { status: ITEM_STATUS.ASSIGNED, assignedTo } }, // condition as it was: judged when it comes back
        { session }
      );
      if (res.modifiedCount !== 1) throw new AppError(`${labelOf(before)} was just taken elsewhere — refresh`, 409);
      movements.push({
        inventoryItemId: it._id,
        productDefinitionId: it.productDefinitionId,
        type: ITEM_MOVEMENT_TYPE.ASSIGNED,
        at: now,
        quantity: it.quantity ?? null,
        fromBranchId: it.branchId,
        status: ITEM_STATUS.ASSIGNED,
        note: `Assigned to ${name}${employeeCode ? ` (${employeeCode})` : ""}${note ? ` · ${note}` : ""}`,
      });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: it._id, action: "ASSIGN_EMPLOYEE", actor: user, before, after: { ...before, status: ITEM_STATUS.ASSIGNED, assignedTo },
      });
    }
    await StockItemMovementService.record(movements, session);
    return { assigned: items.length };
  }

  /* ---------------------------------------------------------------------- */
  /* Return — back from the employee, as the store judges it               */
  /* body: { itemIds: [...], workingState, itemCondition, note? }          */
  /* (see helpers/return.state.helper.js; old condition GOOD|FAULTY works) */
  /* ---------------------------------------------------------------------- */

  static async returnItems(body, user, session, dataAccess) {
    const ids = [...new Set((Array.isArray(body?.itemIds) ? body.itemIds : []).map(String))];
    if (!ids.length) throw new AppError("Choose at least one unit that came back", 400);
    if (ids.some((id) => !mongoose.isValidObjectId(id))) throw new AppError("Invalid unit selected", 400);
    const state = readReturnState(body);

    const items = await StockInventoryItemModel.find({
      _id: { $in: ids },
      isActive: true,
      status: ITEM_STATUS.ASSIGNED,
      "assignedTo.kind": ASSIGNEE_KIND.EMPLOYEE,
    }).session(session);
    if (items.length !== ids.length) throw new AppError(`${ids.length - items.length} chosen unit(s) are not with an employee — refresh`, 409);
    const locked = items.find((it) => it.lock);
    if (locked) throw new AppError(`A chosen unit is on pending Lost entry ${locked.lock.refNumber} — reject that entry first`, 409);

    const now = new Date();
    const movements = [];
    for (const it of items) {
      if (!isWithinDataScope(it, dataAccess, MODULE_KEY)) throw new Error("Inventory item not found");
      const before = it.toObject();
      const who = `${before.assignedTo.employeeName}${before.assignedTo.employeeCode ? ` (${before.assignedTo.employeeCode})` : ""}`;
      it.set(landedFields(state, it.branchId, now, `Return from employee ${who}`));
      await it.save({ session });
      movements.push({
        inventoryItemId: it._id,
        productDefinitionId: it.productDefinitionId,
        type: ITEM_MOVEMENT_TYPE.RETURNED,
        at: now,
        quantity: it.quantity ?? null,
        toBranchId: it.branchId,
        status: it.status,
        note: `Returned by ${who} · ${returnStateLabel(state)}`,
      });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: it._id, action: "RETURN_EMPLOYEE", actor: user, before, after: it.toObject(),
      });
    }
    await StockItemMovementService.record(movements, session);
    return { returned: items.length };
  }
}
