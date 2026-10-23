import mongoose from "mongoose";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockBranchModel from "../models/stock.branch.model.js";
import { applyDataScope } from "../helpers/data.scope.helper.js";
import { ITEM_STATUS, ITEM_STATUS_ARRAY, ITEM_APPROVAL_STATUS, ASSIGNEE_KIND, TRACKING_METHODS } from "../constants/stock.enums.js";

/*
  Stock Reports — read-only views over inventory items (not the invoice
  reports in stock.report.service.js, which are about money owed to vendors).

    position   how much of everything sits in each state, per branch
    value      what the stock we still own is worth, per branch and origin
    warranty   units whose warranty is ending, ended, or unknown
    subscribers what is out with customers, by service type and product
    repairs    broken units by how long they have been waiting

  All branch-scoped the same way as the stock screens.
*/

const MODULE_KEY = "stock-reports";
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const DAY = 24 * 60 * 60 * 1000;

// Still ours, wherever it is right now. DEBITED went back to the vendor for a
// refund; SCRAPPED was written off; VENDOR_REPLACED is the vendor's now.
export const OWNED_STATUSES = [
  ITEM_STATUS.AVAILABLE,
  ITEM_STATUS.RESERVED,
  ITEM_STATUS.ASSIGNED,
  ITEM_STATUS.IN_TRANSIT,
  ITEM_STATUS.FAULTY,
  ITEM_STATUS.IN_REPAIR,
  ITEM_STATUS.AT_VENDOR,
];

// The filter every report starts from, WITHOUT the branch scope — each report
// applies it itself. Aggregation $match never auto-casts, so ids are ObjectIds
// (applyDataScope casts its own).
const baseMatch = (query, extra = {}) => {
  const match = { isActive: true, approvalStatus: ITEM_APPROVAL_STATUS.APPROVED, ...extra };
  if (query.branchId && mongoose.isValidObjectId(query.branchId)) match.branchId = new mongoose.Types.ObjectId(query.branchId);
  return match;
};

const productFilter = async (query) => {
  if (query.productDefinitionId && mongoose.isValidObjectId(query.productDefinitionId))
    return { productDefinitionId: new mongoose.Types.ObjectId(query.productDefinitionId) };
  if (query.categoryId && mongoose.isValidObjectId(query.categoryId)) {
    const ids = await StockProductDefinitionModel.find({ categoryId: query.categoryId }).distinct("_id");
    return { productDefinitionId: { $in: ids } };
  }
  return {};
};

const nameMaps = async (branchIds, productIds) => {
  const [branches, products] = await Promise.all([
    StockBranchModel.find({ _id: { $in: branchIds.filter(Boolean) } }).select("name").lean(),
    StockProductDefinitionModel.find({ _id: { $in: productIds.filter(Boolean) } }).select("name unit trackingMethod").lean(),
  ]);
  return {
    branch: new Map(branches.map((b) => [String(b._id), b.name])),
    product: new Map(products.map((p) => [String(p._id), p])),
  };
};

export default class StockInventoryReportService {
  /* Branch × status: units (individual) and quantity (batches). */
  static async position(query, dataAccess) {
    const match = applyDataScope(baseMatch(query, await productFilter(query)), dataAccess, MODULE_KEY);
    const rows = await StockInventoryItemModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: { branch: "$branchId", status: "$status" },
          units: { $sum: { $cond: [{ $eq: ["$quantity", null] }, 1, 0] } },
          qty: { $sum: { $ifNull: ["$quantity", 0] } },
        },
      },
    ]);
    const { branch } = await nameMaps([...new Set(rows.map((r) => String(r._id.branch)))], []);
    const byBranch = new Map();
    for (const r of rows) {
      const key = String(r._id.branch);
      if (!byBranch.has(key)) byBranch.set(key, { branchId: r._id.branch, branchName: branch.get(key) || "—", statuses: {}, units: 0, qty: 0 });
      const b = byBranch.get(key);
      b.statuses[r._id.status] = { units: r.units, qty: round3(r.qty) };
      b.units += r.units;
      b.qty = round3(b.qty + r.qty);
    }
    return { statuses: ITEM_STATUS_ARRAY, rows: [...byBranch.values()].sort((a, b) => a.branchName.localeCompare(b.branchName)) };
  }

  /*
    Value of stock we still own: Σ cost × quantity (a unit counts 1). Cost is
    optional on old stock, so the units with no cost are counted separately —
    the total is a floor, and the report says by how much it is incomplete.
  */
  static async value(query, dataAccess) {
    const match = applyDataScope(baseMatch(query, { status: { $in: OWNED_STATUSES }, ...(await productFilter(query)) }), dataAccess, MODULE_KEY);
    const rows = await StockInventoryItemModel.aggregate([
      { $match: match },
      { $addFields: { n: { $ifNull: ["$quantity", 1] }, known: { $ne: [{ $ifNull: ["$purchaseCost", null] }, null] } } },
      {
        $group: {
          _id: { branch: "$branchId", source: { $ifNull: ["$source.type", "UNKNOWN"] } },
          value: { $sum: { $cond: ["$known", { $multiply: ["$purchaseCost", "$n"] }, 0] } },
          pricedUnits: { $sum: { $cond: ["$known", 1, 0] } },
          unpricedUnits: { $sum: { $cond: ["$known", 0, 1] } },
        },
      },
    ]);
    const { branch } = await nameMaps([...new Set(rows.map((r) => String(r._id.branch)))], []);
    const byBranch = new Map();
    for (const r of rows) {
      const key = String(r._id.branch);
      if (!byBranch.has(key)) byBranch.set(key, { branchId: r._id.branch, branchName: branch.get(key) || "—", bySource: {}, value: 0, pricedUnits: 0, unpricedUnits: 0 });
      const b = byBranch.get(key);
      b.bySource[r._id.source] = round2(r.value);
      b.value = round2(b.value + r.value);
      b.pricedUnits += r.pricedUnits;
      b.unpricedUnits += r.unpricedUnits;
    }
    const list = [...byBranch.values()].sort((a, b) => b.value - a.value);
    return {
      rows: list,
      total: round2(list.reduce((s, b) => s + b.value, 0)),
      unpricedUnits: list.reduce((s, b) => s + b.unpricedUnits, 0),
    };
  }

  /*
    Individual units we own, by where their warranty stands. `days` is the
    "ending soon" window (default 60).
  */
  static async warranty(query, dataAccess) {
    const days = Math.min(365, Math.max(1, Number(query.days) || 60));
    const now = new Date();
    const soon = new Date(now.getTime() + days * DAY);
    const bucket = ["ENDING", "EXPIRED", "UNKNOWN", "ACTIVE"].includes(query.bucket) ? query.bucket : "ENDING";
    const match = applyDataScope(baseMatch(query, { status: { $in: OWNED_STATUSES }, quantity: null, ...(await productFilter(query)) }), dataAccess, MODULE_KEY);

    const [counts] = await StockInventoryItemModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          ENDING: { $sum: { $cond: [{ $and: [{ $gte: ["$warranty.endDate", now] }, { $lte: ["$warranty.endDate", soon] }] }, 1, 0] } },
          EXPIRED: { $sum: { $cond: [{ $and: [{ $ne: [{ $ifNull: ["$warranty.endDate", null] }, null] }, { $lt: ["$warranty.endDate", now] }] }, 1, 0] } },
          UNKNOWN: { $sum: { $cond: [{ $eq: [{ $ifNull: ["$warranty.endDate", null] }, null] }, 1, 0] } },
          ACTIVE: { $sum: { $cond: [{ $gt: ["$warranty.endDate", soon] }, 1, 0] } },
        },
      },
    ]);

    const listMatch = { ...match };
    if (bucket === "ENDING") listMatch["warranty.endDate"] = { $gte: now, $lte: soon };
    else if (bucket === "EXPIRED") listMatch["warranty.endDate"] = { $lt: now };
    else if (bucket === "UNKNOWN") listMatch["warranty.endDate"] = null;
    else listMatch["warranty.endDate"] = { $gt: soon };

    const items = await StockInventoryItemModel.find(listMatch)
      .select("productDefinitionId branchId status identifiers fieldValues warranty vendorId source assignedTo")
      .populate({ path: "productDefinitionId", select: "name" })
      .populate({ path: "branchId", select: "name" })
      .populate({ path: "vendorId", select: "name" })
      .sort({ "warranty.endDate": 1 })
      .limit(500)
      .lean();
    return {
      days,
      bucket,
      counts: { ENDING: counts?.ENDING || 0, EXPIRED: counts?.EXPIRED || 0, UNKNOWN: counts?.UNKNOWN || 0, ACTIVE: counts?.ACTIVE || 0 },
      items: items.map((it) => ({
        _id: it._id,
        label: (it.identifiers || []).map((k) => k.slice(k.indexOf(":") + 1)).join(" / ") || Object.values(it.fieldValues || {}).filter(Boolean).join(" / "),
        product: it.productDefinitionId?.name || "",
        branch: it.branchId?.name || "",
        vendor: it.vendorId?.name || "",
        status: it.status,
        source: it.source,
        endDate: it.warranty?.endDate || null,
        daysLeft: it.warranty?.endDate ? Math.ceil((new Date(it.warranty.endDate) - now) / DAY) : null,
        with: it.assignedTo?.kind === ASSIGNEE_KIND.EMPLOYEE ? it.assignedTo.employeeName : it.assignedTo?.orderId || "",
      })),
    };
  }

  /* What is out with customers: service type × product. */
  static async subscribers(query, dataAccess) {
    const match = applyDataScope(baseMatch(query, {
      status: ITEM_STATUS.ASSIGNED,
      "assignedTo.subscriberId": { $ne: null },
      ...(await productFilter(query)),
    }), dataAccess, MODULE_KEY);
    const rows = await StockInventoryItemModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: { serviceType: { $ifNull: ["$assignedTo.serviceType", ""] }, product: "$productDefinitionId" },
          units: { $sum: { $cond: [{ $eq: ["$quantity", null] }, 1, 0] } },
          qty: { $sum: { $ifNull: ["$quantity", 0] } },
          subscribers: { $addToSet: "$assignedTo.subscriberId" },
        },
      },
    ]);
    const { product } = await nameMaps([], [...new Set(rows.map((r) => String(r._id.product)))]);
    return rows
      .map((r) => {
        const p = product.get(String(r._id.product));
        return {
          serviceType: r._id.serviceType || "—",
          product: p?.name || "—",
          unit: p?.unit || null,
          trackingMethod: p?.trackingMethod || TRACKING_METHODS.INDIVIDUAL,
          units: r.units,
          qty: round3(r.qty),
          subscribers: r.subscribers.length,
        };
      })
      .sort((a, b) => a.serviceType.localeCompare(b.serviceType) || a.product.localeCompare(b.product));
  }

  /* Broken units by how long they have been waiting in their current step. */
  static async repairs(query, dataAccess) {
    const match = applyDataScope(baseMatch(query, { status: { $in: [ITEM_STATUS.FAULTY, ITEM_STATUS.IN_REPAIR, ITEM_STATUS.AT_VENDOR] } }), dataAccess, MODULE_KEY);
    const items = await StockInventoryItemModel.find(match)
      .select("status fault repair updatedAt identifiers fieldValues productDefinitionId branchId")
      .populate({ path: "productDefinitionId", select: "name" })
      .populate({ path: "branchId", select: "name" })
      .lean();
    const now = Date.now();
    const buckets = ["0-7", "8-30", "31-90", "90+"];
    const grid = Object.fromEntries([ITEM_STATUS.FAULTY, ITEM_STATUS.IN_REPAIR, ITEM_STATUS.AT_VENDOR].map((s) => [s, Object.fromEntries(buckets.map((b) => [b, 0]))]));
    const rows = items.map((it) => {
      const since = it.status === ITEM_STATUS.FAULTY ? it.fault?.reportedAt || it.updatedAt : it.repair?.sentAt || it.updatedAt;
      const days = Math.floor((now - new Date(since).getTime()) / DAY);
      const b = days <= 7 ? "0-7" : days <= 30 ? "8-30" : days <= 90 ? "31-90" : "90+";
      grid[it.status][b] += 1;
      return {
        _id: it._id,
        label: (it.identifiers || []).map((k) => k.slice(k.indexOf(":") + 1)).join(" / ") || Object.values(it.fieldValues || {}).filter(Boolean).join(" / "),
        product: it.productDefinitionId?.name || "",
        branch: it.branchId?.name || "",
        status: it.status,
        days,
        where: it.repair?.vendorName || (it.status === ITEM_STATUS.IN_REPAIR ? "Our bench" : ""),
        note: it.fault?.note || "",
      };
    });
    return { buckets, grid, items: rows.sort((a, b) => b.days - a.days).slice(0, 500) };
  }
}
