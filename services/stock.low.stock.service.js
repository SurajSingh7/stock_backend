import mongoose from "mongoose";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockBranchModel from "../models/stock.branch.model.js";
import StockLowStockStateModel from "../models/stock.low.stock.state.model.js";
import StockLowStockNoticeModel from "../models/stock.low.stock.notice.model.js";
import StockAlertRuleModel from "../models/stock.alert.rule.model.js";
import { emitAlertEvent } from "./stock.alert.dispatcher.service.js";
import { getLogger } from "../helpers/logger.helper.js";
import { ITEM_STATUS, ITEM_APPROVAL_STATUS, STOCK_LEVEL, ALERT_RULE_KIND } from "../constants/stock.enums.js";

/*
  Low stock — each product's AVAILABLE stock in each branch against that
  branch's alert threshold (Product Definition → branchThresholds, falling
  back to defaultStockAlertThreshold for a branch added since).

    available   approved, active units with status AVAILABLE in the branch —
                a unit counts 1, a batch its quantity. Issued, in transit,
                faulty or in repair stock is not on the shelf.
    LOW         0 < available ≤ threshold
    OUT         available = 0
    threshold 0 (or none) switches the alert off for that branch.

  Detected by a periodic check (the alert worker runs checkAll every few
  minutes) rather than hooks in every flow that moves stock: stock leaves a
  branch from a dozen places — issue, employee items, transfers, repairs,
  scrap, debit notes — and a threshold can change under it. One check over
  the whole picture catches all of them, including the ones added later.

  Alerts go out only on a change for the worse (OK → LOW/OUT, LOW → OUT); a
  low product stays quiet until it recovers, then a new dip is news again.
  The morning summary repeats what is still low.
*/
const log = getLogger(import.meta.url);
const LOW_STOCK_EVENT = "LOW_STOCK";
const toId = (id) => new mongoose.Types.ObjectId(String(id));
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const levelOf = (available, threshold) =>
  available <= 0 ? STOCK_LEVEL.OUT : available <= threshold ? STOCK_LEVEL.LOW : STOCK_LEVEL.OK;
const SEVERITY = { [STOCK_LEVEL.OK]: 0, [STOCK_LEVEL.LOW]: 1, [STOCK_LEVEL.OUT]: 2 };

export default class StockLowStockService {
  /**
   * Every product × branch that has a threshold, with its stock and level.
   * @param branchIds  null = every active branch
   */
  static async computeLevels({ branchIds = null } = {}) {
    const branchFilter = { isActive: true };
    if (branchIds) branchFilter._id = { $in: branchIds.map(toId) };
    const branches = await StockBranchModel.find(branchFilter).select("name code").lean();
    if (!branches.length) return [];
    const branchList = branches.map((b) => b._id);

    const [products, stock] = await Promise.all([
      StockProductDefinitionModel.find({ isActive: true })
        .select("name unit categoryId defaultStockAlertThreshold branchThresholds")
        .lean(),
      StockInventoryItemModel.aggregate([
        {
          $match: {
            isActive: true,
            approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
            status: ITEM_STATUS.AVAILABLE,
            branchId: { $in: branchList },
          },
        },
        {
          $group: {
            _id: { product: "$productDefinitionId", branch: "$branchId" },
            available: { $sum: { $ifNull: ["$quantity", 1] } },
          },
        },
      ]),
    ]);
    const availableBy = new Map(stock.map((s) => [`${s._id.product}:${s._id.branch}`, s.available]));

    const rows = [];
    for (const p of products) {
      const thresholdBy = new Map((p.branchThresholds || []).map((t) => [String(t.branchId), t.threshold]));
      for (const b of branches) {
        const threshold = Number(thresholdBy.get(String(b._id)) ?? p.defaultStockAlertThreshold ?? 0);
        if (!(threshold > 0)) continue;
        const available = round3(availableBy.get(`${p._id}:${b._id}`) || 0);
        rows.push({
          productDefinitionId: p._id,
          productName: p.name,
          unit: p.unit,
          categoryId: p.categoryId || null,
          branchId: b._id,
          branchName: b.name,
          branchCode: b.code,
          available,
          threshold,
          level: levelOf(available, threshold),
        });
      }
    }
    return rows;
  }

  /* ---------------------------------------------------------------------- */
  /* The periodic check                                                      */
  /* ---------------------------------------------------------------------- */

  /*
    Safe to run in two processes at once: the state row is unique per pair,
    and telling people is claimed by a conditional update on notifiedLevel —
    whichever process loses gets nothing back and sends nothing.

    With no LOW_STOCK rule on, dips are still recorded (the page's "Low
    since") but nobody is marked as told — switch a rule on and the next
    check reports everything that is already low.
  */
  static async checkAll() {
    const [rows, states, hasRule] = await Promise.all([
      StockLowStockService.computeLevels(),
      StockLowStockStateModel.find({}).lean(),
      StockAlertRuleModel.exists({ isActive: true, enabled: true, kind: ALERT_RULE_KIND.AUTOMATIC, eventKey: LOW_STOCK_EVENT }),
    ]);
    const stateBy = new Map(states.map((s) => [`${s.productDefinitionId}:${s.branchId}`, s]));
    const levelBy = new Map(); // pair → level, for every pair that still has a threshold
    const toNotify = []; // rows that got worse in this check
    const now = new Date();
    const quietUpdates = [];

    for (const row of rows) {
      const key = `${row.productDefinitionId}:${row.branchId}`;
      levelBy.set(key, row.level);
      const state = stateBy.get(key);

      if (row.level === STOCK_LEVEL.OK) continue; // a leftover state is removed below

      const pair = { productDefinitionId: row.productDefinitionId, branchId: row.branchId };
      if (!state) {
        await StockLowStockStateModel.updateOne(
          pair,
          { $setOnInsert: { level: row.level, notifiedLevel: null, available: row.available, threshold: row.threshold, since: now } },
          { upsert: true }
        ).catch((err) => (err.code === 11000 ? null : Promise.reject(err)));
      }
      const told = state?.notifiedLevel ?? null;

      if (hasRule && SEVERITY[row.level] > SEVERITY[told ?? STOCK_LEVEL.OK]) {
        const res = await StockLowStockStateModel.updateOne(
          { ...pair, notifiedLevel: told },
          { $set: { level: row.level, notifiedLevel: row.level, available: row.available, threshold: row.threshold } }
        );
        if (res.modifiedCount) toNotify.push(row);
        continue;
      }

      if (state && (state.level !== row.level || state.available !== row.available || state.threshold !== row.threshold)) {
        // Better than people were told (OUT → LOW): quiet, but a fall back
        // to OUT is news again.
        const nextTold = told && SEVERITY[row.level] < SEVERITY[told] ? row.level : told;
        quietUpdates.push({
          updateOne: {
            filter: { _id: state._id },
            update: { $set: { level: row.level, notifiedLevel: nextTold, available: row.available, threshold: row.threshold } },
          },
        });
      }
    }
    if (quietUpdates.length) await StockLowStockStateModel.bulkWrite(quietUpdates, { ordered: false });

    // Recovered, threshold switched off, product or branch gone.
    const recovered = states.filter((s) => {
      const level = levelBy.get(`${s.productDefinitionId}:${s.branchId}`);
      return !level || level === STOCK_LEVEL.OK;
    });
    if (recovered.length) await StockLowStockStateModel.deleteMany({ _id: { $in: recovered.map((s) => s._id) } });

    const notices = await StockLowStockService._notify(toNotify);
    if (toNotify.length || recovered.length) {
      log.info(`Low stock check: ${toNotify.length} worse, ${recovered.length} recovered, ${notices} notice(s)`);
    }
    return { checked: rows.length, worse: toNotify.length, recovered: recovered.length, notices };
  }

  // One notice per branch, so a transfer that empties five shelves is one message.
  static async _notify(rows) {
    if (!rows.length) return 0;
    const byBranch = new Map();
    for (const r of rows) {
      const k = String(r.branchId);
      if (!byBranch.has(k)) byBranch.set(k, { branchId: r.branchId, branchName: r.branchName, items: [] });
      byBranch.get(k).items.push({
        productDefinitionId: r.productDefinitionId,
        productName: r.productName,
        unit: r.unit,
        available: r.available,
        threshold: r.threshold,
        level: r.level,
      });
    }
    const notices = await StockLowStockNoticeModel.insertMany([...byBranch.values()]);
    notices.forEach((n) => emitAlertEvent(LOW_STOCK_EVENT, n._id));
    return notices.length;
  }
}
