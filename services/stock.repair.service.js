import mongoose from "mongoose";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockVendorModel from "../models/stock.vendor.model.js";
import "../models/stock.branch.model.js"; // registered for the branch populate in list()
import StockInventoryItemService from "./stock.inventory.item.service.js";
import StockItemIdentityService from "./stock.item.identity.service.js";
import StockItemMovementService from "./stock.item.movement.service.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import { applyDataScope, isWithinDataScope } from "../helpers/data.scope.helper.js";
import { paginate } from "../helpers/pagination.helper.js";
import { AppError } from "../helpers/response.helper.js";
import { warrantyEndDate, isValidWarrantyMonths } from "../helpers/stock.warranty.helper.js";
import { readReturnState, returnStateLabel } from "../helpers/return.state.helper.js";
import {
  ITEM_STATUS,
  ITEM_APPROVAL_STATUS,
  ITEM_CONDITION,
  ITEM_SOURCE,
  ITEM_MOVEMENT_TYPE,
  ITEM_MOVEMENT_REF,
  REPAIR_TYPE,
  REPAIR_TYPE_ARRAY,
  REPAIR_RESULT,
  REPAIR_RESULT_ARRAY,
  WORKING_STATE,
} from "../constants/stock.enums.js";

/*
  Repair & Warranty — what happens to a unit of ours that is broken.

    AVAILABLE ─report─► FAULTY ─── Working Fine ──────────────────────► AVAILABLE
    (or returned          │       (writing it off as dead is Dead Items — approval)
     faulty)              │
                          └─ Send for Repair (WARRANTY / PAID / IN_HOUSE)
                                     │
                                 IN_REPAIR ─── Repaired ─────► AVAILABLE (REFURBISHED)
                                     ├──────── Not Repaired ─► FAULTY
                                     └──────── Replaced ─────► new unit AVAILABLE (NEW)
                                                 old unit kept by the vendor → REPLACED
                                                 old unit given back → AVAILABLE / FAULTY / SCRAPPED
    REPLACED ── Old Unit Returned (later) ──► AVAILABLE / FAULTY / SCRAPPED

  Every step is one transaction: the unit's status, its repair/fault details
  and a timeline row move together. These statuses belong to this flow alone —
  the generic status endpoint refuses them.
*/

const MODULE_KEY = "repairs";
const ENTITY_TYPE = "inventory-items";
const LISTED = [ITEM_STATUS.FAULTY, ITEM_STATUS.IN_REPAIR, ITEM_STATUS.REPLACED, ITEM_STATUS.SCRAPPED];
const TYPE_LABEL = { WARRANTY: "Warranty repair", PAID: "Paid repair", IN_HOUSE: "In-house repair" };
const text = (v, max = 500) => (v === undefined || v === null ? "" : String(v).trim().slice(0, max));

// An optional amount in rupees: blank → null, otherwise a number ≥ 0.
const money = (v, label) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new AppError(`Invalid: ${label} must be a number of rupees, 0 or more`, 400);
  return Math.round(n * 100) / 100;
};

// A replacement's warranty: what the vendor gives (end date or months from
// today), else the old unit's.
const warrantyFrom = (rep, oldWarranty, now) => {
  if (rep.warrantyEndDate) {
    const end = new Date(rep.warrantyEndDate);
    if (Number.isNaN(end.getTime())) throw new AppError("Invalid warranty end date", 400);
    return { startDate: now, months: null, endDate: end };
  }
  if (rep.warrantyMonths !== undefined && rep.warrantyMonths !== null && rep.warrantyMonths !== "") {
    const months = Number(rep.warrantyMonths);
    if (!isValidWarrantyMonths(months)) throw new AppError("Invalid: warranty months must be a whole number between 1 and 120", 400);
    return { startDate: now, months, endDate: warrantyEndDate(now, months) };
  }
  return oldWarranty || {};
};
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const labelOf = (item) => {
  const ids = (item.identifiers || []).map((k) => k.slice(k.indexOf(":") + 1));
  if (ids.length) return ids.join(" / ");
  const vals = Object.values(item.fieldValues || {}).filter((v) => v !== null && v !== undefined && v !== "");
  return vals.length ? vals.join(" / ") : String(item._id).slice(-6).toUpperCase();
};

// Today in UTC midnight terms, matching how warranty dates are stored.
const inWarranty = (item) => (item.warranty?.endDate ? new Date(item.warranty.endDate) >= new Date() : null);

export default class StockRepairService {
  /* ---------------------------------------------------------------------- */
  /* Reads                                                                  */
  /* ---------------------------------------------------------------------- */

  static async list(query, dataAccess) {
    const { skip, limit } = paginate(query);
    const status = LISTED.includes(query.status) ? query.status : ITEM_STATUS.FAULTY;
    const filter = { isActive: true, status };
    if (query.branchId && mongoose.isValidObjectId(query.branchId)) filter.branchId = query.branchId;
    if (query.search) filter.identifiers = { $regex: escapeRegex(String(query.search).trim().toUpperCase()) };
    applyDataScope(filter, dataAccess, MODULE_KEY);

    const [rows, total] = await Promise.all([
      StockInventoryItemModel.find(filter)
        .populate({
          path: "productDefinitionId",
          select: "name trackingMethod unit categoryId selectedFields",
          // The fields a vendor replacement unit needs typing in.
          populate: { path: "selectedFields.fieldDefId", select: "code label inputType isUnique" },
        })
        .populate({ path: "branchId", select: "name" })
        .populate({ path: "vendorId", select: "name" })
        .populate({ path: "replacedByItemId", select: "identifiers fieldValues status" })
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StockInventoryItemModel.countDocuments(filter),
    ]);
    const data = rows.map((it) => ({
      _id: it._id,
      label: labelOf(it),
      product: it.productDefinitionId,
      branch: it.branchId,
      vendor: it.vendorId,
      quantity: it.quantity,
      status: it.status,
      source: it.source,
      warranty: it.warranty,
      inWarranty: inWarranty(it),
      fault: it.fault,
      repair: it.repair,
      scrapNote: it.scrapNote,
      replacedBy: it.replacedByItemId ? { _id: it.replacedByItemId._id, label: labelOf(it.replacedByItemId), status: it.replacedByItemId.status } : null,
      updatedAt: it.updatedAt,
    }));
    return { data, total };
  }

  static async counts(query, dataAccess) {
    const match = applyDataScope({ isActive: true, status: { $in: LISTED } }, dataAccess, MODULE_KEY);
    if (query.branchId && mongoose.isValidObjectId(query.branchId)) match.branchId = new mongoose.Types.ObjectId(query.branchId);
    const rows = await StockInventoryItemModel.aggregate([{ $match: match }, { $group: { _id: "$status", n: { $sum: 1 } } }]);
    const out = Object.fromEntries(LISTED.map((s) => [s, 0]));
    rows.forEach((r) => (out[r._id] = r.n));
    return out;
  }

  // Vendors a repair can go to (Warranty uses the unit's own vendor).
  static async vendorOptions() {
    return StockVendorModel.find({ isActive: true }).select("name vendorCode").sort({ name: 1 }).lean();
  }

  /* ---------------------------------------------------------------------- */
  /* One step on one unit                                                   */
  /* ---------------------------------------------------------------------- */

  static async _load(id, allowed, session, dataAccess) {
    if (!mongoose.isValidObjectId(id)) throw new Error("Inventory item not found");
    const item = await StockInventoryItemModel.findOne({ _id: id, isActive: true }).session(session);
    if (!item || !isWithinDataScope(item, dataAccess, MODULE_KEY)) throw new Error("Inventory item not found");
    if (item.lock) throw new AppError(`Invalid: ${labelOf(item)} is on pending Lost entry ${item.lock.refNumber} — wait for its approval`, 409);
    if (!allowed.includes(item.status))
      throw new AppError(`Invalid: this unit is ${item.status.toLowerCase().replace(/_/g, " ")} — that step needs it ${allowed.map((s) => s.toLowerCase().replace(/_/g, " ")).join(" or ")}`, 400);
    return item;
  }

  static async _commit(item, before, movement, action, user, session, extraMovements = []) {
    await item.save({ session });
    await StockItemMovementService.record(
      [
        {
          inventoryItemId: item._id,
          productDefinitionId: item.productDefinitionId,
          at: new Date(),
          quantity: item.quantity ?? null,
          status: item.status,
          ...movement,
        },
        ...extraMovements,
      ],
      session
    );
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: item._id, action, actor: user, before, after: item.toObject(),
    });
    return item.toObject();
  }

  // Found broken in the store (a return from a subscriber arrives FAULTY already).
  static async reportFaulty(id, body, user, session, dataAccess) {
    const note = text(body?.note);
    if (!note) throw new AppError("Describe the fault", 400);
    const item = await StockRepairService._load(id, [ITEM_STATUS.AVAILABLE], session, dataAccess);
    if (item.approvalStatus !== ITEM_APPROVAL_STATUS.APPROVED) throw new AppError("Invalid: this unit is not approved stock yet", 400);
    const before = item.toObject();
    item.status = ITEM_STATUS.FAULTY;
    item.fault = { reportedAt: new Date(), note, via: "Found in store", requestNumber: "" };
    return StockRepairService._commit(item, before, { type: ITEM_MOVEMENT_TYPE.REPORTED_FAULTY, note }, "REPORT_FAULTY", user, session);
  }

  /*
    Off to be fixed. body: { type: WARRANTY | PAID | IN_HOUSE, vendorId?,
    claimRef?, estimatedCost?, note? }
      WARRANTY  the vendor it was bought from (chosen only when the unit has
                none on record), only while in warranty or when the end date
                is unknown — free.
      PAID      any vendor, an optional estimate.
      IN_HOUSE  our own technician, no vendor.
  */
  static async sendForRepair(id, body, user, session, dataAccess) {
    const type = String(body?.type || "").toUpperCase();
    if (!REPAIR_TYPE_ARRAY.includes(type)) throw new AppError("Invalid: choose where it is repaired — Warranty, Paid or In-house", 400);
    const item = await StockRepairService._load(id, [ITEM_STATUS.FAULTY], session, dataAccess);
    const before = item.toObject();
    const note = text(body?.note);
    const claimRef = text(body?.claimRef, 100);
    const warranty = inWarranty(before);

    let vendor = null;
    if (type === REPAIR_TYPE.WARRANTY) {
      if (warranty === false) throw new AppError("Invalid: the warranty has ended — send it as a Paid repair", 400);
      const vendorId = item.vendorId || body?.vendorId;
      if (!vendorId || !mongoose.isValidObjectId(vendorId)) throw new AppError("Choose the vendor it was bought from", 400);
      vendor = await StockVendorModel.findOne({ _id: vendorId }).select("name").session(session).lean();
      if (!vendor) throw new AppError("Invalid vendor selected", 400);
    } else if (type === REPAIR_TYPE.PAID) {
      if (!body?.vendorId || !mongoose.isValidObjectId(body.vendorId)) throw new AppError("Choose the vendor doing the repair", 400);
      vendor = await StockVendorModel.findOne({ _id: body.vendorId, isActive: true }).select("name").session(session).lean();
      if (!vendor) throw new AppError("Invalid vendor selected", 400);
    }
    const estimatedCost = type === REPAIR_TYPE.PAID ? money(body?.estimatedCost, "Estimated cost") : null;

    item.status = ITEM_STATUS.IN_REPAIR;
    item.repair = {
      type, sentAt: new Date(), note, claimRef, estimatedCost, inWarranty: warranty,
      vendorId: vendor?._id || null, vendorName: vendor?.name || "",
    };
    return StockRepairService._commit(
      item,
      before,
      {
        type: ITEM_MOVEMENT_TYPE.SENT_FOR_REPAIR,
        ref: { type: ITEM_MOVEMENT_REF.REPAIR, refId: vendor?._id || null, refNumber: claimRef },
        cost: estimatedCost,
        note: [`${TYPE_LABEL[type]}${vendor ? ` — ${vendor.name}` : ""}${claimRef ? ` (${claimRef})` : ""}`, note].filter(Boolean).join(": "),
      },
      "SEND_REPAIR",
      user,
      session
    );
  }

  /*
    The repair is back. body: { result, cost?, note?, replacement? }
      REPAIRED      the same unit, working → AVAILABLE, condition REFURBISHED
      NOT_REPAIRED  could not be fixed → FAULTY again (send elsewhere or scrap)
      REPLACED      the vendor sent another unit (WARRANTY or PAID). A NEW
                    unit is created — body.replacement: { fieldValues,
                    warrantyEndDate? | warrantyMonths?, oldUnit } where oldUnit
                    says whether the vendor gave this one back too:
                      { returned: false }                     → this one REPLACED
                      { returned: true, workingState, note }  → back in stock
                    Kept → the new unit takes this one's place in every count;
                    given back → both are ours, the new one counts as free.
    cost: PAID only — the final amount.
  */
  static async repairResult(id, body, user, session, dataAccess) {
    const result = String(body?.result || "").toUpperCase();
    if (!REPAIR_RESULT_ARRAY.includes(result)) throw new AppError("Invalid: result must be Repaired, Replaced or Not Repaired", 400);
    const note = text(body?.note);
    if (result === REPAIR_RESULT.NOT_REPAIRED && !note) throw new AppError("Say why it could not be repaired", 400);
    const item = await StockRepairService._load(id, [ITEM_STATUS.IN_REPAIR], session, dataAccess);
    const before = item.toObject();
    const repair = before.repair || {};
    if (result === REPAIR_RESULT.REPLACED && repair.type === REPAIR_TYPE.IN_HOUSE)
      throw new AppError("Invalid: only a vendor can replace a unit — In-house repairs are Repaired or Not Repaired", 400);
    const cost = repair.type === REPAIR_TYPE.PAID ? money(body?.cost, "Cost") : null;
    const ref = { type: ITEM_MOVEMENT_REF.REPAIR, refId: repair.vendorId || null, refNumber: repair.claimRef || "" };
    const by = repair.vendorName || TYPE_LABEL[repair.type] || "repair";

    if (result === REPAIR_RESULT.REPAIRED) {
      item.status = ITEM_STATUS.AVAILABLE;
      item.condition = ITEM_CONDITION.REFURBISHED;
      item.fault = null;
      item.repair = null;
      return StockRepairService._commit(item, before, { type: ITEM_MOVEMENT_TYPE.REPAIRED, ref, cost, note: note || `Repaired — ${by}` }, "REPAIRED", user, session);
    }
    if (result === REPAIR_RESULT.NOT_REPAIRED) {
      item.status = ITEM_STATUS.FAULTY;
      item.repair = null;
      item.fault = { ...(before.fault || {}), note: [before.fault?.note, `Not repaired (${by}): ${note}`].filter(Boolean).join(" · ") };
      return StockRepairService._commit(item, before, { type: ITEM_MOVEMENT_TYPE.NOT_REPAIRED, ref, cost, note }, "NOT_REPAIRED", user, session);
    }

    // REPLACED — first how the old unit ends up, then the new unit.
    const rep = body?.replacement || {};
    const oldReturned = rep.oldUnit?.returned === true;
    const oldState = oldReturned ? readReturnState(rep.oldUnit, "Old unit") : null;

    const product = await StockProductDefinitionModel.findOne({ _id: item.productDefinitionId, isActive: true }).session(session).lean();
    if (!product) throw new AppError("Invalid: product not found", 400);
    const isUnit = item.quantity === null || item.quantity === undefined;
    const fieldValues = isUnit ? rep.fieldValues || {} : rep.fieldValues || before.fieldValues || {};
    await StockInventoryItemService._validateFieldValues(product, fieldValues);
    const uniqueFields = await StockItemIdentityService.uniqueFieldsFor(product, session);
    StockItemIdentityService.assertHasIdentifier(fieldValues, uniqueFields);
    const keys = StockItemIdentityService.identifiersOf(fieldValues, uniqueFields);
    await StockItemIdentityService.assertIdentifiersFree(keys, {
      session,
      // A kept unit frees its serial (it is the vendor's now); a returned one keeps it.
      excludeItemIds: oldReturned ? [] : [item._id],
      labelByCode: new Map(uniqueFields.map((f) => [f.code, f.label])),
    });

    const now = new Date();
    const warranty = warrantyFrom(rep, before.warranty, now);

    item.repair = null;
    if (oldReturned) {
      Object.assign(item, StockRepairService._landed(oldState, now));
    } else {
      item.status = ITEM_STATUS.REPLACED;
      item.identifiers = undefined;
    }

    const [fresh] = await StockInventoryItemModel.create(
      [
        {
          productDefinitionId: product._id,
          vendorId: repair.vendorId || before.vendorId,
          branchId: before.branchId,
          invoiceId: before.invoiceId || null,
          status: ITEM_STATUS.AVAILABLE,
          approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
          quantity: isUnit ? null : before.quantity,
          fieldValues,
          identifiers: keys.length ? keys : undefined,
          source: { type: ITEM_SOURCE.VENDOR_REPLACEMENT, refId: item._id, refNumber: repair.claimRef || labelOf(before) },
          condition: ITEM_CONDITION.NEW,
          warranty,
          // A swap carries the old unit's cost; a unit on top of ours was free.
          purchaseCost: oldReturned ? 0 : before.purchaseCost,
          purchaseDate: before.purchaseDate,
          replacesItemId: item._id,
          receivedAt: now,
          receivedBy: user?._id || user?.id || null,
        },
      ],
      { session }
    );
    item.replacedByItemId = fresh._id;

    const oldNote = oldReturned ? ` · old unit given back too (${returnStateLabel(oldState)})` : "";
    return StockRepairService._commit(
      item,
      before,
      { type: ITEM_MOVEMENT_TYPE.REPLACED, ref, cost, relatedItemId: fresh._id, note: (note ? `${note} · ` : "") + `Replaced by ${by} with ${labelOf(fresh)}${oldNote}` },
      "REPLACED",
      user,
      session,
      [
        {
          inventoryItemId: fresh._id,
          productDefinitionId: product._id,
          type: ITEM_MOVEMENT_TYPE.RECEIVED,
          at: now,
          quantity: fresh.quantity ?? null,
          toBranchId: before.branchId,
          status: ITEM_STATUS.AVAILABLE,
          ref,
          relatedItemId: item._id,
          note: oldReturned ? `From ${by}, free — ${labelOf(before)} given back too` : `Vendor replacement for ${labelOf(before)}`,
        },
      ]
    );
  }

  /*
    A REPLACED unit the vendor handed back after all. body: { workingState,
    note } — Working → AVAILABLE (REFURBISHED), Faulty → FAULTY, Dead →
    SCRAPPED. Its serial is taken back (it must still be free). From now on
    the replacement counts as an extra unit, received free.
  */
  static async oldUnitReturned(id, body, user, session, dataAccess) {
    const state = readReturnState(body);
    const item = await StockRepairService._load(id, [ITEM_STATUS.REPLACED], session, dataAccess);
    const before = item.toObject();
    const product = await StockProductDefinitionModel.findById(item.productDefinitionId).session(session).lean();
    const uniqueFields = product ? await StockItemIdentityService.uniqueFieldsFor(product, session) : [];
    const keys = StockItemIdentityService.identifiersOf(before.fieldValues || {}, uniqueFields);
    await StockItemIdentityService.assertIdentifiersFree(keys, {
      session,
      excludeItemIds: [item._id],
      labelByCode: new Map(uniqueFields.map((f) => [f.code, f.label])),
    });
    Object.assign(item, StockRepairService._landed(state, new Date()));
    item.identifiers = keys.length ? keys : undefined;
    // The replacement is now an extra unit on top of this one — free.
    if (before.replacedByItemId) {
      await StockInventoryItemModel.updateOne({ _id: before.replacedByItemId }, { $set: { purchaseCost: 0 } }, { session });
    }
    return StockRepairService._commit(
      item,
      before,
      { type: ITEM_MOVEMENT_TYPE.OLD_UNIT_RETURNED, relatedItemId: before.replacedByItemId || null, note: `Given back by the vendor — ${returnStateLabel(state)}` },
      "OLD_UNIT_RETURNED",
      user,
      session
    );
  }

  // Where a unit handed back by the vendor lands, as the store judged it.
  static _landed({ workingState, note }, now) {
    if (workingState === WORKING_STATE.WORKING) return { status: ITEM_STATUS.AVAILABLE, condition: ITEM_CONDITION.REFURBISHED, fault: null };
    if (workingState === WORKING_STATE.FAULTY)
      return { status: ITEM_STATUS.FAULTY, fault: { reportedAt: now, note, via: "Given back by the vendor", requestNumber: "" } };
    return { status: ITEM_STATUS.SCRAPPED, scrapNote: note };
  }

  // Turned out to work after all.
  static async markOk(id, body, user, session, dataAccess) {
    const item = await StockRepairService._load(id, [ITEM_STATUS.FAULTY], session, dataAccess);
    const before = item.toObject();
    item.status = ITEM_STATUS.AVAILABLE;
    item.fault = null;
    return StockRepairService._commit(item, before, { type: ITEM_MOVEMENT_TYPE.MARKED_OK, note: text(body?.note) || "Checked — working" }, "MARKED_OK", user, session);
  }
}

export { LISTED as REPAIR_LISTED_STATUSES };
