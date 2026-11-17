import mongoose from "mongoose";
import StockTransferRequestModel from "../models/stock.transfer.request.model.js";
import StockBranchModel from "../models/stock.branch.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import { paginate } from "../helpers/pagination.helper.js";
import { nextDocumentNumber } from "../helpers/document.number.helper.js";
import { AppError } from "../helpers/response.helper.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import StockItemRequestService from "./stock.item.request.service.js";
import StockTransferService from "./stock.transfer.service.js";
import { actorSnapshot } from "../models/plugins/actor.stamp.plugin.js";
import { isWithinDataScope, applyDataScope, resolveDimensionAllowList } from "../helpers/data.scope.helper.js";
import {
  TRANSFER_REQUEST_STATUS,
  TRANSFER_REQUEST_STATUS_ARRAY,
  TRANSFER_REQUEST_CLOSED,
  ITEM_STATUS,
  ITEM_APPROVAL_STATUS,
} from "../constants/stock.enums.js";

/*
  Stock Transfer — every transfer starts as a request (SR-…), and the request
  carries the status both branches see until it is done:

    PENDING ── Send ──► ON_THE_WAY ── All Received ──► RECEIVED
       │                   ▲   │
       │  Correct & Resend │   └── Report Problem ──► MISMATCH
       │                   └─────────────────────────────────┘
       └── Decline ──► DECLINED

  Three pages, three modules — each serves its own list and detail, so its
  data scope is that module's:
    mine     my-stock-requests      every request we raised; we ask, and we
                                    say All Received / Report Problem
    to-us    stock-requests-to-us   every request raised with us; we Send,
                                    Decline and Correct & Resend
    history  stock-transfer-history the finished ones (RECEIVED / DECLINED), both ways

  A request is answered once (Send or Decline). What was not sent is closed
  with the reason; a still-needed rest is a new request. It cannot be
  withdrawn by the branch that raised it.
*/

const ENTITY_TYPE = "transfer-requests";
export const SIDE_MODULE = { mine: "my-stock-requests", "to-us": "stock-requests-to-us", history: "stock-transfer-history" };
const SIDE_STATUSES = { mine: TRANSFER_REQUEST_STATUS_ARRAY, "to-us": TRANSFER_REQUEST_STATUS_ARRAY, history: TRANSFER_REQUEST_CLOSED };
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toId = (v) => new mongoose.Types.ObjectId(String(v));

// May the caller act for this branch? (null allow list = every branch.)
const assertBranch = (dataAccess, branchId, message) => {
  let allow;
  try {
    allow = resolveDimensionAllowList(dataAccess, "branch");
  } catch {
    allow = [];
  }
  if (allow !== null && !allow.includes(String(branchId))) throw new AppError(message, 403);
};

const load = async (id, status, session) => {
  if (!mongoose.isValidObjectId(id)) throw new AppError("Request not found", 404);
  const request = await StockTransferRequestModel.findOne({ _id: id, isActive: true }).session(session);
  if (!request) throw new AppError("Request not found", 404);
  if (request.status !== status) throw new AppError("Invalid: this request has moved on — refresh and try again", 400);
  return request;
};

// The branch each person belonged to, for the "Requested By" / "Closed By" details.
const PEOPLE_BRANCHES = [
  { path: "createdBy.branchId", model: "branches", select: "name" },
  { path: "closedBy.branchId", model: "branches", select: "name" },
];

// The transfer fields each list row needs — not its units or batches.
const TRANSFER_SUMMARY = "transferNumber problemNote history sentAt sentByName receivedAt receivedByName";

export default class StockTransferRequestService {
  /* ---------------------------------------------------------------------- */
  /* Branch pickers                                                         */
  /* ---------------------------------------------------------------------- */

  // Both halves of a transfer form in one call:
  //
  //  - `branches` is every active branch. The *counterparty* of a transfer
  //    is by definition outside your own branch, so branch-scoping this list
  //    would make cross-branch transfers impossible.
  //  - `defaultBranchId` is the caller's own branch — you ask for and send
  //    stock on behalf of the branch you belong to. null = no branch assigned.
  //  - `myBranchIds` is every branch the caller may act for (null = all), for
  //    the "your branch" pickers of people who cover several.
  //
  // Served on the transfer modules (?module=) rather than /branches/active's
  // `branches:READ`, so ordinary branch staff need no branch-master permission.
  static async getFormBranches(dataAccess) {
    const branches = await StockBranchModel.find({ isActive: true }).sort({ name: 1 }).lean();

    const activeIds = new Set(branches.map((l) => String(l._id)));
    const branchIds = resolveDimensionAllowList(dataAccess, "branch");
    const scopedIds = branchIds === null ? [...activeIds] : branchIds.filter((id) => activeIds.has(id));

    const ownBranchId = dataAccess?.userBranchId ? String(dataAccess.userBranchId) : null;
    // Own branch when it is in scope; otherwise only an unambiguous single
    // scoped branch counts — never an arbitrary pick out of several.
    const defaultBranchId = scopedIds.includes(ownBranchId)
      ? ownBranchId
      : scopedIds.length === 1
        ? scopedIds[0]
        : null;

    return { branches, defaultBranchId, myBranchIds: branchIds === null ? null : scopedIds };
  }

  // What can be asked for — the same leaf categories an Item Request offers.
  static async categories() {
    return StockItemRequestService.catalogCategories();
  }

  /* ---------------------------------------------------------------------- */
  /* Request Stock                                                          */
  /* ---------------------------------------------------------------------- */

  static async createTransferRequest(body, user, session, dataAccess) {
    const { requestingBranchId, sourceBranchId, lines, remarks } = body;
    if (String(requestingBranchId) === String(sourceBranchId)) throw new AppError("Invalid: a branch cannot ask itself for stock", 400);

    // Sequential, not Promise.all — two operations can't run concurrently on
    // the same MongoDB session/transaction.
    const requestingBranch = await StockBranchModel.findOne({ _id: requestingBranchId, isActive: true }).session(session).lean();
    if (!requestingBranch) throw new AppError("Requesting branch not found", 404);
    // Only the requesting side is scoped: asking ANOTHER branch is the point.
    if (!isWithinDataScope(requestingBranch, dataAccess, "branches"))
      throw new AppError("You do not have permission to raise a request for this branch", 403);

    const sourceBranch = await StockBranchModel.findOne({ _id: sourceBranchId, isActive: true }).session(session).lean();
    if (!sourceBranch) throw new AppError("Source branch not found", 404);

    // Categories, exactly as an Item Request asks — the same leaf and
    // counted-the-same-way rules.
    const seen = new Set();
    const resolvedLines = [];
    for (const l of lines) {
      if (seen.has(String(l.categoryId))) throw new AppError("Invalid: each category can be on one line only", 400);
      seen.add(String(l.categoryId));
      const line = await StockItemRequestService._line(l.categoryId, Number(l.requestedQty), session);
      resolvedLines.push({
        categoryId: line.categoryId,
        categoryPath: line.categoryPath,
        trackingMethod: line.trackingMethod,
        unit: line.unit,
        requestedQty: line.requestedQty,
      });
    }

    const requestNumber = await nextDocumentNumber({ model: StockTransferRequestModel, field: "requestNumber", prefix: "SR", session });
    const [request] = await StockTransferRequestModel.create(
      [
        {
          requestNumber,
          requestingBranchId,
          sourceBranchId,
          lines: resolvedLines,
          status: TRANSFER_REQUEST_STATUS.PENDING,
          remarks: remarks || "",
          requestedBy: user?._id || null,
          requestedByName: user?.name || "",
          requestedAt: new Date(),
        },
      ],
      { session }
    );
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "CREATE", actor: user, before: null, after: request.toObject(),
    });
    return request;
  }

  /* ---------------------------------------------------------------------- */
  /* Lists — My Requests, Requests to Us, Transfer History                  */
  /* ---------------------------------------------------------------------- */

  /*
    side: mine | to-us (every status) | history (finished ones)
    query: status, search, branchId, from / to, page, limit
      mine / to-us  branchId = our branch; otherBranchId = the other side
                    (Requested To / Requesting Branch); from / to = requested between
      history       branchId = our branch, otherBranchId = the other side,
                    direction = mine (we asked) | to-us (we were asked), read
                    from our branch's side; from / to = closed between
    The screens always send our branch for someone who covers several, so
    "mine" and "to-us" never both match the same request.
  */
  static async getBoard(side, query = {}, dataAccess) {
    const { skip, limit, page } = paginate(query);
    const statuses = SIDE_STATUSES[side];

    // applyDataScope casts its own ids, so base is safe in $match below.
    const base = applyDataScope({ isActive: true, status: { $in: statuses } }, dataAccess, SIDE_MODULE[side]);
    const and = [...(base.$and || [])];
    const idOf = (v) => (v && mongoose.isValidObjectId(v) ? toId(v) : null);
    const branchId = idOf(query.branchId);
    const dateRange = (field) => {
      if (!query.from && !query.to) return;
      const range = {};
      if (query.from) range.$gte = new Date(query.from);
      if (query.to) { const d = new Date(query.to); d.setHours(23, 59, 59, 999); range.$lte = d; }
      and.push({ [field]: range });
    };
    if (side !== "history") {
      const [ours, other] = side === "to-us" ? ["sourceBranchId", "requestingBranchId"] : ["requestingBranchId", "sourceBranchId"];
      if (branchId) and.push({ [ours]: branchId });
      if (idOf(query.otherBranchId)) and.push({ [other]: idOf(query.otherBranchId) });
      dateRange("requestedAt");
    } else {
      const otherBranchId = idOf(query.otherBranchId);
      // We asked: our branch is the requester. We were asked: our branch is the source.
      const asOne = (ours, other) => {
        const c = {};
        if (branchId) c[ours] = branchId;
        if (otherBranchId) c[other] = otherBranchId;
        return c;
      };
      if (query.direction === "mine") and.push(asOne("requestingBranchId", "sourceBranchId"));
      else if (query.direction === "to-us") and.push(asOne("sourceBranchId", "requestingBranchId"));
      else if (branchId || otherBranchId) and.push({ $or: [asOne("requestingBranchId", "sourceBranchId"), asOne("sourceBranchId", "requestingBranchId")] });
      dateRange("closedAt");
    }
    if (query.search && String(query.search).trim()) {
      const rx = new RegExp(escapeRegex(String(query.search).trim()), "i");
      and.push({ $or: [{ requestNumber: rx }, { transferNumber: rx }, { "lines.categoryPath": rx }] });
    }
    if (and.length) base.$and = and;

    const filter = statuses.includes(query.status) ? { ...base, status: query.status } : base;
    const [rows, total, counts] = await Promise.all([
      StockTransferRequestModel.find(filter)
        .populate({ path: "requestingBranchId", select: "name code" })
        .populate({ path: "sourceBranchId", select: "name code" })
        .populate({ path: "transferId", select: TRANSFER_SUMMARY })
        .populate(PEOPLE_BRANCHES)
        .sort(side === "history" ? { closedAt: -1 } : { updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StockTransferRequestModel.countDocuments(filter),
      StockTransferRequestModel.aggregate([{ $match: base }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);

    const countMap = Object.fromEntries([["ALL", 0], ...statuses.map((s) => [s, 0])]);
    counts.forEach((c) => {
      countMap[c._id] = c.n;
      countMap.ALL += c.n;
    });
    return { rows, counts: countMap, total, page, limit };
  }

  // One request with its transfer in full — units, batches and history.
  static async getById(side, id, dataAccess) {
    if (!mongoose.isValidObjectId(id)) throw new AppError("Request not found", 404);
    const request = await StockTransferRequestModel.findOne({ _id: id, isActive: true })
      .populate({ path: "requestingBranchId", select: "name code city" })
      .populate({ path: "sourceBranchId", select: "name code city" })
      .populate({ path: "transferId" })
      .populate(PEOPLE_BRANCHES)
      .lean();
    // Scope is checked on the raw ids, not the populated branches.
    const scoped = request && { requestingBranchId: request.requestingBranchId?._id, sourceBranchId: request.sourceBranchId?._id };
    if (!request || !SIDE_STATUSES[side].includes(request.status) || !isWithinDataScope(scoped, dataAccess, SIDE_MODULE[side]))
      throw new AppError("Request not found", 404);
    return request;
  }

  /* ---------------------------------------------------------------------- */
  /* Send / Decline — the branch that was asked                             */
  /* ---------------------------------------------------------------------- */

  /*
    body: {
      lines: [{ lineId, items: [{ productDefinitionId, qty, inventoryItemIds, unitNotes }] }],
      reason, note
    }
    Each request line (a category) is filled from one or more of that
    category's products. reason is required when less than asked is sent.
  */
  static async send(id, body, user, session, dataAccess) {
    const request = await load(id, TRANSFER_REQUEST_STATUS.PENDING, session);
    assertBranch(dataAccess, request.sourceBranchId, "Only the branch this request was sent to can send stock against it");
    const before = request.toObject();

    const lineById = new Map(request.lines.map((l) => [String(l._id), l]));
    const qtyByLine = new Map();
    const input = [];
    for (const l of body.lines || []) {
      const line = lineById.get(String(l.lineId));
      if (!line) throw new AppError("Invalid: a line does not belong to this request", 400);
      const items = (l.items || []).filter((it) => Number(it.qty) > 0);
      // Every product sent must belong to the category asked for.
      const defIds = items.map((it) => it.productDefinitionId);
      const inCategory = await StockProductDefinitionModel.countDocuments({ _id: { $in: defIds }, categoryId: line.categoryId, isActive: true }).session(session);
      if (inCategory !== new Set(defIds.map(String)).size)
        throw new AppError(`Invalid: ${line.categoryPath} — send only products of this category`, 400);
      const qty = round3(items.reduce((s, it) => s + Number(it.qty), 0));
      if (qty > line.requestedQty)
        throw new AppError(`Invalid: ${line.categoryPath} — asked for ${line.requestedQty}, sending ${qty}`, 400);
      qtyByLine.set(String(line._id), qty);
      items.forEach((it) => input.push({
        productDefinitionId: it.productDefinitionId, qty: Number(it.qty), inventoryItemIds: it.inventoryItemIds, unitNotes: it.unitNotes,
        // So Correct & Resend can correct this line's sentQty.
        requestLineId: line._id,
      }));
    }
    if (!input.length) throw new AppError("Invalid: nothing to send — use Decline instead", 400);

    const short = request.lines.some((l) => (qtyByLine.get(String(l._id)) || 0) < l.requestedQty);
    const reason = String(body.reason || "").trim();
    if (short && !reason) throw new AppError("A reason is required for what is not being sent", 400);

    const prepared = await StockTransferService.prepareLines(input, request.sourceBranchId, session);
    const transfer = await StockTransferService.dispatch({ request, lines: prepared, note: body.note, user, session });

    request.lines.forEach((l) => { l.sentQty = qtyByLine.get(String(l._id)) || 0; });
    request.status = TRANSFER_REQUEST_STATUS.ON_THE_WAY;
    request.reason = short ? reason : "";
    request.processedBy = user?._id || null;
    request.processedByName = user?.name || "";
    request.processedAt = new Date();
    request.transferId = transfer._id;
    request.transferNumber = transfer.transferNumber;
    await request.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "SEND", actor: user, before, after: request.toObject(),
    });
    return request;
  }

  /*
    What the Send page offers, read on the sending branch, under Requests to
    Us — so the store needs no Inventory or Product permission of its own:
      sendOptions  each request line's products with what is free to send
      sendUnits    one product's free units (serials / MACs) to tick
  */
  static async _pendingForSender(id, dataAccess) {
    if (!mongoose.isValidObjectId(id)) throw new AppError("Request not found", 404);
    const request = await StockTransferRequestModel.findOne({ _id: id, isActive: true }).lean();
    if (!request || !isWithinDataScope(request, dataAccess, SIDE_MODULE["to-us"])) throw new AppError("Request not found", 404);
    if (request.status !== TRANSFER_REQUEST_STATUS.PENDING) throw new AppError("Invalid: this request is not waiting to be sent", 400);
    return request;
  }

  static _free(branchId) {
    return { branchId, isActive: true, status: ITEM_STATUS.AVAILABLE, approvalStatus: ITEM_APPROVAL_STATUS.APPROVED };
  }

  // { [lineId]: [{ _id, name, trackingMethod, unit, available }] } — products
  // with the most free stock first.
  static async sendOptions(id, dataAccess) {
    const request = await StockTransferRequestService._pendingForSender(id, dataAccess);
    const products = await StockProductDefinitionModel.find({ categoryId: { $in: request.lines.map((l) => l.categoryId) }, isActive: true })
      .select("name trackingMethod unit categoryId")
      .lean();
    const free = await StockInventoryItemModel.aggregate([
      { $match: { ...StockTransferRequestService._free(request.sourceBranchId), productDefinitionId: { $in: products.map((p) => p._id) } } },
      { $group: { _id: "$productDefinitionId", qty: { $sum: { $ifNull: ["$quantity", 1] } } } },
    ]);
    const freeBy = new Map(free.map((f) => [String(f._id), round3(f.qty)]));
    return Object.fromEntries(
      request.lines.map((l) => [
        String(l._id),
        products
          .filter((p) => String(p.categoryId) === String(l.categoryId))
          .map((p) => ({ _id: p._id, name: p.name, trackingMethod: p.trackingMethod, unit: p.unit || null, available: freeBy.get(String(p._id)) || 0 }))
          .sort((a, b) => b.available - a.available || a.name.localeCompare(b.name)),
      ])
    );
  }

  // { fields: [{ code, label }], units: [{ _id, fieldValues }] } — oldest first.
  static async sendUnits(id, productDefinitionId, dataAccess) {
    const request = await StockTransferRequestService._pendingForSender(id, dataAccess);
    if (!mongoose.isValidObjectId(productDefinitionId)) throw new AppError("Product not found", 404);
    const def = await StockProductDefinitionModel.findOne({ _id: productDefinitionId, isActive: true })
      .select("categoryId selectedFields")
      .populate({ path: "selectedFields.fieldDefId", select: "code label showList" })
      .lean();
    if (!def || !request.lines.some((l) => String(l.categoryId) === String(def.categoryId)))
      throw new AppError("Invalid: this product is not in a category the request asks for", 400);
    const fields = (def.selectedFields || [])
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((sf) => sf.fieldDefId)
      .filter((fd) => fd && (fd.showList ?? true))
      .map((fd) => ({ code: fd.code, label: fd.label }));
    const units = await StockInventoryItemModel.find({ ...StockTransferRequestService._free(request.sourceBranchId), productDefinitionId: def._id, quantity: null })
      .select("fieldValues")
      .sort({ receivedAt: 1 })
      .lean();
    return { fields, units };
  }

  static async decline(id, body, user, session, dataAccess) {
    const request = await load(id, TRANSFER_REQUEST_STATUS.PENDING, session);
    assertBranch(dataAccess, request.sourceBranchId, "Only the branch this request was sent to can decline it");
    const before = request.toObject();
    const now = new Date();
    request.status = TRANSFER_REQUEST_STATUS.DECLINED;
    request.reason = String(body.reason || "").trim();
    request.processedBy = user?._id || null;
    request.processedByName = user?.name || "";
    request.processedAt = now;
    request.closedAt = now;
    request.closedBy = actorSnapshot(user);
    await request.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "DECLINE", actor: user, before, after: request.toObject(), reason: request.reason,
    });
    return request;
  }

  /* ---------------------------------------------------------------------- */
  /* All Received / Report Problem — the branch that asked                  */
  /* ---------------------------------------------------------------------- */

  static async receive(id, user, session, dataAccess) {
    const request = await load(id, TRANSFER_REQUEST_STATUS.ON_THE_WAY, session);
    assertBranch(dataAccess, request.requestingBranchId, "Only the branch that asked for this stock can receive it");
    const before = request.toObject();
    await StockTransferService.confirm(request.transferId, user, session);
    request.status = TRANSFER_REQUEST_STATUS.RECEIVED;
    request.closedAt = new Date();
    request.closedBy = actorSnapshot(user);
    await request.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "RECEIVE", actor: user, before, after: request.toObject(),
    });
    return request;
  }

  static async reportProblem(id, body, user, session, dataAccess) {
    const note = String(body?.note || "").trim();
    if (!note) throw new AppError("A note is required — say what is wrong", 400);
    const request = await load(id, TRANSFER_REQUEST_STATUS.ON_THE_WAY, session);
    assertBranch(dataAccess, request.requestingBranchId, "Only the branch that asked for this stock can report a problem");
    const before = request.toObject();
    await StockTransferService.reportProblem(request.transferId, note, user, session);
    request.status = TRANSFER_REQUEST_STATUS.MISMATCH;
    await request.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "REPORT_PROBLEM", actor: user, before, after: request.toObject(), reason: note,
    });
    return request;
  }

  /* ---------------------------------------------------------------------- */
  /* Correct & Resend — the branch that sent                                */
  /* ---------------------------------------------------------------------- */

  // body: see StockTransferService.correct. Back On the Way for the requester.
  static async correct(id, body, user, session, dataAccess) {
    const request = await load(id, TRANSFER_REQUEST_STATUS.MISMATCH, session);
    assertBranch(dataAccess, request.sourceBranchId, "Only the branch that sent this stock can correct it");
    const before = request.toObject();
    const { removedByRequestLine } = await StockTransferService.correct(request.transferId, body, user, session);

    // The request shows what is really on the way now.
    request.lines.forEach((l) => {
      const off = removedByRequestLine.get(String(l._id)) || 0;
      if (off) l.sentQty = round3(Math.max(0, (l.sentQty || 0) - off));
    });
    if (removedByRequestLine.size && !request.reason) {
      request.reason = "Less went than first sent — corrected after the requesting branch reported a problem";
    }
    request.status = TRANSFER_REQUEST_STATUS.ON_THE_WAY;
    await request.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "CORRECT", actor: user, before, after: request.toObject(),
    });
    return request;
  }
}
