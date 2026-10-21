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
import {
  TRACKING_METHODS,
  CATEGORY_TYPES,
  ITEM_STATUS,
  ITEM_APPROVAL_STATUS,
  ITEM_CONDITION,
  ITEM_MOVEMENT_TYPE,
  ITEM_MOVEMENT_REF,
  ITEM_REQUEST_STATUS,
  ITEM_REQUEST_STATUS_ARRAY,
  ITEM_REQUEST_CHANNEL_ARRAY,
} from "../constants/stock.enums.js";

/*
  Item Requests — stock issued to subscribers.

  A request asks for a CATEGORY and a quantity ("5 × Wireless ONT / Single
  Band"). Which product goes out is the store's call, and one request may be
  filled from several products of that category.

  Two sides, one service:

    Requester (the NOC / broadband website through the external API, or the
    test simulator): reads the catalog, sends a request, watches it, and resends
    it if the store rejected it. Every requester call carries its CHANNEL, and a
    channel only ever sees its own requests.

    Store (this app, branch-scoped like the rest of stock): issues units —
    partially if need be — short-closes, or rejects.

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

// What was handed over, per product, across every visit.
const issuedByProduct = (issues = []) => {
  const map = new Map();
  for (const iss of issues)
    for (const l of iss.lines || []) {
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

  static async catalogMixedCategories() {
    return (await StockItemRequestService._catalog()).mixed;
  }

  /* ====================================================================== */
  /* Requester side                                                         */
  /* ====================================================================== */

  // Branch, one leaf category, and how many.
  static async _resolveRequestBody(body, session) {
    if (!mongoose.isValidObjectId(body?.branchId)) throw new AppError("Branch is required", 400);
    const branch = await StockBranchModel.findOne({ _id: body.branchId, isActive: true }).session(session).lean();
    if (!branch) throw new AppError("Invalid branch selected", 400);

    if (!mongoose.isValidObjectId(body?.categoryId)) throw new AppError("Category is required", 400);
    const category = await StockCategoryModel.findOne({ _id: body.categoryId, isActive: true }).session(session).lean();
    if (!category) throw new AppError("Invalid category selected", 400);
    if (category.type !== CATEGORY_TYPES.LEAF) throw new AppError("Invalid category: pick the last level (a leaf category)", 400);
    const { trackingMethod, unit } = await StockItemRequestService._categoryKind(category._id, session);

    const qty = Number(body.quantity);
    if (!Number.isFinite(qty) || qty <= 0) throw new AppError("Quantity must be more than 0", 400);
    if (trackingMethod === TRACKING_METHODS.INDIVIDUAL && !Number.isInteger(qty))
      throw new AppError("Quantity must be a whole number for this category", 400);

    return {
      branch,
      category,
      categoryPath: await StockCategoryService.buildDisplayPath(category.path, session),
      trackingMethod,
      unit,
      requestedQty: round3(qty),
    };
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
    const resolved = await StockItemRequestService._resolveRequestBody(body, session);
    const { subscriber, snapshot } = await StockItemRequestService._upsertSubscriber(channel, body.subscriber, session);
    const requestedBy = { externalUserId: text(body.requestedBy?.id, 100), name: text(body.requestedBy?.name, 150) };

    const requestNumber = await nextDocumentNumber({ model: StockItemRequestModel, field: "requestNumber", prefix: "REQ", session });
    const [request] = await StockItemRequestModel.create(
      [
        {
          requestNumber,
          channel,
          branchId: resolved.branch._id,
          subscriberId: subscriber._id,
          subscriber: snapshot,
          categoryId: resolved.category._id,
          categoryPath: resolved.categoryPath,
          trackingMethod: resolved.trackingMethod,
          unit: resolved.unit,
          requestedQty: resolved.requestedQty,
          requestedBy,
          remarks: text(body.remarks, 1000),
          history: [{ action: "CREATED", byName: requestedBy.name, note: `${resolved.categoryPath} × ${resolved.requestedQty}` }],
        },
      ],
      { session }
    );
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "CREATE", actor: { name: requestedBy.name }, before: null, after: request.toObject(),
    });
    return StockItemRequestService._requesterView(request.toObject());
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

    const resolved = await StockItemRequestService._resolveRequestBody(body, session);
    const { subscriber, snapshot } = await StockItemRequestService._upsertSubscriber(
      channel,
      { ...body.subscriber, orderId: request.subscriber.orderId }, // the request stays with its subscriber
      session
    );
    const byName = text(body.requestedBy?.name, 150) || request.requestedBy?.name || "";

    request.branchId = resolved.branch._id;
    request.categoryId = resolved.category._id;
    request.categoryPath = resolved.categoryPath;
    request.trackingMethod = resolved.trackingMethod;
    request.unit = resolved.unit;
    request.requestedQty = resolved.requestedQty;
    request.subscriberId = subscriber._id;
    request.subscriber = snapshot;
    if (body.remarks !== undefined) request.remarks = text(body.remarks, 1000);
    request.status = ITEM_REQUEST_STATUS.PENDING;
    request.rejection = null;
    request.revision = (request.revision || 1) + 1;
    request.history.push({ action: "RESENT", byName, note: `Revision ${request.revision}: ${resolved.categoryPath} × ${resolved.requestedQty}` });
    await request.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "RESEND", actor: { name: byName }, before, after: request.toObject(),
    });
    return StockItemRequestService._requesterView(request.toObject());
  }

  // What a requester is shown: the request, and every unit handed over by its
  // product and serial.
  static _requesterView(r) {
    return {
      _id: r._id,
      requestNumber: r.requestNumber,
      status: r.status,
      revision: r.revision,
      branchId: r.branchId?._id || r.branchId,
      branchName: r.branchId?.name || undefined,
      subscriber: r.subscriber,
      categoryId: r.categoryId,
      categoryPath: r.categoryPath,
      trackingMethod: r.trackingMethod,
      unit: r.unit,
      requestedQty: r.requestedQty,
      issuedQty: r.issuedQty,
      issuedByProduct: issuedByProduct(r.issues).map(({ productName, quantity }) => ({ productName, quantity })),
      issues: (r.issues || []).map((i) => ({
        at: i.at,
        byName: i.by?.name || "",
        lines: i.lines.map((l) => ({ productName: l.productName, quantity: l.quantity, units: l.units.map((u) => u.label) })),
      })),
      rejection: r.rejection ? { reason: r.rejection.reason, at: r.rejection.at } : null,
      closure: r.closure ? { reason: r.closure.reason, at: r.closure.at } : null,
      remarks: r.remarks,
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
  static _storeFilter({ status, branchId, search }) {
    const filter = { isActive: true };
    if (status && ITEM_REQUEST_STATUS_ARRAY.includes(status)) filter.status = status;
    if (branchId && mongoose.isValidObjectId(branchId)) filter.branchId = oid(branchId);
    if (search) {
      const rx = { $regex: escapeRegex(String(search).trim()), $options: "i" };
      filter.$or = [{ requestNumber: rx }, { "subscriber.orderId": rx }, { "subscriber.username": rx }, { categoryPath: rx }];
    }
    return filter;
  }

  static async list(query, dataAccess) {
    const { skip, limit } = paginate(query);
    const filter = applyDataScope(StockItemRequestService._storeFilter(query), dataAccess, MODULE_KEY);
    const [data, total] = await Promise.all([
      StockItemRequestModel.find(filter)
        .select("requestNumber status channel branchId subscriber categoryPath trackingMethod unit requestedQty issuedQty requestedBy revision createdAt updatedAt")
        .populate({ path: "branchId", select: "name code" })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StockItemRequestModel.countDocuments(filter),
    ]);
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
    The request, plus — while it is open — every active product of its
    category with how much of it is free at the request's branch, and what has
    gone out so far per product.
  */
  static async getById(id, dataAccess) {
    const request = await StockItemRequestService._load(id, null, dataAccess);
    const r = await StockItemRequestModel.findById(request._id).populate({ path: "branchId", select: "name code" }).lean();
    assertDataScope({ ...r, branchId: r.branchId?._id }, dataAccess);

    r.remainingQty = round3(Math.max(0, r.requestedQty - r.issuedQty));
    r.issuedByProduct = issuedByProduct(r.issues);
    if (OPEN_REQUEST_STATUSES.includes(r.status)) {
      const products = await StockProductDefinitionModel.find({ categoryId: r.categoryId, isActive: true })
        .select("_id name trackingMethod unit")
        .sort({ name: 1 })
        .lean();
      const free = await StockItemRequestService._freeByProduct(products.map((p) => p._id), r.branchId._id);
      r.products = products.map((p) => ({ ...p, availableQty: free.get(String(p._id)) || 0 }));
      r.availableQty = round3(r.products.reduce((s, p) => s + p.availableQty, 0));
    } else {
      r.products = [];
      r.availableQty = null;
    }
    return r;
  }

  /*
    What the store may pick from: every active product of the request's
    category, at its branch, free. Individual: the units (optionally one
    product's, or a serial search). Batch: free quantity per product.
  */
  static async availableUnits(id, { search, productId } = {}, dataAccess) {
    const request = await StockItemRequestService._load(id, null, dataAccess);
    const products = await StockProductDefinitionModel.find({ categoryId: request.categoryId, isActive: true })
      .select("_id name trackingMethod unit")
      .sort({ name: 1 })
      .lean();
    const nameById = new Map(products.map((p) => [String(p._id), p.name]));
    const ids = productId && nameById.has(String(productId)) ? [oid(productId)] : products.map((p) => p._id);

    if (request.trackingMethod === TRACKING_METHODS.INDIVIDUAL) {
      const filter = { ...FREE, productDefinitionId: { $in: ids }, branchId: request.branchId, quantity: null };
      if (search) filter.identifiers = { $regex: escapeRegex(String(search).trim().toUpperCase()) };
      const units = await StockInventoryItemModel.find(filter)
        .select("productDefinitionId fieldValues identifiers condition source warranty receivedAt")
        .sort({ receivedAt: 1 })
        .limit(500)
        .lean();
      return {
        trackingMethod: request.trackingMethod,
        products: products.map((p) => ({ _id: p._id, name: p.name })),
        units: units.map((u) => ({ ...u, label: unitLabel(u), productName: nameById.get(String(u.productDefinitionId)) || "" })),
      };
    }
    const free = await StockItemRequestService._freeByProduct(ids, request.branchId);
    return {
      trackingMethod: request.trackingMethod,
      unit: request.unit,
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
      throw new AppError(`${ids.length - units.length} chosen unit(s) are no longer available here — refresh and pick again`, 409);

    // The status in the filter is the guard against the same unit being issued
    // twice at once: the second writer matches nothing.
    const res = await StockInventoryItemModel.updateMany(
      { _id: { $in: ids }, status: ITEM_STATUS.AVAILABLE },
      { $set: { status: ITEM_STATUS.ASSIGNED, condition: ITEM_CONDITION.USED, assignedTo: ctx.assignedTo } },
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
            condition: ITEM_CONDITION.USED,
            warranty: src.warranty,
            purchaseCost: src.purchaseCost,
            purchaseDate: src.purchaseDate,
            legacy: src.legacy,
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
    Issue — hand over some or all of what is still owed, in one go, from any
    product(s) of the request's category.
      individual: { inventoryItemIds: [...] }
      batch:      { quantities: [{ productDefinitionId, quantity }] }
  */
  static async issue(id, body, user, session, dataAccess) {
    const request = await StockItemRequestService._load(id, session, dataAccess);
    if (!OPEN_REQUEST_STATUSES.includes(request.status)) throw new AppError("This request is no longer open for issuing", 400);
    const before = request.toObject();
    const remaining = round3(request.requestedQty - request.issuedQty);

    const products = await StockProductDefinitionModel.find({ categoryId: request.categoryId, isActive: true })
      .select("_id name trackingMethod unit")
      .session(session)
      .lean();
    const productById = new Map(products.map((p) => [String(p._id), p]));

    const now = new Date();
    const ctx = {
      now,
      assignedTo: {
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
    let issueLines = [];
    let total = 0;

    if (request.trackingMethod === TRACKING_METHODS.INDIVIDUAL) {
      const unitIds = Array.isArray(body?.inventoryItemIds) ? body.inventoryItemIds : [];
      if (!unitIds.length) throw new AppError("Choose at least one unit to issue", 400);
      if (new Set(unitIds.map(String)).size > remaining) throw new AppError(`Only ${remaining} left to issue on this request`, 400);
      const out = await StockItemRequestService._issueUnits(request, unitIds, products.map((p) => p._id), ctx, session);
      ({ movements, issueLines } = out);
      total = out.quantity;
    } else {
      const inputs = (Array.isArray(body?.quantities) ? body.quantities : []).filter((q) => Number(q?.quantity) > 0);
      if (!inputs.length) throw new AppError("Give a quantity to issue", 400);
      if (new Set(inputs.map((q) => String(q.productDefinitionId))).size !== inputs.length) throw new AppError("Invalid: a product is listed twice", 400);
      total = round3(inputs.reduce((s, q) => s + Number(q.quantity), 0));
      if (total > remaining) throw new AppError(`Only ${remaining} left to issue on this request`, 400);
      for (const q of inputs) {
        const product = productById.get(String(q.productDefinitionId));
        if (!product) throw new AppError("Invalid: that product is not in this request's category", 400);
        const out = await StockItemRequestService._issueBatch(request, product, round3(Number(q.quantity)), ctx, session);
        movements = movements.concat(out.movements);
        issueLines.push(out.issueLine);
      }
    }

    await StockItemMovementService.record(movements, session);

    const by = personOf(user);
    request.issues.push({ at: now, by, lines: issueLines });
    request.issuedQty = round3(request.issuedQty + total);
    const done = request.issuedQty >= request.requestedQty;
    request.status = done ? ITEM_REQUEST_STATUS.COMPLETED : ITEM_REQUEST_STATUS.PARTIAL;
    request.history.push({
      action: "ISSUED",
      at: now,
      byName: by.name,
      note: issueLines.map((l) => `${l.productName} ×${l.quantity}`).join(", "),
    });
    if (done) request.history.push({ action: "COMPLETED", at: now, byName: by.name });
    await request.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: request._id, action: "ISSUE", actor: user, before, after: request.toObject(),
    });
    // Not getById: that reads outside this transaction and would show the
    // request as it was before the issue. The screen reloads after commit.
    return request.toObject();
  }

  // Close a partly issued request for good — nothing more will be given on it.
  static async shortClose(id, reason, user, session, dataAccess) {
    const request = await StockItemRequestService._load(id, session, dataAccess);
    if (request.status !== ITEM_REQUEST_STATUS.PARTIAL)
      throw new AppError("Only a partly issued request can be short-closed — reject it if nothing was issued", 400);
    const why = text(reason, 500);
    if (!why) throw new AppError("A reason is required to short-close", 400);
    const before = request.toObject();

    const by = personOf(user);
    request.status = ITEM_REQUEST_STATUS.PARTIALLY_CLOSED;
    request.closure = { reason: why, by, at: new Date() };
    request.history.push({ action: "SHORT_CLOSED", byName: by.name, note: why });
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
      throw new AppError("Only a pending request can be rejected — short-close it if some items were issued", 400);
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
