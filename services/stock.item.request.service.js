import mongoose from "mongoose";
import StockItemRequestModel, { OPEN_REQUEST_STATUSES } from "../models/stock.item.request.model.js";
import StockSubscriberModel from "../models/stock.subscriber.model.js";
import StockCategoryModel from "../models/stock.category.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockBranchModel from "../models/stock.branch.model.js";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import StockCategoryService from "./stock.category.service.js";
import StockItemMovementService from "./stock.item.movement.service.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import { nextDocumentNumber } from "../helpers/document.number.helper.js";
import { applyDataScope, isWithinDataScope } from "../helpers/data.scope.helper.js";
import { paginate } from "../helpers/pagination.helper.js";
import { AppError } from "../helpers/response.helper.js";
import { readReturnState, landedFields, returnStateLabel, legacyCondition } from "../helpers/return.state.helper.js";
import {
  TRACKING_METHODS,
  CATEGORY_TYPES,
  ITEM_STATUS,
  ITEM_APPROVAL_STATUS,
  ITEM_MOVEMENT_TYPE,
  ITEM_MOVEMENT_REF,
  ITEM_REQUEST_STATUS,
  ITEM_REQUEST_STATUS_ARRAY,
  ITEM_REQUEST_LINE_STATUS,
  ITEM_REQUEST_CHANNEL_ARRAY,
  ITEM_REQUEST_TYPE,
  ITEM_REQUEST_TYPE_ARRAY,
  RETURN_REASON,
  REPLACE_REASON,
} from "../constants/stock.enums.js";

/*
  Item Requests — stock issued to subscribers.

  A request asks for one or more CATEGORIES, each with a quantity — its lines
  ("2 × ONT / Single Band", "100 m × Drop Cable"). Which product goes out is
  the store's call, and a line may be filled from several products of its
  category. Each line is filled — or closed short — on its own; the request's
  status follows from its lines.

  Two sides, one service:

    Requester (the NOC / broadband website through the external API, or the
    test simulator): reads the catalog, sends a request, watches it, and resends
    it if the store rejected it. Every requester call carries its CHANNEL, and a
    channel only ever sees its own requests.

    Store (this app, branch-scoped like the rest of stock): issues units —
    for any lines, partially if need be — closes a line it cannot fill,
    short-closes everything left, or rejects.

  Issuing is the step that moves stock: chosen units (or metres off batches)
  leave AVAILABLE for ASSIGNED, carry the subscriber on `assignedTo`, and get an
  ISSUED row on their timeline — all in the caller's transaction.
*/

const MODULE_KEY = "item-requests";
const ENTITY_TYPE = "item-requests";
const TEXT_MAX = 300;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const text = (v, max = TEXT_MAX) => (v === undefined || v === null ? "" : String(v).trim().slice(0, max));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

const personOf = (user) => ({
  userId: user?._id || user?.id || null,
  employeeCode: user?.employeeCode || "",
  name: user?.name || "",
});

const assertDataScope = (request, dataAccess) => {
  if (!isWithinDataScope(request, dataAccess, MODULE_KEY)) throw new Error("Item request not found");
};

const assertChannel = (channel) => {
  if (!ITEM_REQUEST_CHANNEL_ARRAY.includes(channel)) throw new Error(`Unknown request channel: ${channel}`);
};

// The website's extra subscriber columns, kept as plain text values. Anything
// nested is dropped rather than stored as an opaque blob nobody can show.
const cleanExtraFields = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw).slice(0, 50)) {
    const key = text(k, 60);
    if (!key || v === null || v === undefined || typeof v === "object") continue;
    out[key] = text(v, 500);
  }
  return out;
};

// How a unit is named on the request: its serial / MAC values, else whatever
// fields it has.
const unitLabel = (item) => {
  const ids = (item.identifiers || []).map((k) => k.slice(k.indexOf(":") + 1));
  if (ids.length) return ids.join(" / ");
  const vals = Object.values(item.fieldValues || {}).filter((v) => v !== null && v !== undefined && v !== "");
  return vals.length ? vals.join(" / ") : String(item._id).slice(-6).toUpperCase();
};

// Free stock at a branch: individual units counted, batches summed.
const FREE = { isActive: true, status: ITEM_STATUS.AVAILABLE, approvalStatus: ITEM_APPROVAL_STATUS.APPROVED };

const MAX_RETURN_ITEMS = 100;
const MAX_REQUEST_LINES = 20;
const hasIssueSide = (type) => type === ITEM_REQUEST_TYPE.ISSUE || type === ITEM_REQUEST_TYPE.REPLACE;
const hasReturnSide = (type) => type === ITEM_REQUEST_TYPE.RETURN || type === ITEM_REQUEST_TYPE.REPLACE;

// What a line still owes — nothing once it is closed.
const lineRemaining = (l) => (l.closure ? 0 : round3(Math.max(0, (l.requestedQty || 0) - (l.issuedQty || 0))));
const lineClosedShort = (l) => !!l.closure && (l.issuedQty || 0) < (l.requestedQty || 0);
const lineStatusOf = (l) =>
  lineClosedShort(l)
    ? ITEM_REQUEST_LINE_STATUS.CLOSED
    : (l.issuedQty || 0) >= (l.requestedQty || 0)
      ? ITEM_REQUEST_LINE_STATUS.DONE
      : (l.issuedQty || 0) > 0
        ? ITEM_REQUEST_LINE_STATUS.PARTIAL
        : ITEM_REQUEST_LINE_STATUS.PENDING;
// "3" / "50 meter" — for history notes.
const qtyLabel = (l, n) => `${round3(n)}${l.trackingMethod === TRACKING_METHODS.QUANTITY && l.unit ? ` ${l.unit}` : ""}`;

/*
  Where a request stands, from what has moved on each half it has. Settled =
  every outgoing line given in full or closed, and (for a return) everything
  back: then COMPLETED, or PARTIALLY_CLOSED if a line was closed short.
  Otherwise PARTIAL once anything has moved, PENDING before.
*/
const progressStatus = (r) => {
  const lines = hasIssueSide(r.type) ? r.lines || [] : [];
  const issueSettled = lines.every((l) => lineRemaining(l) <= 0);
  // A replace row is settled once its new item is out (which needs the old
  // one back first) or the row is closed — so its lines say it all.
  const returnDone = r.type !== ITEM_REQUEST_TYPE.RETURN || r.returnReceivedQty >= r.returnRequestedQty;
  if (issueSettled && returnDone)
    return lines.some(lineClosedShort) ? ITEM_REQUEST_STATUS.PARTIALLY_CLOSED : ITEM_REQUEST_STATUS.COMPLETED;
  // A replace is under way only once something is swapped: old back AND new
  // out. Old items merely received still leave it PENDING.
  const moved = r.type === ITEM_REQUEST_TYPE.REPLACE ? (r.issuedQty || 0) > 0 : (r.issuedQty || 0) > 0 || (r.returnReceivedQty || 0) > 0;
  return moved ? ITEM_REQUEST_STATUS.PARTIAL : ITEM_REQUEST_STATUS.PENDING;
};

// Has any stock moved on it at all — the line between reject and close.
const anythingMoved = (r) => (r.issuedQty || 0) > 0 || (r.returnReceivedQty || 0) > 0;

/*
  A REPLACE row: one old item and the new one going out in its place.
    PENDING   nothing back yet
    RECEIVED  old item (or part of it) back, new one still to give
    PARTIAL   part of a batch swapped, more to come back / go out
    REPLACED  new given in full
    CLOSED    closed before it was fully swapped
*/
const SWAP_STATUS = { PENDING: "PENDING", RECEIVED: "RECEIVED", PARTIAL: "PARTIAL", REPLACED: "REPLACED", CLOSED: "CLOSED" };
const swapStatusOf = (line, rl) => {
  if ((line.issuedQty || 0) >= (line.requestedQty || 0)) return SWAP_STATUS.REPLACED;
  if (line.closure) return SWAP_STATUS.CLOSED;
  if ((rl?.receivedQty || 0) > (line.issuedQty || 0)) return SWAP_STATUS.RECEIVED;
  return (line.issuedQty || 0) > 0 ? SWAP_STATUS.PARTIAL : SWAP_STATUS.PENDING;
};
// How much a replace line may give right now: what has come back, less what went out.
const swapGivable = (line, rl) => round3(Math.max(0, Math.min(lineRemaining(line), (rl?.receivedQty || 0) - (line.issuedQty || 0))));

const typeOf = (t) => {
  const type = t || ITEM_REQUEST_TYPE.ISSUE;
  if (!ITEM_REQUEST_TYPE_ARRAY.includes(type)) throw new AppError(`Invalid request type: ${t}`, 400);
  return type;
};

// What was handed over, per product, across every visit — for one request
// line when `lineId` is given.
const issuedByProduct = (issues = [], lineId = null) => {
  const map = new Map();
  for (const iss of issues)
    for (const l of iss.lines || []) {
      if (lineId && String(l.requestLineId) !== String(lineId)) continue;
      const key = String(l.productDefinitionId);
      const row = map.get(key) || { productDefinitionId: l.productDefinitionId, productName: l.productName, quantity: 0 };
      row.quantity = round3(row.quantity + l.quantity);
      map.set(key, row);
    }
  return [...map.values()];
};

export default class StockItemRequestService {
  /* ====================================================================== */
  /* Category kind — what "5" means for a category                          */
  /* ====================================================================== */

  /*
    A category-wide quantity only means something when every active product
    in the category is counted the same way: all individual units, or all
    batches in the same unit. A category mixing pieces and metres cannot be
    requested — "5" would be 5 of what? — until the category is sorted out.

    @returns { products, trackingMethod, unit } or throws.
  */
  static async _categoryKind(categoryId, session = null) {
    const products = await StockProductDefinitionModel.find({ categoryId, isActive: true })
      .select("_id name trackingMethod unit")
      .sort({ name: 1 })
      .session(session)
      .lean();
    if (!products.length) throw new AppError("Invalid category: it has no active products", 400);
    const kinds = new Set(products.map((p) => `${p.trackingMethod}|${p.unit || ""}`));
    if (kinds.size > 1)
      throw new AppError(
        "This category mixes products counted differently (units and metres) — it can't be requested by quantity until its products match",
        400
      );
    return { products, trackingMethod: products[0].trackingMethod, unit: products[0].unit || null };
  }

  /* ====================================================================== */
  /* Catalog — what a requester can pick from                               */
  /* ====================================================================== */

  static async catalogBranches() {
    return StockBranchModel.find({ isActive: true }).select("_id name code city state").sort({ name: 1 }).lean();
  }

  /*
    Leaf categories with active products, by full path, each with what its
    quantity counts (units or metres). `mixed` lists the leaves left out
    because their products are counted differently — the simulator shows them
    as a note; the external API only gets the requestable ones.
  */
  static async _catalog() {
    const rows = await StockProductDefinitionModel.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: "$categoryId", kinds: { $addToSet: { t: "$trackingMethod", u: "$unit" } } } },
    ]);
    const kindByCategory = new Map(rows.map((r) => [String(r._id), r.kinds]));
    const leaves = await StockCategoryModel.find({
      _id: { $in: rows.map((r) => r._id) },
      isActive: true,
      type: CATEGORY_TYPES.LEAF,
    })
      .select("name path")
      .lean();

    const categories = [];
    const mixed = [];
    for (const c of leaves) {
      const kinds = kindByCategory.get(String(c._id)) || [];
      const entry = { _id: c._id, name: c.name, path: await StockCategoryService.buildDisplayPath(c.path) };
      if (kinds.length === 1) categories.push({ ...entry, trackingMethod: kinds[0].t, unit: kinds[0].u || null });
      else mixed.push(entry);
    }
    const byPath = (a, b) => a.path.localeCompare(b.path);
    return { categories: categories.sort(byPath), mixed: mixed.sort(byPath) };
  }

  static async catalogCategories() {
    return (await StockItemRequestService._catalog()).categories;
  }

  // The reasons a requester picks from for a RETURN / REPLACE.
  static catalogReasons() {
    const list = (o) => Object.entries(o).map(([code, label]) => ({ code, label }));
    return { RETURN: list(RETURN_REASON), REPLACE: list(REPLACE_REASON) };
  }

  static async catalogMixedCategories() {
    return (await StockItemRequestService._catalog()).mixed;
  }

  /* ====================================================================== */
  /* Requester side                                                         */
  /* ====================================================================== */

  // The branch stock goes out from (ISSUE) or comes back to (RETURN).
  static async _resolveBranch(body, session) {
    if (!mongoose.isValidObjectId(body?.branchId)) throw new AppError("Branch is required", 400);
    const branch = await StockBranchModel.findOne({ _id: body.branchId, isActive: true }).session(session).lean();
    if (!branch) throw new AppError("Invalid branch selected", 400);
    return branch;
  }

  // A leaf category whose products are all counted the same way.
  static async _resolveLeaf(categoryId, session) {
    if (!mongoose.isValidObjectId(categoryId)) throw new AppError("Category is required", 400);
    const category = await StockCategoryModel.findOne({ _id: categoryId, isActive: true }).session(session).lean();
    if (!category) throw new AppError("Invalid category selected", 400);
    if (category.type !== CATEGORY_TYPES.LEAF) throw new AppError("Invalid category: pick the last level (a leaf category)", 400);
    const { trackingMethod, unit } = await StockItemRequestService._categoryKind(category._id, session);
    return { category, categoryPath: await StockCategoryService.buildDisplayPath(category.path, session), trackingMethod, unit };
  }

  // An outgoing line for `qty` of a leaf category.
  static async _line(categoryId, qty, session, where = "") {
    const leaf = await StockItemRequestService._resolveLeaf(categoryId, session);
    if (leaf.trackingMethod === TRACKING_METHODS.INDIVIDUAL && !Number.isInteger(qty))
      throw new AppError(`${where || leaf.categoryPath}: quantity must be a whole number`, 400);
    return {
      categoryId: leaf.category._id,
      categoryPath: leaf.categoryPath,
      trackingMethod: leaf.trackingMethod,
      unit: leaf.unit,
      requestedQty: round3(qty),
      issuedQty: 0,
      closure: null,
    };
  }

  /*
    ISSUE: body.items — [{ categoryId, quantity }], up to 20. The older single
    form (categoryId + quantity) is one item. The same category twice is one
    line, its quantities added.
  */
  static async _resolveIssueLines(body, session) {
    const inputs = Array.isArray(body?.items)
      ? body.items
      : body?.categoryId !== undefined
        ? [{ categoryId: body.categoryId, quantity: body.quantity }]
        : [];
    if (!inputs.length) throw new AppError("Add at least one item — a category and a quantity", 400);
    const byCategory = new Map();
    inputs.forEach((it, i) => {
      if (!mongoose.isValidObjectId(it?.categoryId)) throw new AppError(`Item ${i + 1}: choose a category`, 400);
      const qty = Number(it.quantity);
      if (!Number.isFinite(qty) || qty <= 0) throw new AppError(`Item ${i + 1}: quantity must be more than 0`, 400);
      const key = String(it.categoryId);
      byCategory.set(key, round3((byCategory.get(key) || 0) + qty));
    });
    if (byCategory.size > MAX_REQUEST_LINES) throw new AppError(`Invalid: at most ${MAX_REQUEST_LINES} items per request`, 400);
    const lines = [];
    for (const [categoryId, qty] of byCategory) lines.push(await StockItemRequestService._line(categoryId, qty, session));
    return lines;
  }

  /*
    RETURN / REPLACE: the things coming back, named from what the subscriber
    holds — body.items: [{ inventoryItemId, quantity? }]. A unit is 1; a batch
    may come back in part (quantity), all of it by default.

    Each must be ASSIGNED to this very subscriber, and not already on another
    open return or replace — two requests for the same router would be
    received twice.
  */
  static async _resolveReturnSide(body, subscriberId, session, excludeRequestId = null) {
    const inputs = Array.isArray(body?.items) ? body.items : [];
    if (!inputs.length) throw new AppError("Choose at least one item to return", 400);
    if (inputs.length > MAX_RETURN_ITEMS) throw new AppError(`Invalid: at most ${MAX_RETURN_ITEMS} items per request`, 400);
    const ids = inputs.map((i) => String(i?.inventoryItemId || ""));
    if (ids.some((id) => !mongoose.isValidObjectId(id))) throw new AppError("Invalid item selected", 400);
    if (new Set(ids).size !== ids.length) throw new AppError("Invalid: an item is listed twice", 400);

    const held = await StockInventoryItemModel.find({
      _id: { $in: ids },
      isActive: true,
      status: ITEM_STATUS.ASSIGNED,
      "assignedTo.subscriberId": subscriberId,
    })
      .populate({ path: "productDefinitionId", select: "name categoryId trackingMethod unit" })
      .session(session)
      .lean();
    if (held.length !== ids.length)
      throw new AppError(`${ids.length - held.length} chosen item(s) are not with this subscriber`, 400);

    // A closed row of a replace no longer claims its item.
    const lockFilter = {
      isActive: true,
      status: { $in: OPEN_REQUEST_STATUSES },
      returnLines: { $elemMatch: { inventoryItemId: { $in: ids.map(oid) }, closure: null } },
    };
    if (excludeRequestId) lockFilter._id = { $ne: excludeRequestId };
    const locked = await StockItemRequestModel.findOne(lockFilter).select("requestNumber").session(session).lean();
    if (locked) throw new AppError(`Some of these items are already on open request ${locked.requestNumber}`, 409);

    const byId = new Map(held.map((h) => [String(h._id), h]));
    const returnLines = inputs.map((input) => {
      const it = byId.get(String(input.inventoryItemId));
      const p = it.productDefinitionId;
      const isUnit = it.quantity === null || it.quantity === undefined;
      let qty = 1;
      if (!isUnit) {
        qty = input.quantity === undefined || input.quantity === null || input.quantity === "" ? it.quantity : round3(Number(input.quantity));
        if (!(qty > 0) || qty > it.quantity) throw new AppError(`${p.name}: return quantity must be between 0 and ${it.quantity}`, 400);
      }
      return {
        _id: new mongoose.Types.ObjectId(), // named up front: a replace line points at it
        inventoryItemId: it._id,
        productDefinitionId: p._id,
        productName: p.name,
        categoryId: p.categoryId,
        trackingMethod: isUnit ? TRACKING_METHODS.INDIVIDUAL : TRACKING_METHODS.QUANTITY,
        unit: p.unit || null,
        label: unitLabel(it),
        requestedQty: qty,
        receivedQty: 0,
        closure: null,
      };
    });
    return { returnLines, returnRequestedQty: round3(returnLines.reduce((s, l) => s + l.requestedQty, 0)) };
  }

  /*
    Why a RETURN / REPLACE is sent — body.reason: a RETURN_REASON /
    REPLACE_REASON key ("CONNECTION_CLOSED"), or { code, note }. Required;
    OTHER needs the note.
  */
  static _resolveReason(type, body) {
    const options = type === ITEM_REQUEST_TYPE.REPLACE ? REPLACE_REASON : RETURN_REASON;
    const raw = body?.reason;
    const code = String((raw && typeof raw === "object" ? raw.code : raw) || "").trim().toUpperCase();
    const note = text(raw && typeof raw === "object" ? raw.note : body?.reasonNote, 500);
    if (!code) throw new AppError(`Choose a reason: ${Object.values(options).join(", ")}`, 400);
    if (!options[code]) throw new AppError(`Invalid reason "${code}" — use one of ${Object.keys(options).join(", ")}`, 400);
    if (code === "OTHER" && !note) throw new AppError("Reason Other: write what it is", 400);
    return { code, note };
  }

  static _reasonLabel(type, reason) {
    if (!reason?.code) return "";
    const label = (type === ITEM_REQUEST_TYPE.REPLACE ? REPLACE_REASON : RETURN_REASON)[reason.code] || reason.code;
    return reason.note ? `${label} — ${reason.note}` : label;
  }

  /*
    Everything a request of `type` carries besides its subscriber, ready to set
    on the document. REPLACE: one outgoing line per item coming back — its
    category, its quantity — so each old item is paired with its new one.
  */
  static async _resolve(type, body, subscriberId, session, excludeRequestId = null) {
    const branch = await StockItemRequestService._resolveBranch(body, session);
    const out = { branchId: branch._id, lines: [], requestedQty: 0, issuedQty: 0, returnLines: [], returnRequestedQty: 0 };
    if (type === ITEM_REQUEST_TYPE.ISSUE) {
      out.lines = await StockItemRequestService._resolveIssueLines(body, session);
      await StockItemRequestService._assertCategoriesNotOpen(subscriberId, branch, out.lines, session, excludeRequestId);
    }
    if (hasReturnSide(type)) {
      out.reason = StockItemRequestService._resolveReason(type, body);
      Object.assign(out, await StockItemRequestService._resolveReturnSide(body, subscriberId, session, excludeRequestId));
    }
    if (type === ITEM_REQUEST_TYPE.REPLACE) {
      if (out.returnLines.length > MAX_REQUEST_LINES) throw new AppError(`Invalid: at most ${MAX_REQUEST_LINES} items per replace`, 400);
      for (const rl of out.returnLines)
        out.lines.push({ ...(await StockItemRequestService._line(rl.categoryId, rl.requestedQty, session, rl.label)), returnLineId: rl._id });
    }
    out.requestedQty = round3(out.lines.reduce((sum, l) => sum + l.requestedQty, 0));
    return out;
  }

  /*
    One ISSUE at a time per category, per subscriber and branch. A category
    cannot be asked for again while it is
      - still owed on an open ISSUE request (its line PENDING or PARTIAL) —
        wait till that line is given in full, closed, or the request settled;
      - on a REJECTED one — edit and resend that request, or withdraw it.
    Another branch, another subscriber or another category is free. The whole
    request is refused, naming each clash, rather than quietly dropping the
    item. REPLACE is left out on purpose for now (to be decided separately).
  */
  static async _assertCategoriesNotOpen(subscriberId, branch, lines, session, excludeRequestId = null) {
    const filter = {
      isActive: true,
      type: { $in: [ITEM_REQUEST_TYPE.ISSUE, null] }, // null: rows from before types existed
      status: { $in: [...OPEN_REQUEST_STATUSES, ITEM_REQUEST_STATUS.REJECTED] },
      subscriberId,
      branchId: branch._id,
      "lines.categoryId": { $in: lines.map((l) => l.categoryId) },
    };
    if (excludeRequestId) filter._id = { $ne: excludeRequestId };
    const found = await StockItemRequestModel.find(filter).select("requestNumber status lines").session(session).lean();
    const wanted = new Set(lines.map((l) => String(l.categoryId)));
    const open = [];
    const rejected = [];
    for (const r of found)
      for (const l of r.lines || []) {
        if (!wanted.has(String(l.categoryId))) continue;
        if (r.status === ITEM_REQUEST_STATUS.REJECTED) rejected.push(`${l.categoryPath} is on rejected request ${r.requestNumber}`);
        else if (lineRemaining(l) > 0) open.push(`${l.categoryPath} is already on open request ${r.requestNumber}`);
      }
    const parts = [];
    if (open.length) parts.push(`${open.join("; ")} for this subscriber at ${branch.name} — wait till it is issued or closed`);
    if (rejected.length) parts.push(`${rejected.join("; ")} for this subscriber at ${branch.name} — edit and resend it, or withdraw it, instead of a new request`);
    if (parts.length) throw new AppError(parts.join(". "), 409);
  }

  /*
    The requester no longer wants a REJECTED request: it becomes WITHDRAWN —
    final, kept in history, and its categories free for a new request. Only a
    rejected one; an open request stays the store's to settle.
  */
  static async withdrawRequest(id, body, channel, session) {
    assertChannel(channel);
    if (!mongoose.isValidObjectId(id)) throw new Error("Item request not found");
    const request = await StockItemRequestModel.findOne({ _id: id, channel, isActive: true }).session(session);
    if (!request) throw new Error("Item request not found");
    if (request.status !== ITEM_REQUEST_STATUS.REJECTED) throw new AppError("Only a rejected request can be withdrawn", 400);
    const before = request.toObject();
    const byName = text(body?.requestedBy?.name, 150) || request.requestedBy?.name || "";
    request.status = ITEM_REQUEST_STATUS.WITHDRAWN;
    request.history.push({ action: "WITHDRAWN", byName, note: text(body?.reason, 500) });
    await request.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "WITHDRAW", actor: { name: byName }, before, after: request.toObject(),
    });
    return StockItemRequestService._requesterView(request.toObject());
  }

  /*
    The same categories still owed to this subscriber on open ISSUE requests
    from OTHER branches — allowed, but worth a warning on both sides: the
    requester when sending, the store when issuing ("ONT is also pending at
    Zirakhpur on REQ-0015"). Only the request number and branch are shown.
  */
  static async _openElsewhere(subscriberId, branchId, categoryIds, excludeRequestId = null) {
    if (!categoryIds.length) return [];
    const filter = {
      isActive: true,
      type: { $in: [ITEM_REQUEST_TYPE.ISSUE, null] },
      status: { $in: OPEN_REQUEST_STATUSES },
      subscriberId,
      branchId: { $ne: branchId },
      "lines.categoryId": { $in: categoryIds },
    };
    if (excludeRequestId) filter._id = { $ne: excludeRequestId };
    const rows = await StockItemRequestModel.find(filter).select("requestNumber branchId lines").populate({ path: "branchId", select: "name" }).lean();
    const wanted = new Set(categoryIds.map(String));
    const out = [];
    for (const r of rows)
      for (const l of r.lines || [])
        if (wanted.has(String(l.categoryId)) && lineRemaining(l) > 0)
          out.push({ categoryId: l.categoryId, categoryPath: l.categoryPath, requestId: r._id, requestNumber: r.requestNumber, branchName: r.branchId?.name || "", remainingQty: lineRemaining(l) });
    return out;
  }

  static _elsewhereWarnings(list) {
    return list.map((o) => `${o.categoryPath} is also pending for this subscriber at ${o.branchName} on ${o.requestNumber}`);
  }

  // What the requester gets back on send / resend: the request, plus any
  // warnings it should show (not errors — the request is already in).
  static async _sentView(request) {
    const r = request.toObject();
    const elsewhere =
      (r.type || ITEM_REQUEST_TYPE.ISSUE) === ITEM_REQUEST_TYPE.ISSUE
        ? await StockItemRequestService._openElsewhere(r.subscriberId, r.branchId, r.lines.map((l) => l.categoryId), r._id)
        : [];
    return { ...StockItemRequestService._requesterView(r), warnings: StockItemRequestService._elsewhereWarnings(elsewhere) };
  }

  static _summary(type, r) {
    if (type === ITEM_REQUEST_TYPE.ISSUE) return r.lines.map((l) => `${l.categoryPath} × ${qtyLabel(l, l.requestedQty)}`).join("; ");
    const items = r.returnLines.map((l) => (l.trackingMethod === TRACKING_METHODS.INDIVIDUAL ? l.label : `${l.productName} ${l.requestedQty}`));
    const why = StockItemRequestService._reasonLabel(type, r.reason);
    return `${type === ITEM_REQUEST_TYPE.REPLACE ? "Replace" : "Return"}: ${items.join(", ")}${why ? ` · ${why}` : ""}`;
  }

  // The website owns its subscribers; this keeps the latest copy of the ones
  // that asked for stock.
  static async _upsertSubscriber(channel, input, session) {
    const orderId = text(input?.orderId, 100);
    if (!orderId) throw new AppError("Subscriber order ID is required", 400);
    const snapshot = {
      orderId,
      username: text(input.username, 150),
      serviceType: text(input.serviceType, 60),
      extraFields: cleanExtraFields(input.extraFields),
    };
    const subscriber = await StockSubscriberModel.findOneAndUpdate(
      { channel, orderIdKey: orderId.toUpperCase() },
      { $set: { ...snapshot, lastRequestAt: new Date() }, $setOnInsert: { channel, orderIdKey: orderId.toUpperCase() } },
      { new: true, upsert: true, session }
    );
    return { subscriber, snapshot };
  }

  static async createRequest(body, channel, session) {
    assertChannel(channel);
    const type = typeOf(body?.type);
    const { subscriber, snapshot } = await StockItemRequestService._upsertSubscriber(channel, body.subscriber, session);
    const resolved = await StockItemRequestService._resolve(type, body, subscriber._id, session);
    const requestedBy = { externalUserId: text(body.requestedBy?.id, 100), name: text(body.requestedBy?.name, 150) };

    const requestNumber = await nextDocumentNumber({ model: StockItemRequestModel, field: "requestNumber", prefix: "REQ", session });
    const [request] = await StockItemRequestModel.create(
      [
        {
          requestNumber,
          type,
          channel,
          ...resolved,
          subscriberId: subscriber._id,
          subscriber: snapshot,
          requestedBy,
          remarks: text(body.remarks, 1000),
          history: [{ action: "CREATED", byName: requestedBy.name, note: StockItemRequestService._summary(type, resolved) }],
        },
      ],
      { session }
    );
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "CREATE", actor: { name: requestedBy.name }, before: null, after: request.toObject(),
    });
    return StockItemRequestService._sentView(request);
  }

  // A REJECTED request, corrected by its requester and sent again. Same
  // request, same number — the rejection stays in its history.
  static async resendRequest(id, body, channel, session) {
    assertChannel(channel);
    if (!mongoose.isValidObjectId(id)) throw new Error("Item request not found");
    const request = await StockItemRequestModel.findOne({ _id: id, channel, isActive: true }).session(session);
    if (!request) throw new Error("Item request not found");
    if (request.status !== ITEM_REQUEST_STATUS.REJECTED) throw new AppError("Only a rejected request can be edited and sent again", 400);
    const before = request.toObject();

    const { subscriber, snapshot } = await StockItemRequestService._upsertSubscriber(
      channel,
      { ...body.subscriber, orderId: request.subscriber.orderId }, // the request stays with its subscriber
      session
    );
    // The type stays what it was — an issue cannot be resent as a return.
    const resolved = await StockItemRequestService._resolve(request.type, body, subscriber._id, session, request._id);
    const byName = text(body.requestedBy?.name, 150) || request.requestedBy?.name || "";

    request.set(resolved);
    request.subscriberId = subscriber._id;
    request.subscriber = snapshot;
    if (body.remarks !== undefined) request.remarks = text(body.remarks, 1000);
    request.status = ITEM_REQUEST_STATUS.PENDING;
    request.rejection = null;
    request.revision = (request.revision || 1) + 1;
    request.history.push({ action: "RESENT", byName, note: `Revision ${request.revision}: ${StockItemRequestService._summary(request.type, resolved)}` });
    await request.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "RESEND", actor: { name: byName }, before, after: request.toObject(),
    });
    return StockItemRequestService._sentView(request);
  }

  // What a requester is shown: the request, and every unit handed over by its
  // product and serial.
  static _requesterView(r) {
    return {
      _id: r._id,
      requestNumber: r.requestNumber,
      type: r.type || ITEM_REQUEST_TYPE.ISSUE,
      status: r.status,
      revision: r.revision,
      returnLines: (r.returnLines || []).map((l) => ({
        _id: l._id,
        closed: !!l.closure,
        inventoryItemId: l.inventoryItemId,
        productName: l.productName,
        label: l.label,
        unit: l.unit,
        trackingMethod: l.trackingMethod,
        requestedQty: l.requestedQty,
        receivedQty: l.receivedQty,
      })),
      returnRequestedQty: r.returnRequestedQty || 0,
      returnReceivedQty: r.returnReceivedQty || 0,
      receipts: (r.receipts || []).map((rc) => ({
        at: rc.at,
        byName: rc.by?.name || "",
        lines: rc.lines.map((l) => ({
          returnLineId: l.returnLineId, productName: l.productName, label: l.label, quantity: l.quantity,
          condition: l.condition, workingState: l.workingState, itemCondition: l.itemCondition,
        })),
      })),
      branchId: r.branchId?._id || r.branchId,
      branchName: r.branchId?.name || undefined,
      subscriber: r.subscriber,
      lines: (r.lines || []).map((l) => ({
        _id: l._id,
        categoryId: l.categoryId,
        categoryPath: l.categoryPath,
        trackingMethod: l.trackingMethod,
        unit: l.unit,
        requestedQty: l.requestedQty,
        issuedQty: l.issuedQty,
        status: lineStatusOf(l),
        ...(l.returnLineId
          ? { returnLineId: l.returnLineId, swapStatus: swapStatusOf(l, (r.returnLines || []).find((x) => String(x._id) === String(l.returnLineId))) }
          : {}),
        closure: l.closure ? { reason: l.closure.reason, at: l.closure.at } : null,
        issuedByProduct: issuedByProduct(r.issues, l._id).map(({ productName, quantity }) => ({ productName, quantity })),
      })),
      requestedQty: r.requestedQty,
      issuedQty: r.issuedQty,
      issuedByProduct: issuedByProduct(r.issues).map(({ productName, quantity }) => ({ productName, quantity })),
      issues: (r.issues || []).map((i) => ({
        at: i.at,
        byName: i.by?.name || "",
        lines: i.lines.map((l) => ({
          requestLineId: l.requestLineId,
          categoryPath: (r.lines || []).find((rl) => String(rl._id) === String(l.requestLineId))?.categoryPath || "",
          productName: l.productName,
          quantity: l.quantity,
          units: l.units.map((u) => u.label),
        })),
      })),
      rejection: r.rejection ? { reason: r.rejection.reason, at: r.rejection.at } : null,
      closure: r.closure ? { reason: r.closure.reason, at: r.closure.at } : null,
      remarks: r.remarks,
      reason: r.reason || null,
      history: r.history,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  static async getForRequester(id, channel) {
    assertChannel(channel);
    if (!mongoose.isValidObjectId(id)) throw new Error("Item request not found");
    const r = await StockItemRequestModel.findOne({ _id: id, channel, isActive: true }).populate({ path: "branchId", select: "name" }).lean();
    if (!r) throw new Error("Item request not found");
    return StockItemRequestService._requesterView(r);
  }

  static async listForRequester({ channel, orderId, status } = {}) {
    assertChannel(channel);
    const filter = { channel, isActive: true };
    if (orderId) {
      const sub = await StockSubscriberModel.findOne({ channel, orderIdKey: String(orderId).trim().toUpperCase() }).select("_id").lean();
      if (!sub) return [];
      filter.subscriberId = sub._id;
    }
    if (status && ITEM_REQUEST_STATUS_ARRAY.includes(status)) filter.status = status;
    const rows = await StockItemRequestModel.find(filter).populate({ path: "branchId", select: "name" }).sort({ createdAt: -1 }).limit(200).lean();
    return rows.map((r) => StockItemRequestService._requesterView(r));
  }

  /* ====================================================================== */
  /* Store side                                                             */
  /* ====================================================================== */

  // The store-side filter WITHOUT the branch scope — callers apply it.
  static _storeFilter({ status, branchId, search, type }) {
    const filter = { isActive: true };
    if (status && ITEM_REQUEST_STATUS_ARRAY.includes(status)) filter.status = status;
    if (type && ITEM_REQUEST_TYPE_ARRAY.includes(type))
      filter.type = type === ITEM_REQUEST_TYPE.ISSUE ? { $in: [type, null] } : type; // null: rows from before types existed
    if (branchId && mongoose.isValidObjectId(branchId)) filter.branchId = oid(branchId);
    if (search) {
      const rx = { $regex: escapeRegex(String(search).trim()), $options: "i" };
      filter.$or = [{ requestNumber: rx }, { "subscriber.orderId": rx }, { "subscriber.username": rx }, { "lines.categoryPath": rx }];
    }
    return filter;
  }

  static async list(query, dataAccess) {
    const { skip, limit } = paginate(query);
    const filter = applyDataScope(StockItemRequestService._storeFilter(query), dataAccess, MODULE_KEY);
    const [data, total] = await Promise.all([
      StockItemRequestModel.find(filter)
        .select("requestNumber type status channel branchId subscriber lines requestedQty issuedQty returnLines.label returnLines.productName returnRequestedQty returnReceivedQty reason requestedBy revision createdAt updatedAt")
        .populate({ path: "branchId", select: "name code" })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StockItemRequestModel.countDocuments(filter),
    ]);
    data.forEach((r) => (r.lines || []).forEach((l) => (l.status = lineStatusOf(l))));
    return { data, total };
  }

  // Tab counts — every status, over the same branch/search filter.
  static async statusCounts(query, dataAccess) {
    const filter = applyDataScope(StockItemRequestService._storeFilter({ ...query, status: undefined }), dataAccess, MODULE_KEY);
    const rows = await StockItemRequestModel.aggregate([{ $match: filter }, { $group: { _id: "$status", n: { $sum: 1 } } }]);
    const counts = Object.fromEntries(ITEM_REQUEST_STATUS_ARRAY.map((s) => [s, 0]));
    rows.forEach((r) => (counts[r._id] = r.n));
    return counts;
  }

  // The Issue / Replace / Return tabs — how many of each are still open
  // (pending or partial), over the same branch/search filter.
  static async typeCounts(query, dataAccess) {
    const filter = applyDataScope(
      { ...StockItemRequestService._storeFilter({ ...query, status: undefined, type: undefined }), status: { $in: OPEN_REQUEST_STATUSES } },
      dataAccess,
      MODULE_KEY
    );
    const rows = await StockItemRequestModel.aggregate([{ $match: filter }, { $group: { _id: { $ifNull: ["$type", ITEM_REQUEST_TYPE.ISSUE] }, n: { $sum: 1 } } }]);
    const counts = Object.fromEntries(ITEM_REQUEST_TYPE_ARRAY.map((t) => [t, 0]));
    rows.forEach((r) => (counts[r._id] = r.n));
    return counts;
  }

  static async _load(id, session, dataAccess) {
    if (!mongoose.isValidObjectId(id)) throw new Error("Item request not found");
    const request = await StockItemRequestModel.findOne({ _id: id, isActive: true }).session(session);
    if (!request) throw new Error("Item request not found");
    assertDataScope(request, dataAccess);
    return request;
  }

  // Free quantity of each given product at a branch.
  static async _freeByProduct(productIds, branchId, session = null) {
    if (!productIds.length) return new Map();
    const rows = await StockInventoryItemModel.aggregate([
      {
        $match: {
          ...FREE,
          productDefinitionId: { $in: productIds.map(oid) },
          branchId: oid(branchId),
          $or: [{ quantity: null }, { quantity: { $gt: 0 } }],
        },
      },
      { $group: { _id: "$productDefinitionId", qty: { $sum: { $ifNull: ["$quantity", 1] } } } },
    ]).session(session);
    return new Map(rows.map((r) => [String(r._id), round3(r.qty)]));
  }

  /*
    The request, with each outgoing line's progress and — while the line is
    still open — every active product of its category with how much is free
    at the request's branch, and what has gone out on it so far per product.
  */
  static async getById(id, dataAccess) {
    const request = await StockItemRequestService._load(id, null, dataAccess);
    const r = await StockItemRequestModel.findById(request._id).populate({ path: "branchId", select: "name code" }).lean();
    assertDataScope({ ...r, branchId: r.branchId?._id }, dataAccess);

    r.type = r.type || ITEM_REQUEST_TYPE.ISSUE;
    r.lines = r.lines || [];
    r.issuedByProduct = issuedByProduct(r.issues);
    (r.returnLines || []).forEach((l) => (l.remainingQty = l.closure ? 0 : round3(Math.max(0, l.requestedQty - l.receivedQty))));
    r.returnRemainingQty = round3(Math.max(0, (r.returnRequestedQty || 0) - (r.returnReceivedQty || 0)));

    const isOpen = OPEN_REQUEST_STATUSES.includes(r.status) && hasIssueSide(r.type);
    const openCategories = isOpen ? r.lines.filter((l) => lineRemaining(l) > 0).map((l) => l.categoryId) : [];
    const products = openCategories.length
      ? await StockProductDefinitionModel.find({ categoryId: { $in: openCategories }, isActive: true })
          .select("_id name categoryId trackingMethod unit")
          .sort({ name: 1 })
          .lean()
      : [];
    const free = await StockItemRequestService._freeByProduct(products.map((p) => p._id), r.branchId._id);

    r.lines = r.lines.map((l) => {
      const remainingQty = lineRemaining(l);
      const mine = remainingQty > 0 ? products.filter((p) => String(p.categoryId) === String(l.categoryId)) : [];
      const withFree = mine.map((p) => ({ _id: p._id, name: p.name, availableQty: free.get(String(p._id)) || 0 }));
      const rl = l.returnLineId ? (r.returnLines || []).find((x) => String(x._id) === String(l.returnLineId)) : null;
      return {
        ...l,
        ...(rl ? { swapStatus: swapStatusOf(l, rl), givableQty: swapGivable(l, rl) } : {}),
        status: lineStatusOf(l),
        remainingQty,
        issuedByProduct: issuedByProduct(r.issues, l._id),
        products: withFree,
        availableQty: remainingQty > 0 ? round3(withFree.reduce((s, p) => s + p.availableQty, 0)) : null,
      };
    });
    r.remainingQty = round3(r.lines.reduce((s, l) => s + l.remainingQty, 0));
    // Same category also owed to this subscriber from another branch — a
    // warning for the store, so the subscriber is not given it twice.
    r.openElsewhere =
      isOpen && r.type === ITEM_REQUEST_TYPE.ISSUE
        ? await StockItemRequestService._openElsewhere(r.subscriberId, r.branchId._id, openCategories, r._id)
        : [];
    return r;
  }

  // One of the request's lines, by id — or the only one still open when none is named.
  static _pickLine(request, lineId) {
    if (lineId) {
      const line = mongoose.isValidObjectId(lineId) ? request.lines.id(lineId) : null;
      if (!line) throw new AppError("Invalid: that item is not on this request", 400);
      return line;
    }
    const open = request.lines.filter((l) => lineRemaining(l) > 0);
    if (open.length !== 1) throw new AppError("Choose which item of the request", 400);
    return open[0];
  }

  /*
    What the store may pick from for one line: every active product of its
    category, at the request's branch, free. Individual: the units
    (optionally one product's, or a serial search). Batch: free quantity per
    product.
  */
  static async availableUnits(id, { lineId, search, productId } = {}, dataAccess) {
    const request = await StockItemRequestService._load(id, null, dataAccess);
    const line = StockItemRequestService._pickLine(request, lineId);
    const products = await StockProductDefinitionModel.find({ categoryId: line.categoryId, isActive: true })
      .select("_id name trackingMethod unit")
      .sort({ name: 1 })
      .lean();
    const nameById = new Map(products.map((p) => [String(p._id), p.name]));
    const ids = productId && nameById.has(String(productId)) ? [oid(productId)] : products.map((p) => p._id);

    if (line.trackingMethod === TRACKING_METHODS.INDIVIDUAL) {
      const filter = { ...FREE, productDefinitionId: { $in: ids }, branchId: request.branchId, quantity: null };
      if (search) filter.identifiers = { $regex: escapeRegex(String(search).trim().toUpperCase()) };
      const units = await StockInventoryItemModel.find(filter)
        .select("productDefinitionId fieldValues identifiers condition source warranty receivedAt")
        .sort({ receivedAt: 1 })
        .limit(500)
        .lean();
      return {
        lineId: line._id,
        trackingMethod: line.trackingMethod,
        products: products.map((p) => ({ _id: p._id, name: p.name })),
        units: units.map((u) => ({ ...u, label: unitLabel(u), productName: nameById.get(String(u.productDefinitionId)) || "" })),
      };
    }
    const free = await StockItemRequestService._freeByProduct(ids, request.branchId);
    return {
      lineId: line._id,
      trackingMethod: line.trackingMethod,
      unit: line.unit,
      products: products
        .filter((p) => ids.some((x) => String(x) === String(p._id)))
        .map((p) => ({ _id: p._id, name: p.name, availableQty: free.get(String(p._id)) || 0 })),
    };
  }

  // Individual: flip the exact units. Returns { movements, issueLines }.
  static async _issueUnits(request, unitIds, categoryProductIds, ctx, session) {
    const ids = [...new Set(unitIds.map(String))];
    if (ids.some((x) => !mongoose.isValidObjectId(x))) throw new AppError("Invalid unit selected", 400);
    const units = await StockInventoryItemModel.find({
      ...FREE,
      _id: { $in: ids },
      productDefinitionId: { $in: categoryProductIds },
      branchId: request.branchId,
      quantity: null,
    })
      .populate({ path: "productDefinitionId", select: "name" })
      .session(session)
      .lean();
    if (units.length !== ids.length)
      throw new AppError(`${ids.length - units.length} chosen unit(s) are not of this item's category, or no longer available here — refresh and pick again`, 409);

    // The status in the filter is the guard against the same unit being issued
    // twice at once: the second writer matches nothing.
    const res = await StockInventoryItemModel.updateMany(
      { _id: { $in: ids }, status: ITEM_STATUS.AVAILABLE },
      { $set: { status: ITEM_STATUS.ASSIGNED, assignedTo: ctx.assignedTo } }, // condition as it was: the store judges it when it comes back
      { session }
    );
    if (res.modifiedCount !== ids.length) throw new AppError("A chosen unit was just issued elsewhere — refresh and pick again", 409);

    const byProduct = new Map();
    for (const u of units) {
      const pid = String(u.productDefinitionId._id);
      if (!byProduct.has(pid)) byProduct.set(pid, { productDefinitionId: u.productDefinitionId._id, productName: u.productDefinitionId.name, units: [] });
      byProduct.get(pid).units.push({ inventoryItemId: u._id, label: unitLabel(u) });
    }
    return {
      quantity: ids.length,
      movements: units.map((u) => ({
        inventoryItemId: u._id,
        productDefinitionId: u.productDefinitionId._id,
        type: ITEM_MOVEMENT_TYPE.ISSUED,
        at: ctx.now,
        fromBranchId: request.branchId,
        status: ITEM_STATUS.ASSIGNED,
        ref: ctx.ref,
        note: ctx.note,
      })),
      issueLines: [...byProduct.values()].map((l) => ({ ...l, quantity: l.units.length })),
    };
  }

  /*
    Batch: take `qty` of one product off its batches, oldest first. Same split
    as a transfer — each source batch gives a part, and that part becomes its
    own ASSIGNED batch carrying the source's origin, cost and warranty, so
    "what did ORD-101 get, from which invoice" stays answerable.
  */
  static async _issueBatch(request, product, qty, ctx, session) {
    const batches = await StockInventoryItemModel.find({
      ...FREE,
      productDefinitionId: product._id,
      branchId: request.branchId,
      quantity: { $gt: 0 },
    })
      .sort({ receivedAt: 1, createdAt: 1 })
      .session(session);
    const free = round3(batches.reduce((s, b) => s + b.quantity, 0));
    if (free < qty) throw new AppError(`${product.name}: only ${free} available at this branch`, 409);

    const movements = [];
    const units = [];
    let left = qty;
    for (const batch of batches) {
      if (left <= 0) break;
      const take = round3(Math.min(left, batch.quantity));
      batch.quantity = round3(batch.quantity - take);
      left = round3(left - take);
      await batch.save({ session });
      const src = batch.toObject();
      const [given] = await StockInventoryItemModel.create(
        [
          {
            productDefinitionId: product._id,
            vendorId: src.vendorId,
            branchId: request.branchId,
            invoiceId: src.invoiceId,
            status: ITEM_STATUS.ASSIGNED,
            approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
            isFoc: src.isFoc,
            quantity: take,
            fieldValues: src.fieldValues,
            source: src.source,
            condition: src.condition,
            warranty: src.warranty,
            purchaseCost: src.purchaseCost,
            purchaseDate: src.purchaseDate,
            receivedAt: src.receivedAt,
            receivedBy: src.receivedBy,
            assignedTo: ctx.assignedTo,
          },
        ],
        { session }
      );
      const base = {
        productDefinitionId: product._id,
        type: ITEM_MOVEMENT_TYPE.ISSUED,
        at: ctx.now,
        quantity: take,
        fromBranchId: request.branchId,
        ref: ctx.ref,
        note: ctx.note,
      };
      movements.push(
        { ...base, inventoryItemId: batch._id, relatedItemId: given._id, status: batch.status },
        { ...base, inventoryItemId: given._id, relatedItemId: batch._id, status: ITEM_STATUS.ASSIGNED }
      );
      units.push({ inventoryItemId: given._id, label: src.source?.refNumber || unitLabel(src), quantity: take });
    }
    return { movements, issueLine: { productDefinitionId: product._id, productName: product.name, quantity: qty, units } };
  }

  /*
    Issue — one handover: some or all of what is still owed, for any of the
    request's open lines at once, each from any product(s) of its category.
      { lines: [{ requestLineId,
                  inventoryItemIds: [...]                              (individual)
                  quantities: [{ productDefinitionId, quantity }] }] } (batch)
    The older single-line body ({ inventoryItemIds } / { quantities }) is
    taken for the one line still open.
  */
  static async issue(id, body, user, session, dataAccess) {
    const request = await StockItemRequestService._load(id, session, dataAccess);
    if (!OPEN_REQUEST_STATUSES.includes(request.status)) throw new AppError("This request is no longer open for issuing", 400);
    if (!hasIssueSide(request.type)) throw new AppError("Nothing is issued on a return request — receive it instead", 400);
    const before = request.toObject();
    if (!request.lines.some((l) => lineRemaining(l) > 0)) throw new AppError("Everything on this request has already been issued", 400);
    const raw = Array.isArray(body?.lines)
      ? body.lines
      : [{ requestLineId: StockItemRequestService._pickLine(request, null)._id, inventoryItemIds: body?.inventoryItemIds, quantities: body?.quantities }];

    const now = new Date();
    const by = personOf(user);
    const issueLines = await StockItemRequestService._applyIssue(request, raw, by, now, session);
    request.status = progressStatus(request);
    request.history.push({
      action: "ISSUED",
      at: now,
      byName: by.name,
      note: issueLines.map((l) => `${l.productName} ×${l.quantity}`).join(", "),
    });
    StockItemRequestService._noteSettled(request, now, by.name);
    await request.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "ISSUE", actor: user, before, after: request.toObject(),
    });
    // Not getById: that reads outside this transaction and would show the
    // request as it was before the issue. The screen reloads after commit.
    return request.toObject();
  }

  /*
    The stock half of an issue, on a loaded request: moves the units, records
    their timeline and the handover on the request. The caller sets status and
    history and saves. On a REPLACE a line gives no more than has come back of
    its old item ("receive the old one first").
  */
  static async _applyIssue(request, raw, by, now, session) {
    const given = (x) => (Array.isArray(x?.inventoryItemIds) && x.inventoryItemIds.length) || (Array.isArray(x?.quantities) && x.quantities.some((q) => Number(q?.quantity) > 0));
    const inputs = raw.filter(given);
    if (!inputs.length) throw new AppError("Choose at least one unit or quantity to issue", 400);
    if (new Set(inputs.map((x) => String(x.requestLineId))).size !== inputs.length) throw new AppError("Invalid: an item is listed twice", 400);
    const allUnitIds = inputs.flatMap((x) => (Array.isArray(x.inventoryItemIds) ? x.inventoryItemIds.map(String) : []));
    if (new Set(allUnitIds).size !== allUnitIds.length) throw new AppError("Invalid: a unit is chosen twice", 400);

    const work = inputs.map((x) => {
      const line = StockItemRequestService._pickLine(request, x.requestLineId);
      if (line.closure) throw new AppError(`${line.categoryPath}: this item is closed`, 400);
      if (!(lineRemaining(line) > 0)) throw new AppError(`${line.categoryPath}: everything is already issued`, 400);
      const old = line.returnLineId ? request.returnLines.id(line.returnLineId) : null;
      if (line.returnLineId && !(swapGivable(line, old) > 0))
        throw new AppError(`${old?.label || line.categoryPath}: receive the old item first — the new one goes out only in its place`, 400);
      return { line, input: x, old, cap: old ? swapGivable(line, old) : lineRemaining(line) };
    });

    const products = await StockProductDefinitionModel.find({ categoryId: { $in: work.map((w) => w.line.categoryId) }, isActive: true })
      .select("_id name categoryId trackingMethod unit")
      .session(session)
      .lean();

    const ctx = {
      now,
      assignedTo: {
        kind: "SUBSCRIBER",
        subscriberId: request.subscriberId,
        orderId: request.subscriber.orderId,
        username: request.subscriber.username,
        serviceType: request.subscriber.serviceType,
        requestId: request._id,
        requestNumber: request.requestNumber,
        assignedAt: now,
      },
      ref: { type: ITEM_MOVEMENT_REF.ITEM_REQUEST, refId: request._id, refNumber: request.requestNumber },
      note: `Issued to ${request.subscriber.orderId}${request.subscriber.username ? ` · ${request.subscriber.username}` : ""}`,
    };

    let movements = [];
    const issueLines = [];
    let total = 0;

    for (const { line, input, old, cap } of work) {
      const remaining = cap;
      const mine = products.filter((p) => String(p.categoryId) === String(line.categoryId));
      // The unit's timeline says what it stands in for.
      const lineCtx = old ? { ...ctx, note: `${ctx.note} · in place of ${old.label}` } : ctx;
      const left = (n) => (old ? `only ${qtyLabel(line, n)} of ${old.label} has come back so far` : `only ${qtyLabel(line, n)} left to issue`);
      let lineIssued = [];
      let qty = 0;

      if (line.trackingMethod === TRACKING_METHODS.INDIVIDUAL) {
        const unitIds = Array.isArray(input.inventoryItemIds) ? input.inventoryItemIds : [];
        if (!unitIds.length) throw new AppError(`${line.categoryPath}: choose units, not a quantity`, 400);
        if (new Set(unitIds.map(String)).size > remaining) throw new AppError(`${line.categoryPath}: ${left(remaining)}`, 400);
        const out = await StockItemRequestService._issueUnits(request, unitIds, mine.map((p) => p._id), lineCtx, session);
        movements = movements.concat(out.movements);
        lineIssued = out.issueLines;
        qty = out.quantity;
      } else {
        const qs = (Array.isArray(input.quantities) ? input.quantities : []).filter((q) => Number(q?.quantity) > 0);
        if (!qs.length) throw new AppError(`${line.categoryPath}: give a quantity`, 400);
        if (new Set(qs.map((q) => String(q.productDefinitionId))).size !== qs.length) throw new AppError(`${line.categoryPath}: a product is listed twice`, 400);
        qty = round3(qs.reduce((s, q) => s + Number(q.quantity), 0));
        if (qty > remaining) throw new AppError(`${line.categoryPath}: ${left(remaining)}`, 400);
        for (const q of qs) {
          const product = mine.find((p) => String(p._id) === String(q.productDefinitionId));
          if (!product) throw new AppError(`${line.categoryPath}: that product is not in this category`, 400);
          const out = await StockItemRequestService._issueBatch(request, product, round3(Number(q.quantity)), lineCtx, session);
          movements = movements.concat(out.movements);
          lineIssued.push(out.issueLine);
        }
      }

      line.issuedQty = round3(line.issuedQty + qty);
      total = round3(total + qty);
      lineIssued.forEach((l) => issueLines.push({ ...l, requestLineId: line._id }));
    }

    await StockItemMovementService.record(movements, session);

    request.issues.push({ at: now, by, lines: issueLines });
    request.issuedQty = round3(request.issuedQty + total);
    return issueLines;
  }

  /*
    Receive — things coming back from the subscriber, each with the condition
    it came back in, some or all of what is still due.
      body: { lines: [{ returnLineId, quantity? (batch), condition: GOOD|FAULTY, note? }] }

    GOOD goes back on the shelf as AVAILABLE; FAULTY becomes FAULTY with the
    note, for the repair / warranty / scrap screens. Either way the stock lands
    at the request's branch, is no longer anybody's, and gets a RETURNED row.
    A batch coming back in part is split, like an issue in reverse: the part
    received becomes its own document, the rest stays with the subscriber.
  */
  static async receive(id, body, user, session, dataAccess) {
    const request = await StockItemRequestService._load(id, session, dataAccess);
    if (!OPEN_REQUEST_STATUSES.includes(request.status)) throw new AppError("This request is no longer open", 400);
    if (!hasReturnSide(request.type)) throw new AppError("Nothing comes back on an issue request", 400);
    const before = request.toObject();

    const now = new Date();
    const by = personOf(user);
    const receiptLines = await StockItemRequestService._applyReceive(request, Array.isArray(body?.lines) ? body.lines : [], by, now, session);
    request.status = progressStatus(request);
    request.history.push({
      action: "RECEIVED",
      at: now,
      byName: by.name,
      note: receiptLines.map((l) => `${l.label} (${returnStateLabel(l)})`).join(", "),
    });
    StockItemRequestService._noteSettled(request, now, by.name);
    await request.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "RECEIVE", actor: user, before, after: request.toObject(),
    });
    return request.toObject();
  }

  /*
    The stock half of a receipt, on a loaded request: lands each thing back at
    the branch, records its timeline and the receipt on the request. The
    caller sets status and history and saves.
  */
  static async _applyReceive(request, inputs, by, now, session) {
    if (!inputs.length) throw new AppError("Choose at least one item that came back", 400);
    if (new Set(inputs.map((l) => String(l?.returnLineId))).size !== inputs.length) throw new AppError("Invalid: an item is listed twice", 400);

    const ref = { type: ITEM_MOVEMENT_REF.ITEM_REQUEST, refId: request._id, refNumber: request.requestNumber };
    const from = `${request.subscriber.orderId}${request.subscriber.username ? ` · ${request.subscriber.username}` : ""}`;
    const movements = [];
    const receiptLines = [];
    let total = 0;

    for (const input of inputs) {
      const line = request.returnLines.id(input?.returnLineId);
      if (!line) throw new AppError("Invalid: an item does not belong to this request", 400);
      if (line.closure) throw new AppError(`${line.label}: this item is closed on the request`, 400);
      const state = readReturnState(input, line.label);
      const remaining = round3(line.requestedQty - line.receivedQty);
      if (!(remaining > 0)) throw new AppError(`${line.label}: already received`, 400);

      const isUnit = line.trackingMethod === TRACKING_METHODS.INDIVIDUAL;
      const qty = isUnit ? 1 : round3(Number(input.quantity ?? remaining));
      if (!(qty > 0) || qty > remaining) throw new AppError(`${line.productName}: receive between 0 and ${remaining}`, 400);

      // Still with this subscriber — the guard against receiving the same
      // thing twice, or something that has since moved on.
      const held = await StockInventoryItemModel.findOne({
        _id: line.inventoryItemId,
        isActive: true,
        status: ITEM_STATUS.ASSIGNED,
        "assignedTo.subscriberId": request.subscriberId,
      }).session(session);
      if (!held || (!isUnit && held.quantity < qty))
        throw new AppError(`${line.label}: no longer with this subscriber as requested — refresh`, 409);

      const landed = landedFields(state, request.branchId, now, `Return from ${from}`, request.requestNumber);
      const move = {
        productDefinitionId: line.productDefinitionId,
        type: ITEM_MOVEMENT_TYPE.RETURNED,
        at: now,
        toBranchId: request.branchId,
        status: landed.status,
        ref,
        note: `Returned by ${from} · ${returnStateLabel(state)}`,
      };

      let landedId = held._id;
      if (isUnit || qty === held.quantity) {
        held.set(landed);
        await held.save({ session });
        movements.push({ ...move, inventoryItemId: held._id, quantity: isUnit ? null : qty });
      } else {
        held.quantity = round3(held.quantity - qty);
        await held.save({ session });
        const src = held.toObject();
        const [back] = await StockInventoryItemModel.create(
          [
            {
              productDefinitionId: src.productDefinitionId,
              vendorId: src.vendorId,
              invoiceId: src.invoiceId,
              approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
              isFoc: src.isFoc,
              quantity: qty,
              fieldValues: src.fieldValues,
              source: src.source,
              warranty: src.warranty,
              purchaseCost: src.purchaseCost,
              purchaseDate: src.purchaseDate,
              receivedAt: src.receivedAt,
              receivedBy: src.receivedBy,
              ...landed,
            },
          ],
          { session }
        );
        landedId = back._id;
        movements.push(
          { ...move, inventoryItemId: back._id, quantity: qty, relatedItemId: held._id },
          { ...move, inventoryItemId: held._id, quantity: qty, relatedItemId: back._id, status: ITEM_STATUS.ASSIGNED }
        );
      }

      line.receivedQty = round3(line.receivedQty + qty);
      total = round3(total + qty);
      receiptLines.push({
        returnLineId: line._id, productName: line.productName, label: line.label, quantity: qty,
        condition: legacyCondition(state.workingState), workingState: state.workingState, itemCondition: state.itemCondition, note: state.note,
        inventoryItemId: landedId,
      });
    }

    await StockItemMovementService.record(movements, session);

    request.receipts.push({ at: now, by, lines: receiptLines });
    request.returnReceivedQty = round3(request.returnReceivedQty + total);
    return receiptLines;
  }

  /*
    Replace ONE row in one go — the old item back, the new one out:
      { returnLineId,
        receive: { condition: GOOD|FAULTY, note?, quantity? (batch) },   optional
        give:    { inventoryItemIds } | { quantities } }                 optional
    Either half may be left out: receive only (no stock for the new one yet),
    or give only (the old one came back earlier). The new one never goes out
    beyond what has come back of the old.
  */
  static async swap(id, body, user, session, dataAccess) {
    const request = await StockItemRequestService._load(id, session, dataAccess);
    if (!OPEN_REQUEST_STATUSES.includes(request.status)) throw new AppError("This request is no longer open", 400);
    if (request.type !== ITEM_REQUEST_TYPE.REPLACE) throw new AppError("Only a replace request swaps items", 400);
    const old = mongoose.isValidObjectId(body?.returnLineId) ? request.returnLines.id(body.returnLineId) : null;
    if (!old) throw new AppError("Invalid: that item is not on this request", 400);
    const line = request.lines.find((l) => String(l.returnLineId) === String(old._id));
    if (!line) throw new AppError("Invalid: that item has nothing to go out in its place", 400);
    const receive = body?.receive && typeof body.receive === "object" ? body.receive : null;
    const give = body?.give && typeof body.give === "object" ? body.give : null;
    if (!receive && !give) throw new AppError("Receive the old item, give the new one, or both", 400);
    const before = request.toObject();

    const now = new Date();
    const by = personOf(user);
    const notes = [];
    if (receive) {
      const [got] = await StockItemRequestService._applyReceive(request, [{ ...receive, returnLineId: old._id }], by, now, session);
      notes.push(`${got.label} back ${returnStateLabel(got)}`);
    }
    if (give) {
      const out = await StockItemRequestService._applyIssue(request, [{ ...give, requestLineId: line._id }], by, now, session);
      notes.push(`${out.map((l) => `${l.productName} ${l.units.map((u) => (u.quantity ? `${u.label} (${u.quantity})` : u.label)).join(", ")}`).join("; ")} given`);
    }
    request.status = progressStatus(request);
    request.history.push({ action: give ? "REPLACED" : "RECEIVED", at: now, byName: by.name, note: `${old.label}: ${notes.join(" · ")}` });
    StockItemRequestService._noteSettled(request, now, by.name);
    await request.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "SWAP", actor: user, before, after: request.toObject(),
    });
    return request.toObject();
  }

  /*
    What a subscriber holds right now, for the requester to pick a Return or
    Replace from — with any open request that already claims an item, so the
    website can grey it out.
  */
  static async holdingsForRequester(channel, orderId) {
    assertChannel(channel);
    const sub = await StockSubscriberModel.findOne({ channel, orderIdKey: String(orderId || "").trim().toUpperCase() }).lean();
    if (!sub) return { subscriber: null, items: [] };
    const items = await StockInventoryItemModel.find({ isActive: true, status: ITEM_STATUS.ASSIGNED, "assignedTo.subscriberId": sub._id })
      .populate({ path: "productDefinitionId", select: "name categoryId trackingMethod unit" })
      .sort({ "assignedTo.assignedAt": -1 })
      .lean();
    const open = await StockItemRequestModel.find({
      isActive: true,
      status: { $in: OPEN_REQUEST_STATUSES },
      "returnLines.inventoryItemId": { $in: items.map((i) => i._id) },
    })
      .select("requestNumber returnLines.inventoryItemId returnLines.closure")
      .lean();
    const claimedBy = new Map();
    open.forEach((r) => r.returnLines.forEach((l) => !l.closure && claimedBy.set(String(l.inventoryItemId), r.requestNumber)));

    const categoryIds = [...new Set(items.map((i) => String(i.productDefinitionId?.categoryId)).filter(Boolean))];
    const cats = await StockCategoryModel.find({ _id: { $in: categoryIds } }).select("path").lean();
    const pathById = new Map();
    for (const c of cats) pathById.set(String(c._id), await StockCategoryService.buildDisplayPath(c.path));

    return {
      subscriber: { orderId: sub.orderId, username: sub.username, serviceType: sub.serviceType },
      items: items.map((i) => ({
        inventoryItemId: i._id,
        productName: i.productDefinitionId?.name || "",
        categoryId: i.productDefinitionId?.categoryId || null,
        categoryPath: pathById.get(String(i.productDefinitionId?.categoryId)) || "",
        trackingMethod: i.quantity === null || i.quantity === undefined ? TRACKING_METHODS.INDIVIDUAL : TRACKING_METHODS.QUANTITY,
        unit: i.productDefinitionId?.unit || null,
        label: unitLabel(i),
        quantity: i.quantity,
        branchId: i.branchId,
        issuedOn: i.assignedTo?.requestNumber || "",
        assignedAt: i.assignedTo?.assignedAt || null,
        claimedBy: claimedBy.get(String(i._id)) || null,
      })),
    };
  }

  // The history entry for a request an issue, a receipt or a line close has
  // just settled.
  static _noteSettled(request, at, byName) {
    if (request.status === ITEM_REQUEST_STATUS.COMPLETED) request.history.push({ action: "COMPLETED", at, byName });
    else if (request.status === ITEM_REQUEST_STATUS.PARTIALLY_CLOSED)
      request.history.push({ action: "CLOSED", at, byName, note: "Everything settled — some item(s) closed short" });
  }

  /*
    Close ONE outgoing line the store cannot fill ("router not in stock"):
    nothing more goes out on it, the other lines carry on. What was already
    given on it stays given. Closing the last open line of a request nothing
    has moved on is a rejection, and is refused as a close.
  */
  static async closeLine(id, lineId, reason, user, session, dataAccess) {
    const request = await StockItemRequestService._load(id, session, dataAccess);
    if (!OPEN_REQUEST_STATUSES.includes(request.status)) throw new AppError("This request is no longer open", 400);
    if (!hasIssueSide(request.type)) throw new AppError("A return request has nothing going out to close", 400);
    const line = StockItemRequestService._pickLine(request, lineId);
    if (line.closure) throw new AppError(`${line.categoryPath}: already closed`, 400);
    const left = lineRemaining(line);
    if (!(left > 0)) throw new AppError(`${line.categoryPath}: fully issued — nothing left to close`, 400);
    const why = text(reason, 500);
    if (!why) throw new AppError("A reason is required to close an item", 400);
    const othersOpen = request.lines.some((l) => String(l._id) !== String(line._id) && lineRemaining(l) > 0);
    if (!othersOpen && !anythingMoved(request))
      throw new AppError("Nothing has moved on this request yet — reject it instead", 400);
    const before = request.toObject();

    const now = new Date();
    const by = personOf(user);
    line.closure = { reason: why, by, at: now };
    // A replace row closes whole: what has not come back stays with the
    // subscriber, what has stays in the store.
    const old = line.returnLineId ? request.returnLines.id(line.returnLineId) : null;
    if (old) old.closure = { reason: why, by, at: now };
    request.status = progressStatus(request);
    request.history.push({
      action: "LINE_CLOSED",
      at: now,
      byName: by.name,
      note: old ? `${old.label} — not replaced: ${why}` : `${line.categoryPath} — ${qtyLabel(line, left)} not issued: ${why}`,
    });
    StockItemRequestService._noteSettled(request, now, by.name);
    await request.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "CLOSE_LINE", actor: user, before, after: request.toObject(), reason: why,
    });
    return request.toObject();
  }

  // Close a partly done request for good — every line still owing is closed
  // and nothing more will move on it.
  static async shortClose(id, reason, user, session, dataAccess) {
    const request = await StockItemRequestService._load(id, session, dataAccess);
    if (!OPEN_REQUEST_STATUSES.includes(request.status) || !anythingMoved(request))
      throw new AppError("Only a partly done request can be short-closed — reject it if nothing has moved on it yet", 400);
    const why = text(reason, 500);
    if (!why) throw new AppError("A reason is required to short-close", 400);
    const before = request.toObject();

    const now = new Date();
    const by = personOf(user);
    request.lines.forEach((l) => {
      if (!(lineRemaining(l) > 0)) return;
      l.closure = { reason: why, by, at: now };
      const old = l.returnLineId ? request.returnLines.id(l.returnLineId) : null;
      if (old) old.closure = { reason: why, by, at: now };
    });
    request.status = ITEM_REQUEST_STATUS.PARTIALLY_CLOSED;
    request.closure = { reason: why, by, at: now };
    request.history.push({ action: "SHORT_CLOSED", at: now, byName: by.name, note: why });
    await request.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "SHORT_CLOSE", actor: user, before, after: request.toObject(), reason: why,
    });
    return request.toObject();
  }

  // Refuse a request before anything is issued on it. The requester may edit
  // and resend it.
  static async reject(id, reason, user, session, dataAccess) {
    const request = await StockItemRequestService._load(id, session, dataAccess);
    if (request.status !== ITEM_REQUEST_STATUS.PENDING)
      throw new AppError("Only a pending request can be rejected — short-close it if something has already moved on it", 400);
    if (anythingMoved(request)) throw new AppError("Old item(s) have already come back on this request — short-close it instead of rejecting", 400);
    const why = text(reason, 500);
    if (!why) throw new AppError("A reason is required to reject", 400);
    const before = request.toObject();

    const by = personOf(user);
    request.status = ITEM_REQUEST_STATUS.REJECTED;
    request.rejection = { reason: why, by, at: new Date() };
    request.history.push({ action: "REJECTED", byName: by.name, note: why });
    await request.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "REJECT", actor: user, before, after: request.toObject(), reason: why,
    });
    return request.toObject();
  }

  /* ====================================================================== */
  /* Subscriber items — "what does ORD-101 have"                            */
  /* ====================================================================== */

  // Subscribers holding stock, with how much — over the units the caller's
  // branch scope can see.
  static async subscribersWithItems({ search } = {}, dataAccess) {
    const match = applyDataScope(
      { status: ITEM_STATUS.ASSIGNED, isActive: true, "assignedTo.subscriberId": { $ne: null } },
      dataAccess,
      "inventory-items"
    );
    if (search) {
      const rx = { $regex: escapeRegex(String(search).trim()), $options: "i" };
      match.$or = [{ "assignedTo.orderId": rx }, { "assignedTo.username": rx }];
    }
    const rows = await StockInventoryItemModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$assignedTo.subscriberId",
          orderId: { $last: "$assignedTo.orderId" },
          username: { $last: "$assignedTo.username" },
          serviceType: { $last: "$assignedTo.serviceType" },
          units: { $sum: { $cond: [{ $eq: ["$quantity", null] }, 1, 0] } },
          batchQty: { $sum: { $ifNull: ["$quantity", 0] } },
          lastAssignedAt: { $max: "$assignedTo.assignedAt" },
        },
      },
      { $sort: { lastAssignedAt: -1 } },
      { $limit: 500 },
    ]);
    return rows.map((r) => ({ subscriberId: r._id, ...r, _id: undefined, batchQty: round3(r.batchQty) }));
  }

  static async subscriberItems(subscriberId, dataAccess) {
    if (!mongoose.isValidObjectId(subscriberId)) throw new Error("Subscriber not found");
    const subscriber = await StockSubscriberModel.findById(subscriberId).lean();
    if (!subscriber) throw new Error("Subscriber not found");
    const items = await StockInventoryItemModel.find(
      applyDataScope({ "assignedTo.subscriberId": subscriber._id, status: ITEM_STATUS.ASSIGNED, isActive: true }, dataAccess, "inventory-items")
    )
      .populate({ path: "productDefinitionId", select: "name trackingMethod unit" })
      .populate({ path: "branchId", select: "name" })
      .sort({ "assignedTo.assignedAt": -1 })
      .lean();
    return {
      subscriber,
      items: items.map((it) => ({
        _id: it._id,
        product: it.productDefinitionId,
        branch: it.branchId,
        label: unitLabel(it),
        quantity: it.quantity,
        fieldValues: it.fieldValues,
        source: it.source,
        warranty: it.warranty,
        assignedTo: it.assignedTo,
      })),
    };
  }
}
