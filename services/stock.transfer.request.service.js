import mongoose from "mongoose";
import StockTransferRequestModel from "../models/stock.transfer.request.model.js";
import StockBranchModel from "../models/stock.branch.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import { paginate } from "../helpers/pagination.helper.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import { isWithinDataScope, resolveDimensionAllowList } from "../helpers/data.scope.helper.js";

const SCOPE_MODULE_KEY = "transfer-requests";
import {
  TRACKING_METHODS,
  TRANSFER_REQUEST_STATUS,
  ITEM_STATUS,
  ITEM_APPROVAL_STATUS,
  ITEM_MOVEMENT_TYPE,
  ITEM_MOVEMENT_REF,
} from "../constants/stock.enums.js";
import StockItemMovementService from "./stock.item.movement.service.js";

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ENTITY_TYPE = "transfer-requests";
const transferRef = (request) => ({
  type: ITEM_MOVEMENT_REF.TRANSFER_REQUEST,
  refId: request._id,
  refNumber: request.requestNumber,
});

// Guard for every mutation. A transfer is in scope if EITHER of its two
// branches is — the registry declares both fields, the helper ORs them.
const assertDataScope = (request, dataAccess) => {
  if (!isWithinDataScope(request, dataAccess, SCOPE_MODULE_KEY)) {
    throw new Error("Transfer request not found");
  }
};

export default class StockTransferRequestService {
  static async generateRequestNumber(session) {
    const year = new Date().getFullYear();
    const prefix = `TRF-${year}-`;
    const count = await StockTransferRequestModel.countDocuments({
      requestNumber: new RegExp(`^${prefix}`),
    }).session(session);
    return `${prefix}${String(count + 1).padStart(4, "0")}`;
  }

  /* ---------------------------------------------------------------------- */
  /* Branch pickers for the transfer screens                               */
  /* ---------------------------------------------------------------------- */

  // Both halves of a transfer form in one call, because it needs both:
  //
  //  - `branches` is every active branch. The *counterparty* of a transfer
  //    is by definition outside your own branch, so branch-scoping this list
  //    would make cross-branch transfers impossible to raise at all.
  //  - `defaultBranchId` is the caller's own branch — you ask for stock on
  //    behalf of the branch you belong to, so the requesting side of the form
  //    is read-only and this is what it displays. null means no branch assigned.
  //
  // Served on the transfer-requests module rather than /branches/active's
  // `branches:READ`: needing a branch list to raise a transfer must not
  // force branch-master permission (and the nav entry it unlocks) on
  // ordinary branch staff.
  static async getFormBranches(dataAccess) {
    const branches = await StockBranchModel.find({ isActive: true }).sort({ name: 1 }).lean();

    const activeIds = new Set(branches.map((l) => String(l._id)));
    const branchIds = resolveDimensionAllowList(dataAccess, "branch");
    // null = unrestricted (admin / ALL_BRANCHES). Otherwise intersect, so a
    // stale or deactivated branch id never resolves to a usable branch.
    const scopedIds =
      branchIds === null ? [...activeIds] : branchIds.filter((id) => activeIds.has(id));

    const ownBranchId = dataAccess?.userBranchId ? String(dataAccess.userBranchId) : null;
    // Own branch when it is in scope; otherwise only an unambiguous single
    // scoped branch counts — never an arbitrary pick out of several.
    const defaultBranchId = scopedIds.includes(ownBranchId)
      ? ownBranchId
      : scopedIds.length === 1
        ? scopedIds[0]
        : null;

    return { branches, defaultBranchId };
  }

  /* ---------------------------------------------------------------------- */
  /* Create — Branch A requests N units from Branch B                        */
  /* ---------------------------------------------------------------------- */

  static async createTransferRequest(body, user, session, dataAccess) {
    const { requestingBranchId, sourceBranchId, lines, remarks } = body;

    // Sequential, not Promise.all — two operations can't run concurrently on
    // the same MongoDB session/transaction (causes NoSuchTransaction errors).
    const requestingBranch = await StockBranchModel.findOne({ _id: requestingBranchId, isActive: true })
      .session(session)
      .lean();
    if (!requestingBranch) throw new Error("Requesting branch not found");
    // Only the requesting side is scoped. Standing in for someone else's
    // branch would put a request on their board that they never raised; the
    // source side stays open, since asking another branch for stock is the
    // entire point of the feature.
    if (!isWithinDataScope(requestingBranch, dataAccess, "branches")) {
      throw new Error("You do not have permission to raise a request for this branch");
    }

    const sourceBranch = await StockBranchModel.findOne({ _id: sourceBranchId, isActive: true })
      .session(session)
      .lean();
    if (!sourceBranch) throw new Error("Source branch not found");

    const resolvedLines = [];
    for (const l of lines) {
      const def = await StockProductDefinitionModel.findOne({
        _id: l.productDefinitionId,
        isActive: true,
      })
        .session(session)
        .lean();
      if (!def) throw new Error("One of the requested products could not be found");
      resolvedLines.push({
        productDefinitionId: def._id,
        productName: def.name,
        trackingMethod: def.trackingMethod,
        unit: def.unit,
        requestedQty: l.requestedQty,
      });
    }

    const requestNumber = await StockTransferRequestService.generateRequestNumber(session);

    const [request] = await StockTransferRequestModel.create(
      [
        {
          requestNumber,
          requestingBranchId,
          sourceBranchId,
          lines: resolvedLines,
          status: TRANSFER_REQUEST_STATUS.PENDING,
          remarks: remarks || "",
          requestedBy: user?.id || null,
          requestedByName: body.requestedByName || user?.name || "",
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
  /* List — powers "My Requests" / "Requests to Me" / "All" tabs             */
  /* ---------------------------------------------------------------------- */

  static async getBoard(query = {}, dataAccess) {
    const { branchId, role, status, search } = query;

    const filter = { isActive: true };
    const and = [];

    // A transfer request touches two branches — in scope if either side is
    // one of the caller's allowed branches. Explicit ObjectId cast: this
    // filter also feeds the counts .aggregate() below, which — unlike
    // .find() — never auto-casts string ids (see branchObjId above).
    const scopedBranchIds = resolveDimensionAllowList(dataAccess, "branch");
    if (scopedBranchIds !== null) {
      const scopedObjIds = scopedBranchIds.map((id) => new mongoose.Types.ObjectId(id));
      and.push({
        $or: [
          { requestingBranchId: { $in: scopedObjIds } },
          { sourceBranchId: { $in: scopedObjIds } },
        ],
      });
    }

    // Cast explicitly — .aggregate()'s $match (used below for status counts)
    // does not auto-cast query strings to ObjectId the way .find() does, so
    // a raw string here would silently match zero documents in the count
    // pipeline while .find() kept working fine.
    const branchObjId = branchId && mongoose.Types.ObjectId.isValid(branchId)
      ? new mongoose.Types.ObjectId(branchId)
      : null;

    if (branchObjId && role === "requesting") filter.requestingBranchId = branchObjId;
    else if (branchObjId && role === "source") filter.sourceBranchId = branchObjId;
    else if (branchObjId)
      and.push({ $or: [{ requestingBranchId: branchObjId }, { sourceBranchId: branchObjId }] });

    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      and.push({ $or: [{ requestNumber: regex }, { "lines.productName": regex }] });
    }
    if (and.length) filter.$and = and;

    const [allRows, counts] = await Promise.all([
      StockTransferRequestModel.find(filter)
        .populate({ path: "requestingBranchId", select: "name code" })
        .populate({ path: "sourceBranchId", select: "name code" })
        .sort({ createdAt: -1 })
        .lean(),
      StockTransferRequestModel.aggregate([{ $match: filter }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    ]);

    const countMap = { ALL: 0, PENDING: 0, COMPLETED: 0, REJECTED: 0 };
    counts.forEach((c) => {
      if (countMap[c._id] !== undefined) countMap[c._id] = c.count;
      countMap.ALL += c.count;
    });

    const filteredRows = status ? allRows.filter((r) => r.status === status) : allRows;

    const { skip, limit, page } = paginate(query);
    const total = filteredRows.length;
    const pageSlice = filteredRows.slice(skip, skip + limit);

    const paged = pageSlice.map((r) => ({
      ...r,
      totalRequestedQty: (r.lines || []).reduce((s, l) => s + (l.requestedQty || 0), 0),
      totalTransferredQty: (r.lines || []).reduce((s, l) => s + (l.transferredQty || 0), 0),
      itemsSummary: (r.lines || []).map((l) => l.productName).join(", "),
    }));

    return {
      data: { rows: paged, counts: countMap },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  static async getTransferRequestById(id, dataAccess) {
    const request = await StockTransferRequestModel.findOne({ _id: id, isActive: true })
      .populate({ path: "requestingBranchId", select: "name code city state branchRole" })
      .populate({ path: "sourceBranchId", select: "name code city state branchRole" })
      .populate({ path: "lines.transferredInventoryItemIds", select: "fieldValues quantity" })
      .lean();
    if (!request || !isWithinDataScope(request, dataAccess, SCOPE_MODULE_KEY)) {
      throw new Error("Transfer request not found");
    }
    return request;
  }

  /* ---------------------------------------------------------------------- */
  /* Stock movement helpers                                                  */
  /* ---------------------------------------------------------------------- */

  /*
    Quantity-tracked: consume FIFO across the source's available batches, and
    for every batch drawn from, open a matching batch at the destination.

    One destination batch PER SOURCE BATCH, not one merged batch: each source
    batch carries its own origin, vendor, cost and warranty, and 30 m of
    cable from invoice A plus 20 m from opening stock are not one 50 m lot
    with a single history. Merging them is what used to make transferred
    stock vanish from the batch breakdown — it had no invoice to group under.
  */
  static async _moveQuantityStock(productDefinitionId, sourceBranchId, destinationBranchId, qty, request, session) {
    const batches = await StockInventoryItemModel.find({
      productDefinitionId,
      branchId: sourceBranchId,
      isActive: true,
      status: ITEM_STATUS.AVAILABLE,
      approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
      quantity: { $gt: 0 },
    })
      .sort({ receivedAt: 1 })
      .session(session);

    const availableTotal = batches.reduce((s, b) => s + (b.quantity || 0), 0);
    if (availableTotal < qty)
      throw new Error(`Not enough available stock at the source branch (have ${availableTotal}, need ${qty})`);

    const movements = [];
    let remaining = qty;
    for (const batch of batches) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, batch.quantity);
      batch.quantity -= take;
      remaining -= take;
      await batch.save({ session });
      const src = batch.toObject();

      // Everything that describes the stock travels with it; only where it
      // sits and how much changes. receivedAt is kept so FIFO still means
      // "oldest in the company", not "most recently moved".
      const [moved] = await StockInventoryItemModel.create(
        [
          {
            productDefinitionId,
            vendorId: src.vendorId,
            branchId: destinationBranchId,
            invoiceId: src.invoiceId,
            status: ITEM_STATUS.AVAILABLE,
            approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
            isFoc: src.isFoc,
            quantity: take,
            fieldValues: src.fieldValues,
            source: src.source,
            condition: src.condition,
            warranty: src.warranty,
            purchaseCost: src.purchaseCost,
            purchaseDate: src.purchaseDate,
            legacy: src.legacy,
            receivedAt: src.receivedAt,
            receivedBy: src.receivedBy,
          },
        ],
        { session }
      );

      const base = {
        productDefinitionId,
        type: ITEM_MOVEMENT_TYPE.TRANSFERRED,
        quantity: take,
        fromBranchId: sourceBranchId,
        toBranchId: destinationBranchId,
        status: ITEM_STATUS.AVAILABLE,
        ref: transferRef(request),
      };
      movements.push(
        { ...base, inventoryItemId: batch._id, relatedItemId: moved._id },
        { ...base, inventoryItemId: moved._id, relatedItemId: batch._id }
      );
    }
    await StockItemMovementService.record(movements, session);
  }

  // Individual-tracked: flip branchId on the exact units the source chose.
  static async _moveIndividualStock(inventoryItemIds, productDefinitionId, sourceBranchId, destinationBranchId, request, session) {
    const items = await StockInventoryItemModel.find({
      _id: { $in: inventoryItemIds },
      isActive: true,
    }).session(session);

    if (items.length !== inventoryItemIds.length)
      throw new Error("One or more selected units could not be found");

    for (const item of items) {
      if (String(item.productDefinitionId) !== String(productDefinitionId))
        throw new Error("A selected unit does not match the requested product");
      if (String(item.branchId) !== String(sourceBranchId))
        throw new Error("A selected unit is not available at the source branch");
      if (item.status !== ITEM_STATUS.AVAILABLE || item.approvalStatus !== ITEM_APPROVAL_STATUS.APPROVED)
        throw new Error("A selected unit is not currently available for transfer");
    }

    await StockInventoryItemModel.updateMany(
      { _id: { $in: inventoryItemIds } },
      { $set: { branchId: destinationBranchId } },
      { session }
    );
    await StockItemMovementService.record(
      items.map((item) => ({
        inventoryItemId: item._id,
        productDefinitionId,
        type: ITEM_MOVEMENT_TYPE.TRANSFERRED,
        fromBranchId: sourceBranchId,
        toBranchId: destinationBranchId,
        status: item.status,
        ref: transferRef(request),
      })),
      session
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Process — Branch B fulfils full or partial quantity, in one shot.       */
  /* Whatever isn't transferred is auto-closed as rejectedQty; the request   */
  /* always ends COMPLETED (use reject() instead to decline everything).    */
  /* ---------------------------------------------------------------------- */

  static async processTransferRequest(id, body, user, session, dataAccess) {
    const request = await StockTransferRequestModel.findOne({ _id: id, isActive: true }).session(session);
    if (!request) throw new Error("Transfer request not found");
    assertDataScope(request, dataAccess);
    if (request.status !== TRANSFER_REQUEST_STATUS.PENDING)
      throw new Error("Only pending requests can be processed");
    const before = request.toObject();

    const lineById = new Map(request.lines.map((l) => [String(l._id), l]));
    let anyShortfall = false;

    for (const input of body.lines) {
      const line = lineById.get(String(input.lineId));
      if (!line) throw new Error("One of the submitted lines does not belong to this request");

      const transferQty = Number(input.transferQty) || 0;
      if (transferQty > line.requestedQty)
        throw new Error(`${line.productName}: transfer quantity cannot exceed the requested quantity`);

      if (transferQty > 0) {
        if (line.trackingMethod === TRACKING_METHODS.INDIVIDUAL) {
          const ids = input.inventoryItemIds || [];
          if (ids.length !== transferQty)
            throw new Error(`${line.productName}: select exactly ${transferQty} unit(s) to transfer`);
          await StockTransferRequestService._moveIndividualStock(
            ids,
            line.productDefinitionId,
            request.sourceBranchId,
            request.requestingBranchId,
            request,
            session
          );
          line.transferredInventoryItemIds = ids;
        } else {
          await StockTransferRequestService._moveQuantityStock(
            line.productDefinitionId,
            request.sourceBranchId,
            request.requestingBranchId,
            transferQty,
            request,
            session
          );
        }
      }

      line.transferredQty = transferQty;
      line.rejectedQty = line.requestedQty - transferQty;
      if (line.rejectedQty > 0) anyShortfall = true;
    }

    if (anyShortfall && !String(body.reason || "").trim())
      throw new Error("A reason is required for the quantity that could not be transferred");

    request.status = TRANSFER_REQUEST_STATUS.COMPLETED;
    request.reason = anyShortfall ? String(body.reason).trim() : "";
    request.processedBy = user?.id || null;
    request.processedByName = body.processedByName || user?.name || "";
    request.processedAt = new Date();

    await request.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "PROCESS", actor: user, before, after: request.toObject(),
    });
    return request;
  }

  /* ---------------------------------------------------------------------- */
  /* Reject — Branch B declines the whole request, nothing transferred.      */
  /* ---------------------------------------------------------------------- */

  static async rejectTransferRequest(id, body, user, session, dataAccess) {
    const request = await StockTransferRequestModel.findOne({ _id: id, isActive: true }).session(session);
    if (!request) throw new Error("Transfer request not found");
    assertDataScope(request, dataAccess);
    if (request.status !== TRANSFER_REQUEST_STATUS.PENDING)
      throw new Error("Only pending requests can be rejected");
    const before = request.toObject();

    request.lines.forEach((line) => {
      line.transferredQty = 0;
      line.rejectedQty = line.requestedQty;
    });
    request.status = TRANSFER_REQUEST_STATUS.REJECTED;
    request.reason = String(body.reason).trim();
    request.processedBy = user?.id || null;
    request.processedByName = body.processedByName || user?.name || "";
    request.processedAt = new Date();

    await request.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "REJECT", actor: user, before, after: request.toObject(),
      reason: request.reason,
    });
    return request;
  }
}
