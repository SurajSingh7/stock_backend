import mongoose from "mongoose";
import StockTransferModel from "../models/stock.transfer.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import StockItemMovementService from "./stock.item.movement.service.js";
import { nextDocumentNumber } from "../helpers/document.number.helper.js";
import { AppError } from "../helpers/response.helper.js";
import {
  TRACKING_METHODS,
  ITEM_STATUS,
  ITEM_APPROVAL_STATUS,
  ITEM_MOVEMENT_TYPE,
  ITEM_MOVEMENT_REF,
  TRANSFER_EVENT,
} from "../constants/stock.enums.js";

/*
  Stock Transfer — moving the stock a request sent (TRF-…).

    dispatch       Send: the chosen units / quantities become IN_TRANSIT on the
                   sending branch — out of everyone's Available
    confirm        All Received: everything on it lands at the requesting
                   branch, AVAILABLE. The TRANSFERRED movement is written here,
                   when the stock really changes branch.
    reportProblem  the requester says something is wrong; nothing moves
    correct        Correct & Resend: the sender takes off what never went (back
                   to their Available); the rest stays on the way

  Internal: StockTransferRequestService owns the request's status and checks
  who may act. Every call here runs inside its transaction.
*/

const ENTITY_TYPE = "transfers";
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

const transferRef = (transfer) => ({
  type: ITEM_MOVEMENT_REF.TRANSFER,
  refId: transfer._id,
  refNumber: transfer.transferNumber,
});

// Serial / MAC, the way Repair & Warranty names a unit.
const labelOf = (item) => {
  const ids = (item.identifiers || []).map((k) => k.slice(k.indexOf(":") + 1));
  if (ids.length) return ids.join(" / ");
  const vals = Object.values(item.fieldValues || {}).filter((v) => v !== null && v !== undefined && v !== "");
  return vals.length ? vals.join(" / ") : String(item._id).slice(-6).toUpperCase();
};

// Everything that describes a batch travels with a piece split off it; only
// where it sits, its status and its quantity change.
const BATCH_COPY_FIELDS = [
  "productDefinitionId", "vendorId", "branchId", "invoiceId", "approvalStatus", "isFoc",
  "fieldValues", "source", "condition", "warranty", "purchaseCost", "purchaseDate",
  "receivedAt", "receivedBy",
];
const splitBatch = async (row, qty, set, session) => {
  const src = row.toObject();
  const copy = Object.fromEntries(BATCH_COPY_FIELDS.map((f) => [f, src[f]]));
  row.quantity = round3(row.quantity - qty);
  await row.save({ session });
  const [piece] = await StockInventoryItemModel.create([{ ...copy, ...set, quantity: qty }], { session });
  return piece;
};

// A unit / batch row still travelling on this transfer.
const onThisTransfer = (item, transfer) =>
  item && item.status === ITEM_STATUS.IN_TRANSIT && String(item.transit?.transferId) === String(transfer._id);

export default class StockTransferService {
  /* ---------------------------------------------------------------------- */
  /* Picking what to send                                                   */
  /* ---------------------------------------------------------------------- */

  // The exact units chosen, checked free at the sending branch.
  static async _pickUnits(ids, def, fromBranchId, session) {
    const items = await StockInventoryItemModel.find({ _id: { $in: ids }, isActive: true }).session(session);
    if (items.length !== ids.length) throw new AppError(`${def.name}: one or more selected units could not be found`, 404);
    for (const item of items) {
      if (String(item.productDefinitionId) !== String(def._id))
        throw new AppError(`Invalid: a selected unit is not ${def.name}`, 400);
      if (String(item.branchId) !== String(fromBranchId))
        throw new AppError(`Invalid: ${labelOf(item)} is not at the sending branch`, 400);
      if (item.status !== ITEM_STATUS.AVAILABLE || item.approvalStatus !== ITEM_APPROVAL_STATUS.APPROVED)
        throw new AppError(`Invalid: ${labelOf(item)} is no longer available`, 400);
    }
    return items;
  }

  // Oldest batches first, so "oldest in the company" leaves first.
  static async _drawBatches(def, fromBranchId, qty, session) {
    const batches = await StockInventoryItemModel.find({
      productDefinitionId: def._id,
      branchId: fromBranchId,
      isActive: true,
      status: ITEM_STATUS.AVAILABLE,
      approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
      quantity: { $gt: 0 },
    })
      .sort({ receivedAt: 1 })
      .session(session);
    const have = round3(batches.reduce((s, b) => s + (b.quantity || 0), 0));
    if (have < qty) throw new AppError(`Invalid: not enough ${def.name} available (have ${have}, sending ${qty})`, 400);
    const draws = [];
    let left = qty;
    for (const row of batches) {
      if (left <= 0) break;
      const take = round3(Math.min(left, row.quantity));
      draws.push({ row, qty: take });
      left = round3(left - take);
    }
    return draws;
  }

  /*
    lines: [{ productDefinitionId, qty, inventoryItemIds, unitNotes: { id: note }, requestLineId }]
    → what dispatch needs, every unit and quantity checked before anything moves.
  */
  static async prepareLines(lines, fromBranchId, session) {
    const seenProducts = new Set();
    const seenUnits = new Set();
    const out = [];
    for (const l of lines || []) {
      const qty = round3(Number(l.qty) || 0);
      if (qty <= 0) continue;
      const key = String(l.productDefinitionId);
      if (seenProducts.has(key)) throw new AppError("Invalid: each product can be on one line only", 400);
      seenProducts.add(key);

      const def = await StockProductDefinitionModel.findOne({ _id: l.productDefinitionId, isActive: true })
        .select("name trackingMethod unit")
        .session(session)
        .lean();
      if (!def) throw new AppError("One of the products could not be found", 404);
      const requestLineId = l.requestLineId || null;

      if (def.trackingMethod === TRACKING_METHODS.INDIVIDUAL) {
        const ids = (l.inventoryItemIds || []).map(String);
        if (!Number.isInteger(qty) || ids.length !== qty)
          throw new AppError(`Invalid: ${def.name} — select exactly ${qty} unit(s)`, 400);
        ids.forEach((id) => {
          if (seenUnits.has(id)) throw new AppError("Invalid: the same unit is selected twice", 400);
          seenUnits.add(id);
        });
        const items = await StockTransferService._pickUnits(ids, def, fromBranchId, session);
        out.push({ def, requestLineId, items, unitNotes: l.unitNotes || {} });
      } else {
        out.push({ def, requestLineId, draws: await StockTransferService._drawBatches(def, fromBranchId, qty, session) });
      }
    }
    if (!out.length) throw new AppError("Invalid: enter a quantity for at least one product", 400);
    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* Send — puts the stock on the way                                       */
  /* ---------------------------------------------------------------------- */

  static async dispatch({ request, lines, note = "", user, session }) {
    const { sourceBranchId: fromBranchId, requestingBranchId: toBranchId } = request;
    const _id = new mongoose.Types.ObjectId();
    const transferNumber = await nextDocumentNumber({ model: StockTransferModel, field: "transferNumber", prefix: "TRF", session });
    const sentAt = new Date();
    const ref = { type: ITEM_MOVEMENT_REF.TRANSFER, refId: _id, refNumber: transferNumber };
    const transit = (unitNote = "") => ({ transferId: _id, transferNumber, toBranchId, sentAt, note: unitNote });

    const movements = [];
    const outLines = [];
    for (const l of lines) {
      const { def } = l;
      const line = {
        _id: new mongoose.Types.ObjectId(),
        productDefinitionId: def._id,
        productName: def.name,
        trackingMethod: def.trackingMethod,
        unit: def.unit || null,
        requestLineId: l.requestLineId || null,
        sentQty: 0,
        units: [],
        batches: [],
      };
      const sent = { productDefinitionId: def._id, type: ITEM_MOVEMENT_TYPE.TRANSFER_SENT, fromBranchId, toBranchId, status: ITEM_STATUS.IN_TRANSIT, ref, at: sentAt };

      if (def.trackingMethod === TRACKING_METHODS.INDIVIDUAL) {
        for (const item of l.items) {
          const unitNote = String(l.unitNotes?.[String(item._id)] || "").trim();
          item.status = ITEM_STATUS.IN_TRANSIT;
          item.transit = transit(unitNote);
          await item.save({ session });
          line.units.push({ inventoryItemId: item._id, label: labelOf(item), note: unitNote });
          movements.push({ ...sent, inventoryItemId: item._id, note: unitNote });
        }
        line.sentQty = line.units.length;
      } else {
        for (const { row, qty } of l.draws) {
          let piece = row;
          if (qty < row.quantity) {
            piece = await splitBatch(row, qty, { status: ITEM_STATUS.IN_TRANSIT, transit: transit() }, session);
          } else {
            row.status = ITEM_STATUS.IN_TRANSIT;
            row.transit = transit();
            await row.save({ session });
          }
          line.batches.push({ inventoryItemId: piece._id, quantity: qty });
          movements.push({ ...sent, inventoryItemId: piece._id, quantity: qty });
        }
        line.sentQty = round3(line.batches.reduce((s, b) => s + b.quantity, 0));
      }
      if (line.sentQty > 0) outLines.push(line);
    }
    if (!outLines.length) throw new AppError("Invalid: select at least one item to send", 400);

    const [transfer] = await StockTransferModel.create(
      [
        {
          _id,
          transferNumber,
          fromBranchId,
          toBranchId,
          requestId: request._id,
          requestNumber: request.requestNumber,
          lines: outLines,
          note: String(note || "").trim(),
          sentBy: user?._id || null,
          sentByName: user?.name || "",
          sentAt,
        },
      ],
      { session }
    );
    await StockItemMovementService.record(movements, session);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: transfer._id, action: "SEND", actor: user, before: null, after: transfer.toObject(),
    });
    return transfer;
  }

  /* ---------------------------------------------------------------------- */
  /* All Received / Report Problem — the requester                          */
  /* ---------------------------------------------------------------------- */

  static async _load(transferId, session) {
    const transfer = await StockTransferModel.findOne({ _id: transferId, isActive: true }).session(session);
    if (!transfer) throw new AppError("Transfer not found", 404);
    return transfer;
  }

  // Everything arrived — it all lands at the requesting branch, AVAILABLE.
  static async confirm(transferId, user, session) {
    const transfer = await StockTransferService._load(transferId, session);
    const before = transfer.toObject();
    const now = new Date();
    const ref = transferRef(transfer);
    const { fromBranchId, toBranchId } = transfer;

    const ids = transfer.lines.flatMap((l) => [...l.units, ...l.batches].map((x) => x.inventoryItemId));
    const items = await StockInventoryItemModel.find({ _id: { $in: ids } }).session(session);
    if (items.length !== ids.length || items.some((it) => !onThisTransfer(it, transfer)))
      throw new AppError("Invalid: some of this stock is no longer on the way — refresh and try again", 400);

    const movements = [];
    for (const item of items) {
      item.status = ITEM_STATUS.AVAILABLE;
      item.branchId = toBranchId;
      item.transit = null;
      await item.save({ session });
      movements.push({
        inventoryItemId: item._id, productDefinitionId: item.productDefinitionId, type: ITEM_MOVEMENT_TYPE.TRANSFERRED,
        fromBranchId, toBranchId, status: item.status, quantity: item.quantity ?? null, ref, at: now,
      });
    }

    transfer.problemNote = "";
    transfer.receivedBy = user?._id || null;
    transfer.receivedByName = user?.name || "";
    transfer.receivedAt = now;
    await transfer.save({ session });
    await StockItemMovementService.record(movements, session);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: transfer._id, action: "RECEIVE", actor: user, before, after: transfer.toObject(),
    });
    return transfer;
  }

  // Something is wrong — recorded for the sender. The stock stays on the way.
  static async reportProblem(transferId, note, user, session) {
    const transfer = await StockTransferService._load(transferId, session);
    const before = transfer.toObject();
    transfer.problemNote = note;
    transfer.history.push({ type: TRANSFER_EVENT.PROBLEM_REPORTED, note, by: user?._id || null, byName: user?.name || "", at: new Date() });
    await transfer.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: transfer._id, action: "REPORT_PROBLEM", actor: user, before, after: transfer.toObject(),
    });
    return transfer;
  }

  /* ---------------------------------------------------------------------- */
  /* Correct & Resend — the sender                                          */
  /* ---------------------------------------------------------------------- */

  /*
    body: {
      lines: [{ lineId, keepItemIds: [...] }       individual — the units that really went
              { lineId, keepQty }]                 quantity-tracked — how much really went
      note   optional, for the requester
    }
    A line left out keeps everything. Only taking off is allowed — what is
    taken off never went, so it is AVAILABLE again at the sending branch.
    Returns { transfer, removedByRequestLine: Map(requestLineId → qty) }.
  */
  static async correct(transferId, body, user, session) {
    const transfer = await StockTransferService._load(transferId, session);
    const before = transfer.toObject();
    const now = new Date();
    const note = String(body?.note || "").trim();
    const ref = transferRef(transfer);
    const inputBy = new Map((body?.lines || []).map((l) => [String(l.lineId), l]));
    for (const lineId of inputBy.keys()) {
      if (!transfer.lines.some((l) => String(l._id) === lineId)) throw new AppError("Invalid: a line does not belong to this transfer", 400);
    }

    const movements = [];
    const removed = [];
    const removedByRequestLine = new Map();
    const backToStock = (item, qty) => {
      item.status = ITEM_STATUS.AVAILABLE;
      item.transit = null;
      movements.push({
        inventoryItemId: item._id, productDefinitionId: item.productDefinitionId, type: ITEM_MOVEMENT_TYPE.TRANSFER_REMOVED,
        toBranchId: item.branchId, status: item.status, quantity: qty ?? null, ref, at: now, note,
      });
    };

    for (const line of transfer.lines) {
      const input = inputBy.get(String(line._id));
      if (!input) continue;
      let takenOff = 0;
      const labels = [];

      if (line.trackingMethod === TRACKING_METHODS.INDIVIDUAL) {
        const keep = new Set((input.keepItemIds || []).map(String));
        for (const kid of keep) {
          if (!line.units.some((u) => String(u.inventoryItemId) === kid))
            throw new AppError(`Invalid: ${line.productName} — a unit is not on this transfer`, 400);
        }
        const off = line.units.filter((u) => !keep.has(String(u.inventoryItemId)));
        if (off.length) {
          const items = await StockInventoryItemModel.find({ _id: { $in: off.map((u) => u.inventoryItemId) } }).session(session);
          for (const unit of off) {
            const item = items.find((it) => String(it._id) === String(unit.inventoryItemId));
            if (!onThisTransfer(item, transfer)) throw new AppError(`Invalid: ${unit.label} is no longer on this transfer`, 400);
            backToStock(item, null);
            await item.save({ session });
            labels.push(unit.label);
          }
          line.units = line.units.filter((u) => keep.has(String(u.inventoryItemId)));
          takenOff = off.length;
          line.sentQty = line.units.length;
        }
      } else {
        const keepQty = round3(Number(input.keepQty));
        if (!Number.isFinite(keepQty) || keepQty < 0 || keepQty > line.sentQty)
          throw new AppError(`Invalid: ${line.productName} — keep between 0 and ${line.sentQty}`, 400);
        let left = round3(line.sentQty - keepQty);
        takenOff = left;
        // Newest piece first, so what stays on the transfer is the oldest stock.
        for (let i = line.batches.length - 1; i >= 0 && left > 0; i -= 1) {
          const b = line.batches[i];
          const row = await StockInventoryItemModel.findById(b.inventoryItemId).session(session);
          if (!onThisTransfer(row, transfer)) throw new AppError(`Invalid: ${line.productName} is no longer on this transfer`, 400);
          const take = round3(Math.min(left, b.quantity));
          if (take >= b.quantity) {
            backToStock(row, take);
            await row.save({ session });
            line.batches.splice(i, 1);
          } else {
            const piece = await splitBatch(row, take, { status: ITEM_STATUS.AVAILABLE, transit: null }, session);
            backToStock(piece, take);
            await piece.save({ session });
            b.quantity = round3(b.quantity - take);
          }
          left = round3(left - take);
        }
        line.sentQty = keepQty;
      }

      if (takenOff > 0) {
        removed.push({ productName: line.productName, unit: line.unit, quantity: takenOff, labels });
        if (line.requestLineId) {
          const k = String(line.requestLineId);
          removedByRequestLine.set(k, round3((removedByRequestLine.get(k) || 0) + takenOff));
        }
      }
    }

    transfer.lines = transfer.lines.filter((l) => l.sentQty > 0);
    if (!transfer.lines.length) throw new AppError("Invalid: at least one item must stay on the transfer", 400);

    transfer.problemNote = "";
    transfer.history.push({ type: TRANSFER_EVENT.CORRECTED, note, removed, by: user?._id || null, byName: user?.name || "", at: now });
    await transfer.save({ session });
    if (movements.length) await StockItemMovementService.record(movements, session);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: transfer._id, action: "CORRECT", actor: user, before, after: transfer.toObject(),
    });
    return { transfer, removedByRequestLine };
  }
}
