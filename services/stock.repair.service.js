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
import {
  ITEM_STATUS,
  ITEM_APPROVAL_STATUS,
  ITEM_CONDITION,
  ITEM_SOURCE,
  ITEM_MOVEMENT_TYPE,
  ITEM_MOVEMENT_REF,
  REPAIR_KIND,
} from "../constants/stock.enums.js";

/*
  Repair & Warranty — what happens to a unit of ours that is broken.

                    ┌──► send for repair ──► IN_REPAIR ──► repaired ─────► AVAILABLE
                    │                              └─────► can't fix ────► FAULTY
    AVAILABLE ─report─► FAULTY ──► warranty claim ──► AT_VENDOR ──► repaired ─► AVAILABLE
    (or returned       │                              ├─► replaced ──► VENDOR_REPLACED
     faulty by a       │                              │     + a NEW unit, source VENDOR_REPLACEMENT
     subscriber)       │                              └─► claim refused ─► FAULTY
                       ├──► turned out fine ──► AVAILABLE
                       └──► scrap ──► SCRAPPED

  Every step is one transaction: the unit's status, its repair/fault details
  and a timeline row move together. These statuses belong to this flow alone —
  the generic status endpoint refuses them.
*/

const MODULE_KEY = "repairs";
const ENTITY_TYPE = "inventory-items";
const LISTED = [ITEM_STATUS.FAULTY, ITEM_STATUS.IN_REPAIR, ITEM_STATUS.AT_VENDOR, ITEM_STATUS.SCRAPPED, ITEM_STATUS.VENDOR_REPLACED];
const text = (v, max = 500) => (v === undefined || v === null ? "" : String(v).trim().slice(0, max));
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
      replacedByItemId: it.replacedByItemId,
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

  // Vendors to claim against (the unit's own vendor is the default).
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

  static async sendForRepair(id, body, user, session, dataAccess) {
    const item = await StockRepairService._load(id, [ITEM_STATUS.FAULTY], session, dataAccess);
    const before = item.toObject();
    const note = text(body?.note);
    item.status = ITEM_STATUS.IN_REPAIR;
    item.repair = { kind: REPAIR_KIND.INTERNAL, sentAt: new Date(), note };
    return StockRepairService._commit(item, before, { type: ITEM_MOVEMENT_TYPE.SENT_FOR_REPAIR, note: note || "Sent for repair" }, "SEND_REPAIR", user, session);
  }

  // Our own repair is back: fixed → shelf, not fixable → faulty again.
  static async repairResult(id, body, user, session, dataAccess) {
    const fixed = body?.result === "REPAIRED";
    if (!fixed && body?.result !== "FAILED") throw new AppError("Invalid: result must be REPAIRED or FAILED", 400);
    const note = text(body?.note);
    if (!fixed && !note) throw new AppError("Say why it could not be repaired", 400);
    const item = await StockRepairService._load(id, [ITEM_STATUS.IN_REPAIR], session, dataAccess);
    const before = item.toObject();
    item.repair = null;
    if (fixed) {
      item.status = ITEM_STATUS.AVAILABLE;
      item.fault = null;
    } else {
      item.status = ITEM_STATUS.FAULTY;
      item.fault = { ...(before.fault || {}), note: [before.fault?.note, `Repair failed: ${note}`].filter(Boolean).join(" · ") };
    }
    return StockRepairService._commit(
      item,
      before,
      { type: fixed ? ITEM_MOVEMENT_TYPE.REPAIRED : ITEM_MOVEMENT_TYPE.REPAIR_FAILED, note: note || (fixed ? "Repaired" : "") },
      fixed ? "REPAIRED" : "REPAIR_FAILED",
      user,
      session
    );
  }

  // Warranty claim — off to the vendor. Out-of-warranty units may still be
  // sent (a paid repair); the screen warns, and the flag records it.
  static async sendClaim(id, body, user, session, dataAccess) {
    const item = await StockRepairService._load(id, [ITEM_STATUS.FAULTY], session, dataAccess);
    const vendorId = body?.vendorId || item.vendorId;
    if (!vendorId || !mongoose.isValidObjectId(vendorId)) throw new AppError("Choose the vendor the claim goes to", 400);
    const vendor = await StockVendorModel.findOne({ _id: vendorId, isActive: true }).select("name").session(session).lean();
    if (!vendor) throw new AppError("Invalid vendor selected", 400);
    const before = item.toObject();
    const claimRef = text(body?.claimRef, 100);
    const note = text(body?.note);
    item.status = ITEM_STATUS.AT_VENDOR;
    item.repair = { kind: REPAIR_KIND.VENDOR, sentAt: new Date(), note, vendorId: vendor._id, vendorName: vendor.name, claimRef, inWarranty: inWarranty(before) };
    return StockRepairService._commit(
      item,
      before,
      {
        type: ITEM_MOVEMENT_TYPE.CLAIM_SENT,
        ref: { type: ITEM_MOVEMENT_REF.WARRANTY_CLAIM, refId: vendor._id, refNumber: claimRef },
        note: `Warranty claim to ${vendor.name}${claimRef ? ` (${claimRef})` : ""}${item.repair.inWarranty === false ? " · out of warranty" : ""}`,
      },
      "WARRANTY_CLAIM",
      user,
      session
    );
  }

  /*
    The vendor has answered the claim:
      REPAIRED  the same unit came back working → AVAILABLE
      REJECTED  claim refused, unit back as it was → FAULTY
      REPLACED  the vendor kept it and sent another → this one VENDOR_REPLACED,
                and a NEW unit is created (body.replacement: { fieldValues,
                warrantyEndDate? | warrantyMonths?, productDefinitionId? }).
                Its serial goes through the same unique checks as any receipt;
                its warranty is what the vendor gives, else the old unit's.
  */
  static async claimOutcome(id, body, user, session, dataAccess) {
    const outcome = body?.outcome;
    if (!["REPAIRED", "REJECTED", "REPLACED"].includes(outcome)) throw new AppError("Invalid: outcome must be REPAIRED, REJECTED or REPLACED", 400);
    const note = text(body?.note);
    if (outcome === "REJECTED" && !note) throw new AppError("Say why the vendor refused the claim", 400);
    const item = await StockRepairService._load(id, [ITEM_STATUS.AT_VENDOR], session, dataAccess);
    const before = item.toObject();
    const claim = before.repair || {};
    const ref = { type: ITEM_MOVEMENT_REF.WARRANTY_CLAIM, refId: claim.vendorId || null, refNumber: claim.claimRef || "" };

    if (outcome === "REPAIRED") {
      item.status = ITEM_STATUS.AVAILABLE;
      item.fault = null;
      item.repair = null;
      return StockRepairService._commit(item, before, { type: ITEM_MOVEMENT_TYPE.CLAIM_RETURNED, ref, note: note || `Repaired by ${claim.vendorName || "vendor"}` }, "CLAIM_REPAIRED", user, session);
    }
    if (outcome === "REJECTED") {
      item.status = ITEM_STATUS.FAULTY;
      item.repair = null;
      item.fault = { ...(before.fault || {}), note: [before.fault?.note, `Claim refused: ${note}`].filter(Boolean).join(" · ") };
      return StockRepairService._commit(item, before, { type: ITEM_MOVEMENT_TYPE.CLAIM_REJECTED, ref, note }, "CLAIM_REJECTED", user, session);
    }

    // REPLACED
    const rep = body?.replacement || {};
    const productId = rep.productDefinitionId || item.productDefinitionId;
    const product = await StockProductDefinitionModel.findOne({ _id: productId, isActive: true }).session(session).lean();
    if (!product) throw new AppError("Invalid: replacement product not found", 400);
    const oldProduct = await StockProductDefinitionModel.findById(item.productDefinitionId).select("categoryId trackingMethod").session(session).lean();
    if (String(product.categoryId) !== String(oldProduct?.categoryId) || product.trackingMethod !== oldProduct?.trackingMethod)
      throw new AppError("Invalid: the replacement must be a product of the same category", 400);

    const isUnit = item.quantity === null || item.quantity === undefined;
    const fieldValues = isUnit ? rep.fieldValues || {} : rep.fieldValues || before.fieldValues || {};
    await StockInventoryItemService._validateFieldValues(product, fieldValues);
    const uniqueFields = await StockItemIdentityService.uniqueFieldsFor(product, session);
    StockItemIdentityService.assertHasIdentifier(fieldValues, uniqueFields);
    const keys = StockItemIdentityService.identifiersOf(fieldValues, uniqueFields);
    await StockItemIdentityService.assertIdentifiersFree(keys, {
      session,
      excludeItemIds: [item._id],
      labelByCode: new Map(uniqueFields.map((f) => [f.code, f.label])),
    });

    const now = new Date();
    let warranty = before.warranty || {};
    if (rep.warrantyEndDate) {
      const end = new Date(rep.warrantyEndDate);
      if (Number.isNaN(end.getTime())) throw new AppError("Invalid warranty end date", 400);
      warranty = { startDate: now, months: null, endDate: end };
    } else if (rep.warrantyMonths !== undefined && rep.warrantyMonths !== null && rep.warrantyMonths !== "") {
      const months = Number(rep.warrantyMonths);
      if (!isValidWarrantyMonths(months)) throw new AppError("Invalid: warranty months must be a whole number between 1 and 120", 400);
      warranty = { startDate: now, months, endDate: warrantyEndDate(now, months) };
    }

    // The old unit leaves for good, and frees its serial: it is the vendor's
    // now, and the same number arriving again would be a new unit.
    item.status = ITEM_STATUS.VENDOR_REPLACED;
    item.repair = null;
    item.identifiers = undefined;

    const [fresh] = await StockInventoryItemModel.create(
      [
        {
          productDefinitionId: product._id,
          vendorId: claim.vendorId || before.vendorId,
          branchId: before.branchId,
          status: ITEM_STATUS.AVAILABLE,
          approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
          quantity: isUnit ? null : before.quantity,
          fieldValues,
          identifiers: keys.length ? keys : undefined,
          source: { type: ITEM_SOURCE.VENDOR_REPLACEMENT, refId: item._id, refNumber: claim.claimRef || labelOf(before) },
          condition: ITEM_CONDITION.NEW,
          warranty,
          purchaseCost: before.purchaseCost,
          purchaseDate: before.purchaseDate,
          replacesItemId: item._id,
          receivedAt: now,
          receivedBy: user?._id || user?.id || null,
        },
      ],
      { session }
    );
    item.replacedByItemId = fresh._id;

    return StockRepairService._commit(
      item,
      before,
      { type: ITEM_MOVEMENT_TYPE.VENDOR_REPLACED, ref, relatedItemId: fresh._id, note: note || `Replaced by ${claim.vendorName || "vendor"} with ${labelOf(fresh)}` },
      "CLAIM_REPLACED",
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
          note: `Vendor replacement for ${labelOf(before)}`,
        },
      ]
    );
  }

  // Turned out to work after all.
  static async markOk(id, body, user, session, dataAccess) {
    const item = await StockRepairService._load(id, [ITEM_STATUS.FAULTY], session, dataAccess);
    const before = item.toObject();
    item.status = ITEM_STATUS.AVAILABLE;
    item.fault = null;
    return StockRepairService._commit(item, before, { type: ITEM_MOVEMENT_TYPE.MARKED_OK, note: text(body?.note) || "Checked — working" }, "MARKED_OK", user, session);
  }

  // Written off. The serial stays held: a scrapped unit reappearing is a
  // mistake worth being told about.
  static async scrap(id, body, user, session, dataAccess) {
    const note = text(body?.note);
    if (!note) throw new AppError("Give a reason for scrapping", 400);
    const item = await StockRepairService._load(id, [ITEM_STATUS.FAULTY], session, dataAccess);
    const before = item.toObject();
    item.status = ITEM_STATUS.SCRAPPED;
    item.scrapNote = note;
    return StockRepairService._commit(item, before, { type: ITEM_MOVEMENT_TYPE.SCRAPPED, note }, "SCRAP", user, session);
  }
}

export { LISTED as REPAIR_LISTED_STATUSES };
