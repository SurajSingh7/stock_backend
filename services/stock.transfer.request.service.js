import mongoose from "mongoose";
import StockTransferRequestModel from "../models/stock.transfer.request.model.js";
import StockWarehouseModel from "../models/stock.warehouse.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import { paginate } from "../helpers/pagination.helper.js";
import {
  TRACKING_METHODS,
  TRANSFER_REQUEST_STATUS,
  ITEM_STATUS,
  ITEM_APPROVAL_STATUS,
} from "../constants/stock.enums.js";

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
  /* Create — Branch A requests N units from Branch B                        */
  /* ---------------------------------------------------------------------- */

  static async createTransferRequest(body, user, session) {
    const { requestingLocationId, sourceLocationId, lines, remarks } = body;

    // Sequential, not Promise.all — two operations can't run concurrently on
    // the same MongoDB session/transaction (causes NoSuchTransaction errors).
    const requestingLoc = await StockWarehouseModel.findOne({ _id: requestingLocationId, isActive: true })
      .session(session)
      .lean();
    if (!requestingLoc) throw new Error("Requesting location not found");

    const sourceLoc = await StockWarehouseModel.findOne({ _id: sourceLocationId, isActive: true })
      .session(session)
      .lean();
    if (!sourceLoc) throw new Error("Source location not found");

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
          requestingLocationId,
          sourceLocationId,
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
    return request;
  }

  /* ---------------------------------------------------------------------- */
  /* List — powers "My Requests" / "Requests to Me" / "All" tabs             */
  /* ---------------------------------------------------------------------- */

  static async getBoard(query = {}) {
    const { locationId, role, status, search } = query;

    const filter = { isActive: true };
    const and = [];

    // Cast explicitly — .aggregate()'s $match (used below for status counts)
    // does not auto-cast query strings to ObjectId the way .find() does, so
    // a raw string here would silently match zero documents in the count
    // pipeline while .find() kept working fine.
    const locObjId = locationId && mongoose.Types.ObjectId.isValid(locationId)
      ? new mongoose.Types.ObjectId(locationId)
      : null;

    if (locObjId && role === "requesting") filter.requestingLocationId = locObjId;
    else if (locObjId && role === "source") filter.sourceLocationId = locObjId;
    else if (locObjId)
      and.push({ $or: [{ requestingLocationId: locObjId }, { sourceLocationId: locObjId }] });

    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      and.push({ $or: [{ requestNumber: regex }, { "lines.productName": regex }] });
    }
    if (and.length) filter.$and = and;

    const [allRows, counts] = await Promise.all([
      StockTransferRequestModel.find(filter)
        .populate({ path: "requestingLocationId", select: "name code" })
        .populate({ path: "sourceLocationId", select: "name code" })
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

  static async getTransferRequestById(id) {
    const request = await StockTransferRequestModel.findOne({ _id: id, isActive: true })
      .populate({ path: "requestingLocationId", select: "name code city state locationRole" })
      .populate({ path: "sourceLocationId", select: "name code city state locationRole" })
      .populate({ path: "lines.transferredInventoryItemIds", select: "fieldValues quantity" })
      .lean();
    if (!request) throw new Error("Transfer request not found");
    return request;
  }

  /* ---------------------------------------------------------------------- */
  /* Stock movement helpers                                                  */
  /* ---------------------------------------------------------------------- */

  // Quantity-tracked: consume FIFO across the source's available batches,
  // create one new AVAILABLE batch at the destination.
  static async _moveQuantityStock(productDefinitionId, sourceLocationId, destinationLocationId, qty, user, session) {
    const batches = await StockInventoryItemModel.find({
      productDefinitionId,
      warehouseId: sourceLocationId,
      isActive: true,
      status: ITEM_STATUS.AVAILABLE,
      approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
      quantity: { $gt: 0 },
    })
      .sort({ receivedAt: 1 })
      .session(session);

    const availableTotal = batches.reduce((s, b) => s + (b.quantity || 0), 0);
    if (availableTotal < qty)
      throw new Error(`Not enough available stock at the source location (have ${availableTotal}, need ${qty})`);

    let remaining = qty;
    for (const batch of batches) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, batch.quantity);
      batch.quantity -= take;
      remaining -= take;
      await batch.save({ session });
    }

    await StockInventoryItemModel.create(
      [
        {
          productDefinitionId,
          warehouseId: destinationLocationId,
          status: ITEM_STATUS.AVAILABLE,
          approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
          quantity: qty,
          receivedAt: new Date(),
          receivedBy: user?.id || null,
        },
      ],
      { session }
    );
  }

  // Individual-tracked: flip warehouseId on the exact units the source chose.
  static async _moveIndividualStock(inventoryItemIds, productDefinitionId, sourceLocationId, destinationLocationId, session) {
    const items = await StockInventoryItemModel.find({
      _id: { $in: inventoryItemIds },
      isActive: true,
    }).session(session);

    if (items.length !== inventoryItemIds.length)
      throw new Error("One or more selected units could not be found");

    for (const item of items) {
      if (String(item.productDefinitionId) !== String(productDefinitionId))
        throw new Error("A selected unit does not match the requested product");
      if (String(item.warehouseId) !== String(sourceLocationId))
        throw new Error("A selected unit is not available at the source location");
      if (item.status !== ITEM_STATUS.AVAILABLE || item.approvalStatus !== ITEM_APPROVAL_STATUS.APPROVED)
        throw new Error("A selected unit is not currently available for transfer");
    }

    await StockInventoryItemModel.updateMany(
      { _id: { $in: inventoryItemIds } },
      { $set: { warehouseId: destinationLocationId } },
      { session }
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Process — Branch B fulfils full or partial quantity, in one shot.       */
  /* Whatever isn't transferred is auto-closed as rejectedQty; the request   */
  /* always ends COMPLETED (use reject() instead to decline everything).    */
  /* ---------------------------------------------------------------------- */

  static async processTransferRequest(id, body, user, session) {
    const request = await StockTransferRequestModel.findOne({ _id: id, isActive: true }).session(session);
    if (!request) throw new Error("Transfer request not found");
    if (request.status !== TRANSFER_REQUEST_STATUS.PENDING)
      throw new Error("Only pending requests can be processed");

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
            request.sourceLocationId,
            request.requestingLocationId,
            session
          );
          line.transferredInventoryItemIds = ids;
        } else {
          await StockTransferRequestService._moveQuantityStock(
            line.productDefinitionId,
            request.sourceLocationId,
            request.requestingLocationId,
            transferQty,
            user,
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
    return request;
  }

  /* ---------------------------------------------------------------------- */
  /* Reject — Branch B declines the whole request, nothing transferred.      */
  /* ---------------------------------------------------------------------- */

  static async rejectTransferRequest(id, body, user, session) {
    const request = await StockTransferRequestModel.findOne({ _id: id, isActive: true }).session(session);
    if (!request) throw new Error("Transfer request not found");
    if (request.status !== TRANSFER_REQUEST_STATUS.PENDING)
      throw new Error("Only pending requests can be rejected");

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
    return request;
  }
}
