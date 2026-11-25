import mongoose from "mongoose";
import StockLostEntryModel from "../models/stock.lost.entry.model.js";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockBranchModel from "../models/stock.branch.model.js";
import StockItemMovementService from "./stock.item.movement.service.js";
import { splitBatch } from "./stock.transfer.service.js";
import { actorSnapshot } from "../models/plugins/actor.stamp.plugin.js";
import { applyDataScope, isWithinDataScope } from "../helpers/data.scope.helper.js";
import { nextDocumentNumber } from "../helpers/document.number.helper.js";
import { paginate } from "../helpers/pagination.helper.js";
import { AppError } from "../helpers/response.helper.js";
import {
  ITEM_STATUS,
  ITEM_APPROVAL_STATUS,
  ITEM_MOVEMENT_TYPE,
  ITEM_MOVEMENT_REF,
  ITEM_LOCK_TYPE,
  TRACKING_METHODS,
  ASSIGNEE_KIND,
  LOST_REASON,
  LOST_ENTRY_TYPE,
  LOST_ENTRY_STATUS,
  LOST_ENTRY_STATUS_ARRAY,
  WORKING_STATE,
} from "../constants/stock.enums.js";

/*
  Lost Items and Dead Items — see models/stock.lost.entry.model.js.

  Two families, each with two modules:
    lost  LOST / FOUND entries   lost-items (READ, CREATE) · lost-approval (READ, APPROVE)
    dead  DEAD entries           dead-items (READ, CREATE) · dead-approval (READ, APPROVE)

  A LOST entry can name any unit we still hold: in the store (AVAILABLE),
  with a subscriber or an employee (ASSIGNED), FAULTY or IN_REPAIR. Not
  IN_TRANSIT — a short delivery is the transfer's to settle. A FOUND entry
  names units that are LOST and says how each turned up (Working / Faulty).
  A DEAD entry names units in the store — AVAILABLE or FAULTY — and, once
  approved, writes them off (SCRAPPED). It is the only way a unit dies:
  returns, Opening Stock and repairs bring a dead unit in as Faulty.
*/

export const FAMILY = {
  lost: { items: "lost-items", approval: "lost-approval", types: [LOST_ENTRY_TYPE.LOST, LOST_ENTRY_TYPE.FOUND] },
  dead: { items: "dead-items", approval: "dead-approval", types: [LOST_ENTRY_TYPE.DEAD] },
};
export const familyOf = (type) => (type === LOST_ENTRY_TYPE.DEAD ? "dead" : "lost");
const moduleOf = (family, side) => FAMILY[family]?.[side] || FAMILY.lost[side];
const LOSABLE = [ITEM_STATUS.AVAILABLE, ITEM_STATUS.ASSIGNED, ITEM_STATUS.FAULTY, ITEM_STATUS.IN_REPAIR];
const DEADABLE = [ITEM_STATUS.AVAILABLE, ITEM_STATUS.FAULTY];
// A found unit comes back working or faulty — never straight to dead.
const FOUND_STATES = [WORKING_STATE.WORKING, WORKING_STATE.FAULTY];
const pickable = (type) => (type === LOST_ENTRY_TYPE.FOUND ? [ITEM_STATUS.LOST] : type === LOST_ENTRY_TYPE.DEAD ? DEADABLE : LOSABLE);
const text = (v, max = 500) => (v === undefined || v === null ? "" : String(v).trim().slice(0, max));
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const oid = (v) => new mongoose.Types.ObjectId(String(v));

const labelOf = (item) => {
  const ids = (item.identifiers || []).map((k) => k.slice(k.indexOf(":") + 1));
  if (ids.length) return ids.join(" / ");
  const vals = Object.values(item.fieldValues || {}).filter((v) => v !== null && v !== undefined && v !== "");
  return vals.length ? vals.join(" / ") : String(item._id).slice(-6).toUpperCase();
};

// Who has it, as a snapshot — and the reason that follows from it.
const holderOf = (item) => {
  const a = item.assignedTo;
  if (item.status !== ITEM_STATUS.ASSIGNED || !a) return { kind: "STORE", name: "", code: "", orderId: "", requestNumber: "", subscriberId: null };
  if (a.kind === ASSIGNEE_KIND.EMPLOYEE)
    return { kind: ASSIGNEE_KIND.EMPLOYEE, name: a.employeeName || "", code: a.employeeCode || "", orderId: "", requestNumber: "", subscriberId: null };
  return { kind: ASSIGNEE_KIND.SUBSCRIBER, name: a.username || "", code: "", orderId: a.orderId || "", requestNumber: a.requestNumber || "", subscriberId: a.subscriberId || null };
};
const reasonOf = (holder) => (holder.kind === ASSIGNEE_KIND.EMPLOYEE ? LOST_REASON.EMPLOYEE : holder.kind === ASSIGNEE_KIND.SUBSCRIBER ? LOST_REASON.SUBSCRIBER : LOST_REASON.STORE);
export const holderText = (h = {}) =>
  h.kind === ASSIGNEE_KIND.EMPLOYEE ? `${h.name}${h.code ? ` (${h.code})` : ""}`
    : h.kind === ASSIGNEE_KIND.SUBSCRIBER ? [h.name, h.orderId].filter(Boolean).join(" · ")
      : "Store";

// A batch "source": the store, or one subscriber's / employee's share.
const sourceKey = (status, holder) => [status, holder.kind, holder.subscriberId || "", holder.code || "", holder.orderId || ""].join("|");
const sourceMatch = (line, branchId) => {
  const h = line.holder || {};
  const m = { productDefinitionId: line.productDefinitionId, branchId, isActive: true, quantity: { $gt: 0 }, status: line.fromStatus };
  if (line.fromStatus === ITEM_STATUS.ASSIGNED) {
    m["assignedTo.kind"] = h.kind;
    if (h.kind === ASSIGNEE_KIND.EMPLOYEE) m["assignedTo.employeeCode"] = h.code;
    else {
      m["assignedTo.subscriberId"] = h.subscriberId || null;
      if (h.orderId) m["assignedTo.orderId"] = h.orderId;
    }
  }
  return m;
};

const NOTE_NEEDED = { LOST: "Say how it was lost", FOUND: "Say where it was found", DEAD: "Say why it is dead" };

const POPULATE = [
  { path: "branchId", select: "name code" },
  { path: "createdBy.branchId", model: "branches", select: "name" },
  { path: "decidedBy.branchId", model: "branches", select: "name" },
];

export default class StockLostEntryService {
  /* ---------------------------------------------------------------------- */
  /* Reads                                                                  */
  /* ---------------------------------------------------------------------- */

  // family lost | dead, side items | approval.
  static async list(query, dataAccess, family, side) {
    const moduleKey = moduleOf(family, side);
    const types = FAMILY[family].types;
    const { skip, limit } = paginate(query);
    const base = { isActive: true, type: types.includes(query.type) ? query.type : { $in: types } };
    if (query.branchId && mongoose.isValidObjectId(query.branchId)) base.branchId = oid(query.branchId);
    if (query.from || query.to) {
      base.createdAt = {};
      if (query.from) base.createdAt.$gte = new Date(query.from);
      if (query.to) { const d = new Date(query.to); d.setHours(23, 59, 59, 999); base.createdAt.$lte = d; }
    }
    if (query.search && String(query.search).trim()) {
      const rx = { $regex: escapeRegex(String(query.search).trim()), $options: "i" };
      base.$or = [{ entryNumber: rx }, { "lines.label": rx }, { "lines.productName": rx }];
    }
    applyDataScope(base, dataAccess, moduleKey);
    const filter = LOST_ENTRY_STATUS_ARRAY.includes(query.status) ? { ...base, status: query.status } : base;

    const [rows, total, byStatus] = await Promise.all([
      StockLostEntryModel.find(filter).populate(POPULATE).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      StockLostEntryModel.countDocuments(filter),
      StockLostEntryModel.aggregate([{ $match: StockLostEntryModel.find(base).cast() }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    const counts = Object.fromEntries(LOST_ENTRY_STATUS_ARRAY.map((s) => [s, 0]));
    byStatus.forEach((c) => { counts[c._id] = c.n; });
    counts.ALL = LOST_ENTRY_STATUS_ARRAY.reduce((s, k) => s + counts[k], 0);
    return { data: rows.map(StockLostEntryService._summary), total, counts };
  }

  // A row of the list: what it holds, without every line.
  static _summary(e) {
    const products = new Map();
    for (const l of e.lines || []) {
      const p = products.get(String(l.productDefinitionId)) || { productDefinitionId: l.productDefinitionId, name: l.productName, unit: l.unit, quantity: 0 };
      p.quantity = round3(p.quantity + (l.trackingMethod === TRACKING_METHODS.INDIVIDUAL ? 1 : Number(l.quantity) || 0));
      products.set(String(l.productDefinitionId), p);
    }
    const byUnit = new Map();
    for (const p of products.values()) byUnit.set(p.unit || "pieces", round3((byUnit.get(p.unit || "pieces") || 0) + p.quantity));
    const { lines, history, ...rest } = e; // eslint-disable-line no-unused-vars
    return {
      ...rest,
      products: [...products.values()],
      quantity: [...byUnit.entries()].map(([unit, quantity]) => ({ unit, quantity })),
      lineCount: (lines || []).length,
    };
  }

  static async getById(id, dataAccess, family, side) {
    if (!mongoose.isValidObjectId(id)) throw new Error("Entry not found");
    const entry = await StockLostEntryModel.findOne({ _id: id, isActive: true, type: { $in: FAMILY[family].types } }).populate(POPULATE).lean();
    if (!entry || !isWithinDataScope({ ...entry, branchId: entry.branchId?._id || entry.branchId }, dataAccess, moduleOf(family, side))) throw new Error("Entry not found");
    return entry;
  }

  /*
    Units to pick for one product at one branch, by serial / MAC search.
      LOST   anything we still hold (store, subscriber, employee, faulty, in
             repair) that no other pending entry has locked
      FOUND  units that are LOST
    entryId: the entry being edited — its own locked units stay pickable.
  */
  static async unitOptions({ branchId, productDefinitionId, type, search, entryId }, dataAccess) {
    if (!mongoose.isValidObjectId(branchId) || !mongoose.isValidObjectId(productDefinitionId)) return [];
    const filter = { isActive: true, approvalStatus: ITEM_APPROVAL_STATUS.APPROVED, branchId: oid(branchId), productDefinitionId: oid(productDefinitionId), quantity: null };
    filter.status = { $in: pickable(type) };
    filter.$or = [{ lock: null }, ...(mongoose.isValidObjectId(entryId) ? [{ "lock.refId": oid(entryId) }] : [])];
    if (search && String(search).trim()) filter.identifiers = { $regex: escapeRegex(String(search).trim().toUpperCase()) };
    applyDataScope(filter, dataAccess, moduleOf(familyOf(type), "items"));
    const rows = await StockInventoryItemModel.find(filter).sort({ updatedAt: -1 }).limit(50).lean();
    return rows.map((it) => {
      const holder = holderOf(it);
      return {
        _id: it._id,
        label: labelOf(it),
        fieldValues: it.fieldValues || {},
        status: it.status,
        holder,
        holderText: holderText(holder),
        reason: reasonOf(holder),
        lostEntryNumber: it.lost?.entryNumber || "",
        lostAt: it.lost?.at || null,
      };
    });
  }

  // Batch stock of one product at one branch, by where it is (store / each
  // subscriber's / employee's share) — or, for FOUND, by the Lost entry.
  static async batchSources({ branchId, productDefinitionId, type }, dataAccess) {
    if (!mongoose.isValidObjectId(branchId) || !mongoose.isValidObjectId(productDefinitionId)) return [];
    const filter = { isActive: true, approvalStatus: ITEM_APPROVAL_STATUS.APPROVED, branchId: oid(branchId), productDefinitionId: oid(productDefinitionId), quantity: { $gt: 0 } };
    filter.status = type === LOST_ENTRY_TYPE.FOUND ? ITEM_STATUS.LOST : { $in: type === LOST_ENTRY_TYPE.DEAD ? DEADABLE : [ITEM_STATUS.AVAILABLE, ITEM_STATUS.ASSIGNED, ITEM_STATUS.FAULTY] };
    applyDataScope(filter, dataAccess, moduleOf(familyOf(type), "items"));
    const rows = await StockInventoryItemModel.find(filter).select("status assignedTo quantity lost").lean();
    const groups = new Map();
    for (const it of rows) {
      const holder = holderOf(it);
      const key = type === LOST_ENTRY_TYPE.FOUND ? `LOST|${it.lost?.entryNumber || ""}` : sourceKey(it.status, holder);
      const g = groups.get(key) || {
        key, status: it.status, holder, holderText: holderText(holder), reason: reasonOf(holder),
        lostEntryNumber: it.lost?.entryNumber || "", quantity: 0,
      };
      g.quantity = round3(g.quantity + it.quantity);
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => (a.holder.kind === "STORE" ? -1 : b.holder.kind === "STORE" ? 1 : a.holderText.localeCompare(b.holderText)));
  }

  /* ---------------------------------------------------------------------- */
  /* Make / fix an entry                                                    */
  /* ---------------------------------------------------------------------- */

  /*
    body: { type, branchId, note, lines: [...] }
      individual line: { inventoryItemId, foundState?, foundNote? }
      batch line:      { productDefinitionId, sourceKey, quantity, foundState?, foundNote? }
    sourceKey comes from batchSources().
  */
  static async create(body, user, session, dataAccess, family) {
    const type = String(body?.type || "").toUpperCase();
    if (!FAMILY[family].types.includes(type)) throw new AppError(`Invalid: type must be ${FAMILY[family].types.join(" or ")}`, 400);
    const branchId = await StockLostEntryService._branch(body?.branchId, dataAccess, session, moduleOf(family, "items"));
    const note = text(body?.note);
    if (!note) throw new AppError(NOTE_NEEDED[type], 400);
    const lines = await StockLostEntryService._lines(type, branchId, body?.lines, null, session, dataAccess);

    const entryNumber = await nextDocumentNumber({ model: StockLostEntryModel, field: "entryNumber", prefix: type === LOST_ENTRY_TYPE.DEAD ? "DED" : "LST", session });
    const now = new Date();
    const [entry] = await StockLostEntryModel.create(
      [{ entryNumber, type, branchId, note, lines, status: LOST_ENTRY_STATUS.PENDING, submittedAt: now, createdBy: actorSnapshot(user), history: [{ action: "CREATED", at: now, by: actorSnapshot(user) }] }],
      { session }
    );
    await StockLostEntryService._lock(entry, session);
    return entry.toObject();
  }

  // Only a REJECTED entry, only by whoever made it — then it waits again.
  static async update(id, body, user, session, dataAccess, family) {
    const entry = await StockLostEntryService._load(id, session, dataAccess, family, "items");
    if (entry.status !== LOST_ENTRY_STATUS.REJECTED) throw new AppError("Invalid: only a rejected entry can be edited", 400);
    const me = String(user?._id || user?.id || "");
    if (!me || String(entry.createdBy?.userId || "") !== me) throw new AppError("Invalid: only the person who made this entry can edit it", 403);

    const branchId = await StockLostEntryService._branch(body?.branchId || entry.branchId, dataAccess, session, moduleOf(family, "items"));
    const note = text(body?.note);
    if (!note) throw new AppError(NOTE_NEEDED[entry.type], 400);
    const lines = await StockLostEntryService._lines(entry.type, branchId, body?.lines, entry._id, session, dataAccess);

    await StockLostEntryService._unlock(entry, session);
    const now = new Date();
    entry.branchId = branchId;
    entry.note = note;
    entry.lines = lines;
    entry.status = LOST_ENTRY_STATUS.PENDING;
    entry.submittedAt = now;
    entry.rejectReason = "";
    entry.decidedAt = null;
    entry.decidedBy = null;
    entry.history.push({ action: "RESUBMITTED", at: now, by: actorSnapshot(user) });
    await entry.save({ session });
    await StockLostEntryService._lock(entry, session);
    return entry.toObject();
  }

  static async _branch(branchId, dataAccess, session, moduleKey) {
    if (!branchId || !mongoose.isValidObjectId(branchId)) throw new AppError("Choose the branch", 400);
    const branch = await StockBranchModel.findOne({ _id: branchId, isActive: true }).select("_id").session(session).lean();
    if (!branch || !isWithinDataScope({ branchId: branch._id }, dataAccess, moduleKey)) throw new AppError("Invalid branch selected", 400);
    return branch._id;
  }

  static async _lines(type, branchId, input, entryId, session, dataAccess) {
    if (!Array.isArray(input) || !input.length) throw new AppError(`Add at least one ${type.toLowerCase()} unit`, 400);
    if (input.length > 200) throw new AppError("Invalid: at most 200 lines in one entry", 400);
    const found = type === LOST_ENTRY_TYPE.FOUND;
    const dead = type === LOST_ENTRY_TYPE.DEAD;
    const allowed = pickable(type);
    const itemsModule = moduleOf(familyOf(type), "items");
    const seen = new Set();
    const out = [];

    const foundFields = (l, label) => {
      if (!found) return {};
      const foundState = String(l.foundState || "").toUpperCase();
      if (!FOUND_STATES.includes(foundState)) throw new AppError(`${label}: say how it was found — Working or Faulty (a dead one is reported on Dead Items)`, 400);
      const foundNote = text(l.foundNote);
      if (foundState !== WORKING_STATE.WORKING && !foundNote) throw new AppError(`${label}: say what is wrong with it`, 400);
      return { foundState, foundNote };
    };

    for (const l of input) {
      if (l?.inventoryItemId) {
        if (!mongoose.isValidObjectId(l.inventoryItemId)) throw new AppError("Invalid unit selected", 400);
        const key = String(l.inventoryItemId);
        if (seen.has(key)) throw new AppError("Invalid: the same unit is on the entry twice", 400);
        seen.add(key);
        const item = await StockInventoryItemModel.findOne({ _id: l.inventoryItemId, isActive: true }).session(session).lean();
        if (!item || !isWithinDataScope(item, dataAccess, itemsModule)) throw new Error("Inventory item not found");
        const label = labelOf(item);
        if (String(item.branchId) !== String(branchId)) throw new AppError(`Invalid: ${label} is not at this branch`, 400);
        if (item.quantity !== null && item.quantity !== undefined) throw new AppError(`Invalid: ${label} is batch stock — enter a quantity instead`, 400);
        if (item.lock && String(item.lock.refId) !== String(entryId || "")) throw new AppError(`Invalid: ${label} is already on pending entry ${item.lock.refNumber}`, 409);
        if (!allowed.includes(item.status))
          throw new AppError(`Invalid: ${label} is ${String(item.status).toLowerCase().replace(/_/g, " ")} — it cannot be ${found ? "found" : dead ? "reported dead (only units in the store)" : "reported lost"}`, 400);
        const def = await StockProductDefinitionModel.findById(item.productDefinitionId).select("name trackingMethod unit").session(session).lean();
        const holder = found || dead ? { kind: "STORE" } : holderOf(item);
        out.push({
          productDefinitionId: item.productDefinitionId,
          productName: def?.name || "",
          trackingMethod: TRACKING_METHODS.INDIVIDUAL,
          unit: def?.unit || null,
          inventoryItemId: item._id,
          label,
          fromStatus: item.status,
          holder,
          reason: found || dead ? null : reasonOf(holder),
          lostEntryNumber: found ? item.lost?.entryNumber || "" : "",
          deadNote: dead ? text(l.deadNote) : "",
          ...foundFields(l, label),
        });
        continue;
      }

      // Batch
      if (!mongoose.isValidObjectId(l?.productDefinitionId)) throw new AppError("Invalid product selected", 400);
      const def = await StockProductDefinitionModel.findOne({ _id: l.productDefinitionId }).select("name trackingMethod unit").session(session).lean();
      if (!def || def.trackingMethod !== TRACKING_METHODS.QUANTITY) throw new AppError("Invalid: choose a unit for this product — it is tracked one by one", 400);
      const qty = round3(Number(l.quantity));
      if (!(qty > 0)) throw new AppError(`${def.name}: enter how much`, 400);
      const sources = await StockLostEntryService.batchSources({ branchId, productDefinitionId: def._id, type }, dataAccess);
      const src = sources.find((s) => s.key === l.sourceKey);
      if (!src) throw new AppError(`${def.name}: choose where it was`, 400);
      const key = `${def._id}|${src.key}`;
      if (seen.has(key)) throw new AppError(`Invalid: ${def.name} from ${src.holderText} is on the entry twice`, 400);
      seen.add(key);
      if (qty > src.quantity) throw new AppError(`${def.name}: only ${src.quantity} at ${src.holderText}`, 400);
      out.push({
        productDefinitionId: def._id,
        productName: def.name,
        trackingMethod: TRACKING_METHODS.QUANTITY,
        unit: def.unit || null,
        inventoryItemId: null,
        label: src.holderText,
        quantity: qty,
        fromStatus: src.status,
        holder: src.holder,
        reason: found || dead ? null : src.reason,
        lostEntryNumber: src.lostEntryNumber || "",
        deadNote: dead ? text(l.deadNote) : "",
        ...foundFields(l, def.name),
      });
    }
    return out;
  }

  // Hold every unit on the entry still; fail if another entry got one first.
  static async _lock(entry, session) {
    const ids = entry.lines.filter((l) => l.inventoryItemId).map((l) => l.inventoryItemId);
    if (!ids.length) return;
    const res = await StockInventoryItemModel.updateMany(
      { _id: { $in: ids }, lock: null },
      { $set: { lock: { type: ITEM_LOCK_TYPE.LOST_ENTRY, refId: entry._id, refNumber: entry.entryNumber, at: new Date() } } },
      { session }
    );
    if (res.modifiedCount !== ids.length) throw new AppError("Invalid: a unit on this entry was just put on another entry — refresh", 409);
  }

  static async _unlock(entry, session) {
    await StockInventoryItemModel.updateMany({ "lock.refId": entry._id }, { $set: { lock: null } }, { session });
  }

  static async _load(id, session, dataAccess, family, side) {
    if (!mongoose.isValidObjectId(id)) throw new Error("Entry not found");
    const entry = await StockLostEntryModel.findOne({ _id: id, isActive: true, type: { $in: FAMILY[family].types } }).session(session);
    if (!entry || !isWithinDataScope(entry, dataAccess, moduleOf(family, side))) throw new Error("Entry not found");
    return entry;
  }

  /* ---------------------------------------------------------------------- */
  /* Decide                                                                 */
  /* ---------------------------------------------------------------------- */

  static async reject(id, body, user, session, dataAccess, family) {
    const reason = text(body?.reason);
    if (!reason) throw new AppError("Say why it is rejected", 400);
    const entry = await StockLostEntryService._load(id, session, dataAccess, family, "approval");
    if (entry.status !== LOST_ENTRY_STATUS.PENDING) throw new AppError("Invalid: this entry is not waiting for approval", 400);
    const now = new Date();
    entry.status = LOST_ENTRY_STATUS.REJECTED;
    entry.rejectReason = reason;
    entry.decidedAt = now;
    entry.decidedBy = actorSnapshot(user);
    entry.history.push({ action: "REJECTED", at: now, by: actorSnapshot(user), note: reason });
    await entry.save({ session });
    await StockLostEntryService._unlock(entry, session);
    return entry.toObject();
  }

  // The whole entry, or nothing (one transaction).
  static async approve(id, body, user, session, dataAccess, family) {
    const entry = await StockLostEntryService._load(id, session, dataAccess, family, "approval");
    if (entry.status !== LOST_ENTRY_STATUS.PENDING) throw new AppError("Invalid: this entry is not waiting for approval", 400);
    const now = new Date();
    const found = entry.type === LOST_ENTRY_TYPE.FOUND;
    const dead = entry.type === LOST_ENTRY_TYPE.DEAD;
    const ref = { type: ITEM_MOVEMENT_REF.LOST_ENTRY, refId: entry._id, refNumber: entry.entryNumber };
    const moveType = dead ? ITEM_MOVEMENT_TYPE.SCRAPPED : found ? ITEM_MOVEMENT_TYPE.FOUND : ITEM_MOVEMENT_TYPE.LOST;
    const deadFields = (line) => ({ status: ITEM_STATUS.SCRAPPED, scrapNote: line.deadNote || entry.note, repair: null, lock: null });
    const moves = [];

    const lostFields = (line) => ({
      status: ITEM_STATUS.LOST,
      lost: { reason: line.reason, note: entry.note, at: now, holder: holderText(line.holder), entryId: entry._id, entryNumber: entry.entryNumber },
      assignedTo: null,
      repair: null,
      lock: null,
    });
    const foundFields = (line) => {
      const base = { lost: null, lock: null };
      if (line.foundState === WORKING_STATE.WORKING) return { ...base, status: ITEM_STATUS.AVAILABLE };
      if (line.foundState === WORKING_STATE.FAULTY)
        return { ...base, status: ITEM_STATUS.FAULTY, fault: { reportedAt: now, note: line.foundNote, via: `Found (${entry.entryNumber})`, requestNumber: "" } };
      return { ...base, status: ITEM_STATUS.SCRAPPED, scrapNote: line.foundNote };
    };
    const moveNote = (line) =>
      dead
        ? `Dead (${entry.entryNumber}) — ${line.deadNote || entry.note}`
        : found
        ? `Found (${entry.entryNumber}) — ${line.foundState === WORKING_STATE.WORKING ? "working" : line.foundState === WORKING_STATE.FAULTY ? `faulty: ${line.foundNote}` : `dead: ${line.foundNote}`}`
        : `Lost (${entry.entryNumber}) — ${holderText(line.holder)}: ${entry.note}`;

    for (const line of entry.lines) {
      const set = dead ? deadFields(line) : found ? foundFields(line) : lostFields(line);
      if (line.inventoryItemId) {
        const item = await StockInventoryItemModel.findOne({ _id: line.inventoryItemId, isActive: true }).session(session);
        if (!item || String(item.lock?.refId || "") !== String(entry._id))
          throw new AppError(`Invalid: ${line.label} is no longer held for this entry — reject it and make it again`, 409);
        Object.assign(item, set);
        await item.save({ session });
        moves.push({ inventoryItemId: item._id, productDefinitionId: item.productDefinitionId, type: moveType, at: now, status: item.status, ref, note: moveNote(line) });
        continue;
      }

      // Batch: draw the quantity from where it was, oldest first.
      const match = found
        ? { productDefinitionId: line.productDefinitionId, branchId: entry.branchId, isActive: true, quantity: { $gt: 0 }, status: ITEM_STATUS.LOST, "lost.entryNumber": line.lostEntryNumber }
        : sourceMatch(line, entry.branchId);
      const rows = await StockInventoryItemModel.find(match).sort({ receivedAt: 1, createdAt: 1 }).session(session);
      const have = round3(rows.reduce((s, r) => s + r.quantity, 0));
      if (have < line.quantity) throw new AppError(`Invalid: only ${have} of ${line.productName} left at ${line.label} — reject it and make it again`, 409);
      let need = line.quantity;
      for (const row of rows) {
        if (need <= 0) break;
        const take = round3(Math.min(row.quantity, need));
        let piece;
        if (take === row.quantity) {
          Object.assign(row, set);
          await row.save({ session });
          piece = row;
        } else {
          piece = await splitBatch(row, take, set, session);
        }
        need = round3(need - take);
        moves.push({ inventoryItemId: piece._id, productDefinitionId: piece.productDefinitionId, type: moveType, at: now, quantity: take, status: piece.status, ref, relatedItemId: piece === row ? null : row._id, note: moveNote(line) });
      }
    }

    await StockItemMovementService.record(moves, session);
    entry.status = LOST_ENTRY_STATUS.APPROVED;
    entry.decidedAt = now;
    entry.decidedBy = actorSnapshot(user);
    entry.rejectReason = "";
    entry.history.push({ action: "APPROVED", at: now, by: actorSnapshot(user), note: text(body?.note) });
    await entry.save({ session });
    return entry.toObject();
  }
}
