import mongoose from "mongoose";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import StockInventoryItemMovementModel from "../models/stock.inventory.item.movement.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockCategoryModel from "../models/stock.category.model.js";
import StockBranchModel from "../models/stock.branch.model.js";
import StockLowStockStateModel from "../models/stock.low.stock.state.model.js";
import StockInvoiceAdjustmentModel from "../models/stock.invoice.adjustment.model.js";
import StockCategoryService from "./stock.category.service.js";
import { resolveDimensionAllowList } from "../helpers/data.scope.helper.js";
import {
  ITEM_STATUS, ITEM_APPROVAL_STATUS, ITEM_MOVEMENT_TYPE, ITEM_MOVEMENT_REF, STOCK_LEVEL, ASSIGNEE_KIND, ADJUSTMENT_TYPE,
} from "../constants/stock.enums.js";

/*
  Product Inventory — one row per product with its stock against the alert
  threshold, branch by branch. Took over the separate Low Stock page
  (2026-11-04): the same numbers, so one screen answers "what do we have" and
  "what is running low".

    available   approved, active units with status AVAILABLE — a unit counts 1,
                a batch its quantity (same rule as StockLowStockService).
    threshold   Product Definition → branchThresholds, falling back to
                defaultStockAlertThreshold; 0 / none = no alert for that branch.
    level       OUT (0 available), LOW (≤ threshold), OK, or NONE (no alert set).

  Branch picked → the row is that branch. All branches → available is the sum,
  the level is the WORST branch's (a total would hide a branch that ran out),
  and the per-branch numbers ride along for the row's breakdown.
*/

const toId = (id) => new mongoose.Types.ObjectId(String(id));
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const PRODUCT_LEVEL = { ...STOCK_LEVEL, NONE: "NONE" };
// Worst first: what needs attention leads the list.
const RANK = { OUT: 0, LOW: 1, OK: 2, NONE: 3 };

const levelOf = (available, threshold) => {
  if (!(threshold > 0)) return PRODUCT_LEVEL.NONE;
  if (available <= 0) return PRODUCT_LEVEL.OUT;
  return available <= threshold ? PRODUCT_LEVEL.LOW : PRODUCT_LEVEL.OK;
};

/** The branches this caller may see, narrowed to `branchId` when one is asked for. */
const visibleBranches = async (dataAccess, branchId) => {
  const allow = resolveDimensionAllowList(dataAccess, "branch"); // null = every branch
  const filter = { isActive: true };
  if (allow !== null) filter._id = { $in: allow.map(toId) };
  let branches = await StockBranchModel.find(filter).select("name code").sort({ name: 1 }).lean();
  if (branchId) branches = branches.filter((b) => String(b._id) === String(branchId));
  return branches;
};

export default class StockProductStockService {
  static async list(query = {}, dataAccess) {
    const { search, categoryId, productDefinitionId, branchId, level } = query;
    const branches = await visibleBranches(dataAccess, branchId);
    const empty = { rows: [], counts: { ALL: 0, OK: 0, LOW: 0, OUT: 0, NONE: 0 }, totals: { available: [] }, total: 0 };
    if (!branches.length) return empty;
    const branchIds = branches.map((b) => b._id);

    const productFilter = { isActive: true };
    if (categoryId && mongoose.isValidObjectId(categoryId)) productFilter.categoryId = toId(categoryId);
    if (productDefinitionId && mongoose.isValidObjectId(productDefinitionId)) productFilter._id = toId(productDefinitionId);
    if (search && String(search).trim()) productFilter.name = { $regex: escapeRegex(String(search).trim()), $options: "i" };

    const [products, stock] = await Promise.all([
      StockProductDefinitionModel.find(productFilter)
        .select("name unit trackingMethod categoryId defaultStockAlertThreshold branchThresholds")
        .lean(),
      StockInventoryItemModel.aggregate([
        {
          $match: {
            isActive: true,
            approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
            status: ITEM_STATUS.AVAILABLE,
            branchId: { $in: branchIds },
          },
        },
        { $group: { _id: { product: "$productDefinitionId", branch: "$branchId" }, available: { $sum: { $ifNull: ["$quantity", 1] } } } },
      ]),
    ]);
    if (!products.length) return empty;
    const availableBy = new Map(stock.map((s) => [`${s._id.product}:${s._id.branch}`, s.available]));

    let rows = products.map((p) => {
      const thresholdBy = new Map((p.branchThresholds || []).map((t) => [String(t.branchId), t.threshold]));
      const perBranch = branches.map((b) => {
        const threshold = Number(thresholdBy.get(String(b._id)) ?? p.defaultStockAlertThreshold ?? 0) || 0;
        const available = round3(availableBy.get(`${p._id}:${b._id}`) || 0);
        const lvl = levelOf(available, threshold);
        return {
          branchId: b._id,
          branchName: b.name,
          available,
          threshold,
          shortBy: threshold > 0 ? round3(Math.max(0, threshold - available)) : 0,
          level: lvl,
        };
      });
      const worst = perBranch.reduce((w, b) => (RANK[b.level] < RANK[w] ? b.level : w), PRODUCT_LEVEL.NONE);
      return {
        productDefinitionId: p._id,
        productName: p.name,
        unit: p.unit,
        trackingMethod: p.trackingMethod,
        categoryId: p.categoryId || null,
        available: round3(perBranch.reduce((s, b) => s + b.available, 0)),
        level: worst,
        branches: perBranch,
        lowBranches: perBranch.filter((b) => b.level === PRODUCT_LEVEL.LOW || b.level === PRODUCT_LEVEL.OUT).length,
        alertBranches: perBranch.filter((b) => b.level !== PRODUCT_LEVEL.NONE).length,
      };
    });

    // Tab counts reflect every filter except the level itself.
    const counts = { ALL: rows.length, OK: 0, LOW: 0, OUT: 0, NONE: 0 };
    rows.forEach((r) => { counts[r.level] += 1; });
    // Header cards: available summed per unit (pieces and metres never added),
    // over every filter except the level — the same rows as the tab counts.
    const byUnit = new Map();
    rows.forEach((r) => { const u = r.unit || "pieces"; byUnit.set(u, round3((byUnit.get(u) || 0) + r.available)); });
    const totals = { available: [...byUnit.entries()].map(([unit, quantity]) => ({ unit, quantity })) };
    if (level && counts[level] !== undefined) rows = rows.filter((r) => r.level === level);

    rows.sort((a, b) => RANK[a.level] - RANK[b.level] || a.productName.localeCompare(b.productName));

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 10));
    const pageRows = rows.slice((page - 1) * limit, page * limit);

    // Category breadcrumbs and "low since" — only for the page being shown.
    const catIds = [...new Set(pageRows.map((r) => String(r.categoryId)).filter((x) => x && x !== "null"))];
    const [categories, states] = await Promise.all([
      StockCategoryModel.find({ _id: { $in: catIds } }).select("path name").lean(),
      pageRows.length
        ? StockLowStockStateModel.find({
            productDefinitionId: { $in: pageRows.map((r) => r.productDefinitionId) },
            branchId: { $in: branchIds },
          }).select("productDefinitionId branchId since").lean()
        : [],
    ]);
    const pathBy = new Map();
    for (const c of categories) pathBy.set(String(c._id), (await StockCategoryService.buildDisplayPath(c.path || "")) || c.name);
    const sinceBy = new Map(states.map((s) => [`${s.productDefinitionId}:${s.branchId}`, s.since]));

    return {
      rows: pageRows.map((r) => ({
        ...r,
        categoryPath: pathBy.get(String(r.categoryId)) || "",
        branches: r.branches.map((b) => ({
          ...b,
          since: b.level === PRODUCT_LEVEL.LOW || b.level === PRODUCT_LEVEL.OUT ? sinceBy.get(`${r.productDefinitionId}:${b.branchId}`) || null : null,
        })),
      })),
      counts,
      totals,
      total: rows.length,
      page,
      limit,
    };
  }

  /*
    One product's stock story: the Product Inventory Report's numbers for it
    (Total Received = Available + Issued / Used), then receipt by receipt how
    much came in and where it is now. "Received" never shrinks — issuing or
    transferring units moves them between the buckets instead.

    Per receipt, whatever was received but is not held here any more is
    "Sent to Branches" when one branch is picked (stock leaves a branch by
    transfer) and "Not recorded" across all branches.
  */
  static async history(productDefinitionId, { branchId } = {}, dataAccess) {
    if (!mongoose.isValidObjectId(productDefinitionId)) throw new Error("Product not found");
    const branches = await visibleBranches(dataAccess, branchId);
    const report = await StockProductStockService.summary({ productDefinitionId, branchId }, dataAccess);
    const summary = report.rows[0] || { ...report.totals };
    if (!branches.length) return { summary, receipts: [] };
    const branchIds = branches.map((b) => b._id);
    const pid = toId(productDefinitionId);

    const [received, items, draws] = await Promise.all([
      StockInventoryItemMovementModel.aggregate([
        { $match: { productDefinitionId: pid, type: ITEM_MOVEMENT_TYPE.RECEIVED, toBranchId: { $in: branchIds } } },
        // A swap (old unit REPLACED) is not a receipt — see summary().
        { $lookup: { from: "inventory_items", localField: "relatedItemId", foreignField: "_id", as: "rel" } },
        {
          $match: {
            $expr: {
              $not: {
                $and: [
                  { $eq: ["$ref.type", ITEM_MOVEMENT_REF.REPAIR] },
                  { $eq: [{ $arrayElemAt: ["$rel.status", 0] }, ITEM_STATUS.REPLACED] },
                ],
              },
            },
          },
        },
        {
          $group: {
            _id: "$ref.refId",
            refType: { $first: "$ref.type" },
            refNumber: { $first: "$ref.refNumber" },
            at: { $min: "$at" },
            qty: { $sum: { $ifNull: ["$quantity", 1] } },
          },
        },
      ]),
      StockInventoryItemModel.aggregate([
        {
          $match: {
            productDefinitionId: pid, isActive: true, approvalStatus: ITEM_APPROVAL_STATUS.APPROVED, branchId: { $in: branchIds },
            // The vendor kept these; the unit sent in place of each stands in for it.
            status: { $ne: ITEM_STATUS.REPLACED },
          },
        },
        // A swap unit belongs to the receipt of the unit it replaced.
        { $lookup: { from: "inventory_items", localField: "replacesItemId", foreignField: "_id", as: "old" } },
        { $addFields: { old: { $arrayElemAt: ["$old", 0] } } },
        { $addFields: { swapped: { $eq: ["$old.status", ITEM_STATUS.REPLACED] } } },
        {
          $group: {
            _id: { ref: { $cond: ["$swapped", "$old.source.refId", "$source.refId"] }, status: "$status", kind: "$assignedTo.kind" },
            sourceType: { $first: { $cond: ["$swapped", "$old.source.type", "$source.type"] } },
            refNumber: { $first: { $cond: ["$swapped", "$old.source.refNumber", "$source.refNumber"] } },
            receivedAt: { $min: "$receivedAt" },
            qty: { $sum: { $ifNull: ["$quantity", 1] } },
          },
        },
      ]),
      // What debit notes took off batches, per receipt.
      StockInvoiceAdjustmentModel.aggregate([
        { $match: { type: ADJUSTMENT_TYPE.DEBIT_NOTE, "lines.productDefinitionId": pid } },
        { $unwind: "$lines" },
        { $match: { "lines.productDefinitionId": pid } },
        { $unwind: "$lines.batchDraws" },
        { $lookup: { from: "inventory_items", localField: "lines.batchDraws.inventoryItemId", foreignField: "_id", as: "batch" } },
        { $unwind: "$batch" },
        { $match: { "batch.branchId": { $in: branchIds } } },
        { $group: { _id: "$batch.source.refId", qty: { $sum: "$lines.batchDraws.quantity" } } },
      ]),
    ]);

    const blank = () => ({ subscribers: 0, employees: 0, faulty: 0, inRepair: 0, scrapped: 0, returned: 0, sent: 0, inTransit: 0, lost: 0, unrecorded: 0 });
    const receipts = new Map();
    const receipt = (key, seed) => {
      if (!receipts.has(key)) receipts.set(key, { refId: key === "none" ? null : key, received: 0, available: 0, now: blank(), held: 0, ...seed });
      return receipts.get(key);
    };

    received.forEach((r) => {
      receipt(String(r._id || "none"), { sourceType: r.refType, refNumber: r.refNumber, receivedAt: r.at }).received += r.qty;
    });

    items.forEach((g) => {
      const rec = receipt(String(g._id.ref || "none"), { sourceType: g.sourceType, refNumber: g.refNumber, receivedAt: g.receivedAt });
      switch (g._id.status) {
        case ITEM_STATUS.AVAILABLE: rec.available += g.qty; break;
        case ITEM_STATUS.ASSIGNED:
          if (g._id.kind === ASSIGNEE_KIND.EMPLOYEE) rec.now.employees += g.qty; else rec.now.subscribers += g.qty;
          break;
        case ITEM_STATUS.DEBITED: rec.now.returned += g.qty; break;
        // Sent to a branch, not accepted there yet — still ours here.
        case ITEM_STATUS.IN_TRANSIT: rec.now.inTransit += g.qty; break;
        case ITEM_STATUS.LOST: rec.now.lost += g.qty; break;
        case ITEM_STATUS.IN_REPAIR: rec.now.inRepair += g.qty; break;
        case ITEM_STATUS.SCRAPPED: rec.now.scrapped += g.qty; break;
        default: rec.now.faulty += g.qty; // FAULTY
      }
      rec.held += g.qty;
    });

    draws.forEach((d) => {
      const rec = receipt(String(d._id || "none"), {});
      rec.now.returned += d.qty;
      rec.held += d.qty;
    });

    const list = [...receipts.values()].map((r) => {
      // Older stock has no RECEIVED row: what is held of it is what came in.
      if (!r.received) r.received = r.held;
      const gap = r.received - r.held;
      if (gap > 0) r.now[branchId ? "sent" : "unrecorded"] += gap;
      Object.keys(r.now).forEach((k) => { r.now[k] = round3(r.now[k]); });
      const issued = round3(Object.values(r.now).reduce((x, v) => x + v, 0));
      const { held, ...rest } = r; // eslint-disable-line no-unused-vars
      return { ...rest, received: round3(r.received), available: round3(r.available), issued };
    });
    list.sort((x, y) => new Date(y.receivedAt || 0) - new Date(x.receivedAt || 0));

    return { summary, receipts: list };
  }

  /*
    Stock Summary — for every product, everything received and where it all is
    now, so that Total Received = In Store + Out of Store, always.

      received      Purchase (invoice) + Opening Stock + From Branches +
                    From Vendor (free — a replacement whose old unit came back too)
      in store      AVAILABLE units
      out of store  Debited (debit notes) + Sent to Branches + In Use
                    (subscribers / employees) + Faulty + In Repair + Dead /
                    Scrapped + Lost   (repair = faulty + in repair)
    A REPLACED unit (the vendor kept it) is counted nowhere and its
    replacement takes its place — a swap shows as one unit, never two.

    Transfers are counted only when they cross the edge of the branches being
    looked at: Delhi → Noida is "sent" for Delhi and "from branches" for Noida,
    but for both together it is stock moving inside the company and appears
    nowhere — otherwise the company total would count it twice.

    Older stock posted before the movement log existed has no RECEIVED row;
    those units are counted as received from their own source (invoice or
    opening stock). Anything still unexplained shows as "Other" received, and
    stock received but no longer held anywhere we can see (e.g. a batch used
    without a record) as "Not recorded" out of store. Either keeps the two
    sides equal and makes the gap visible.

    The date range keeps what was received in it: receipts and transfers by
    their date, held units by their receivedAt.
  */
  static async summary(query = {}, dataAccess) {
    const { search, categoryId, productDefinitionId, branchId, from, to } = query;
    const branches = await visibleBranches(dataAccess, branchId);
    const blankTotals = () => ({
      received: 0, purchase: 0, opening: 0, fromBranches: 0, vendorFree: 0, other: 0,
      inStore: 0, outOfStore: 0,
      returned: 0, sent: 0, inTransit: 0, subscribers: 0, employees: 0,
      faulty: 0, inRepair: 0, repair: 0, scrapped: 0, lost: 0, unrecorded: 0,
      // Shown for information only — never part of Not Available or the total.
      replaced: 0,
    });
    const empty = { rows: [], totals: blankTotals(), total: 0 };
    if (!branches.length) return empty;
    const branchIds = branches.map((b) => b._id);
    const inScope = new Set(branchIds.map(String));

    const productFilter = { isActive: true };
    if (categoryId && mongoose.isValidObjectId(categoryId)) productFilter.categoryId = toId(categoryId);
    if (productDefinitionId && mongoose.isValidObjectId(productDefinitionId)) productFilter._id = toId(productDefinitionId);
    if (search && String(search).trim()) productFilter.name = { $regex: escapeRegex(String(search).trim()), $options: "i" };
    const products = await StockProductDefinitionModel.find(productFilter).select("name unit trackingMethod categoryId").lean();
    if (!products.length) return empty;
    const pids = products.map((p) => p._id);

    const range = {};
    if (from) range.$gte = new Date(from);
    if (to) { const d = new Date(to); d.setHours(23, 59, 59, 999); range.$lte = d; }
    const dated = Object.keys(range).length > 0;

    const [moves, held, draws, legacy] = await Promise.all([
      StockInventoryItemMovementModel.aggregate([
        {
          $match: {
            productDefinitionId: { $in: pids },
            type: { $in: [ITEM_MOVEMENT_TYPE.RECEIVED, ITEM_MOVEMENT_TYPE.TRANSFERRED] },
            $or: [{ toBranchId: { $in: branchIds } }, { fromBranchId: { $in: branchIds } }],
            ...(dated ? { at: range } : {}),
          },
        },
        // A vendor replacement's RECEIVED row points at the unit it replaced.
        // While that unit is REPLACED (the vendor kept it) the new one only
        // takes its place — a swap, not stock received.
        { $lookup: { from: "inventory_items", localField: "relatedItemId", foreignField: "_id", as: "rel" } },
        {
          $addFields: {
            swap: {
              $and: [
                { $eq: ["$type", ITEM_MOVEMENT_TYPE.RECEIVED] },
                { $eq: ["$ref.type", ITEM_MOVEMENT_REF.REPAIR] },
                { $eq: [{ $arrayElemAt: ["$rel.status", 0] }, ITEM_STATUS.REPLACED] },
              ],
            },
          },
        },
        {
          $group: {
            _id: {
              product: "$productDefinitionId", type: "$type", refType: "$ref.type",
              from: "$fromBranchId", to: "$toBranchId", swap: "$swap",
              // A batch transfer writes two rows (source and new batch) for one move.
              pair: { $and: [{ $eq: ["$type", ITEM_MOVEMENT_TYPE.TRANSFERRED] }, { $ne: [{ $ifNull: ["$relatedItemId", null] }, null] }] },
            },
            qty: { $sum: { $ifNull: ["$quantity", 1] } },
          },
        },
      ]),
      StockInventoryItemModel.aggregate([
        {
          $match: {
            productDefinitionId: { $in: pids },
            isActive: true,
            approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
            branchId: { $in: branchIds },
            ...(dated ? { receivedAt: range } : {}),
          },
        },
        {
          $group: {
            _id: { product: "$productDefinitionId", status: "$status", kind: "$assignedTo.kind" },
            qty: { $sum: { $ifNull: ["$quantity", 1] } },
          },
        },
      ]),
      // Debit notes on batches take quantity off the batch itself, so what they
      // took lives on the note (the draws are cleared when a note is undone).
      StockInvoiceAdjustmentModel.aggregate([
        { $match: { type: ADJUSTMENT_TYPE.DEBIT_NOTE, "lines.productDefinitionId": { $in: pids } } },
        { $unwind: "$lines" },
        { $match: { "lines.productDefinitionId": { $in: pids } } },
        { $unwind: "$lines.batchDraws" },
        { $lookup: { from: "inventory_items", localField: "lines.batchDraws.inventoryItemId", foreignField: "_id", as: "batch" } },
        { $unwind: "$batch" },
        { $match: { "batch.branchId": { $in: branchIds }, ...(dated ? { "batch.receivedAt": range } : {}) } },
        {
          $group: {
            // A pre-log batch (no source) counts only what is left on it as received,
            // so what a note took off it was received too.
            _id: { product: "$lines.productDefinitionId", legacy: { $eq: [{ $ifNull: ["$batch.source.type", null] }, null] } },
            qty: { $sum: "$lines.batchDraws.quantity" },
          },
        },
      ]),
      // Stock from before the log: no RECEIVED row and no source. (A batch split
      // off newer stock copies its parent's source, so it never lands here.)
      // Counted at the branch it was FIRST at — the sender of its earliest
      // transfer, else where it sits. Counting it where it sits now would
      // count it twice at a branch it was transferred to: once here, once as
      // "from branches".
      StockInventoryItemModel.aggregate([
        {
          $match: {
            productDefinitionId: { $in: pids },
            isActive: true,
            approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
            "source.type": null,
            ...(dated ? { receivedAt: range } : {}),
          },
        },
        { $lookup: { from: "inventory_item_movements", localField: "_id", foreignField: "inventoryItemId", as: "m" } },
        { $match: { "m.type": { $ne: ITEM_MOVEMENT_TYPE.RECEIVED } } },
        {
          $addFields: {
            firstMove: {
              $first: {
                $sortArray: {
                  input: { $filter: { input: "$m", cond: { $eq: ["$$this.type", ITEM_MOVEMENT_TYPE.TRANSFERRED] } } },
                  sortBy: { at: 1 },
                },
              },
            },
          },
        },
        { $match: { $expr: { $in: [{ $ifNull: ["$firstMove.fromBranchId", "$branchId"] }, branchIds] } } },
        // The oldest units carry no source at all, only the invoice they came on.
        { $group: { _id: { product: "$productDefinitionId", source: { $ifNull: ["$source.type", { $cond: [{ $gt: ["$invoiceId", null] }, "PURCHASE", null] }] } }, qty: { $sum: { $ifNull: ["$quantity", 1] } } } },
      ]),
    ]);

    const byProduct = new Map(pids.map((id) => [String(id), blankTotals()]));
    const at = (id) => byProduct.get(String(id));

    moves.forEach((m) => {
      const t = at(m._id.product);
      if (!t) return;
      const qtyMoved = m._id.pair ? m.qty / 2 : m.qty;
      const toIn = !!m._id.to && inScope.has(String(m._id.to));
      const fromIn = !!m._id.from && inScope.has(String(m._id.from));
      if (m._id.type === ITEM_MOVEMENT_TYPE.RECEIVED) {
        if (!toIn || m._id.swap) return;
        if (m._id.refType === ITEM_MOVEMENT_REF.INVOICE) t.purchase += qtyMoved;
        else if (m._id.refType === ITEM_MOVEMENT_REF.OPENING_STOCK) t.opening += qtyMoved;
        // A replacement whose old unit came back too: an extra unit, free.
        else if (m._id.refType === ITEM_MOVEMENT_REF.REPAIR) t.vendorFree += qtyMoved;
        else t.other += qtyMoved;
      } else if (toIn && !fromIn) t.fromBranches += qtyMoved;
      else if (fromIn && !toIn) t.sent += qtyMoved;
    });

    held.forEach((h) => {
      const t = at(h._id.product);
      if (!t) return;
      switch (h._id.status) {
        case ITEM_STATUS.AVAILABLE: t.inStore += h.qty; break;
        case ITEM_STATUS.ASSIGNED:
          if (h._id.kind === ASSIGNEE_KIND.EMPLOYEE) t.employees += h.qty; else t.subscribers += h.qty;
          break;
        // On the way to another branch (or rejected and back with the
        // sender to fix) — held with the sender until it is accepted.
        case ITEM_STATUS.IN_TRANSIT: t.inTransit += h.qty; break;
        case ITEM_STATUS.DEBITED: t.returned += h.qty; break;
        case ITEM_STATUS.LOST: t.lost += h.qty; break;
        case ITEM_STATUS.IN_REPAIR: t.inRepair += h.qty; break;
        case ITEM_STATUS.SCRAPPED: t.scrapped += h.qty; break;
        // The vendor kept it; the unit sent in its place is counted instead.
        case ITEM_STATUS.REPLACED: t.replaced += h.qty; break;
        default: t.faulty += h.qty; // FAULTY
      }
    });
    draws.forEach((d) => {
      const t = at(d._id.product);
      if (!t) return;
      t.returned += d.qty;
      if (d._id.legacy) t.purchase += d.qty;
    });
    legacy.forEach((l) => {
      const t = at(l._id.product);
      if (!t) return;
      if (l._id.source === "PURCHASE") t.purchase += l.qty;
      else if (l._id.source === "OPENING_STOCK") t.opening += l.qty;
      else t.other += l.qty;
    });

    const totals = blankTotals();
    let rows = products.map((p) => {
      const t = at(p._id);
      t.repair = t.faulty + t.inRepair;
      t.outOfStore = t.returned + t.sent + t.inTransit + t.subscribers + t.employees + t.repair + t.scrapped + t.lost;
      const recorded = t.purchase + t.opening + t.fromBranches + t.vendorFree + t.other;
      const accounted = t.inStore + t.outOfStore;
      if (accounted > recorded) t.other += accounted - recorded;
      else if (recorded > accounted) { t.unrecorded = recorded - accounted; t.outOfStore += t.unrecorded; }
      t.received = t.purchase + t.opening + t.fromBranches + t.vendorFree + t.other;
      Object.keys(t).forEach((k) => { t[k] = round3(t[k]); totals[k] += t[k]; });
      return {
        productDefinitionId: p._id,
        productName: p.name,
        unit: p.unit,
        trackingMethod: p.trackingMethod,
        categoryId: p.categoryId || null,
        ...t,
      };
    });
    Object.keys(totals).forEach((k) => { totals[k] = round3(totals[k]); });

    // A product nothing was ever received for has nothing to say here.
    rows = rows.filter((r) => r.received > 0);
    rows.sort((a, b) => a.productName.localeCompare(b.productName));

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 10));
    const pageRows = rows.slice((page - 1) * limit, page * limit);

    const catIds = [...new Set(pageRows.map((r) => String(r.categoryId)).filter((x) => x && x !== "null"))];
    const categories = await StockCategoryModel.find({ _id: { $in: catIds } }).select("path name").lean();
    const pathBy = new Map();
    for (const c of categories) pathBy.set(String(c._id), (await StockCategoryService.buildDisplayPath(c.path || "")) || c.name);

    return {
      rows: pageRows.map((r) => ({ ...r, categoryPath: pathBy.get(String(r.categoryId)) || "" })),
      totals,
      total: rows.length,
      page,
      limit,
    };
  }
}
