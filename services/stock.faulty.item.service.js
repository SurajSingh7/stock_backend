import mongoose from "mongoose";
import StockInvoiceModel from "../models/stock.invoice.model.js";
import StockInvoiceAdjustmentModel from "../models/stock.invoice.adjustment.model.js";
import StockPurchaseOrderModel from "../models/stock.purchase.order.model.js";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import { applyDataScope } from "../helpers/data.scope.helper.js";
import { paginate } from "../helpers/pagination.helper.js";
import {
  INVOICE_STATUS,
  ADJUSTMENT_TYPE,
  DEBIT_NOTE_STATUS,
} from "../constants/stock.enums.js";

/*
  Faulty Items — every unit a debit note claimed as faulty, in one place.

  Read straight off debit-note lines (product, quantity, and for individual
  products the exact units), joined to the invoice they came on. Nothing new is
  stored.

  Which notes count: APPROVED (debited — the units are faulty for good) and
  the ones still moving (review / approval — the units are held). Rejected and
  withdrawn notes gave their units back, so they are not faulty.
*/
const MODULE_KEY = "faulty-items";
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const DEBITED = [DEBIT_NOTE_STATUS.APPROVED, null];
const UNDER_REVIEW = [
  DEBIT_NOTE_STATUS.REVIEW_PENDING,
  DEBIT_NOTE_STATUS.REVIEW_REJECTED,
  DEBIT_NOTE_STATUS.APPROVAL_PENDING,
];
export const FAULTY_STATE = { DEBITED: "DEBITED", UNDER_REVIEW: "UNDER_REVIEW" };

const stateOf = (status) => (DEBITED.includes(status ?? null) ? FAULTY_STATE.DEBITED : FAULTY_STATE.UNDER_REVIEW);

export default class StockFaultyItemService {
  // Invoices the caller may see (same documents as the Invoice List).
  static async _scopedInvoices(dataAccess, moduleKey, extra = {}) {
    const filter = applyDataScope(
      { isActive: true, $or: [{ status: INVOICE_STATUS.APPROVED }, { inLedger: true }], ...extra },
      dataAccess,
      moduleKey
    );
    return StockInvoiceModel.find(filter)
      .select("invoiceNumber invoiceDate vendorId vendorName poId branchId lines")
      .lean();
  }

  // Every faulty line on those invoices, one row per debit-note line.
  static async _rows(dataAccess, moduleKey, { vendorId } = {}) {
    const extra = {};
    if (vendorId && mongoose.Types.ObjectId.isValid(vendorId)) extra.vendorId = new mongoose.Types.ObjectId(vendorId);
    const invoices = await StockFaultyItemService._scopedInvoices(dataAccess, moduleKey, extra);
    const invById = new Map(invoices.map((i) => [String(i._id), i]));

    const notes = await StockInvoiceAdjustmentModel.find({
      invoiceId: { $in: invoices.map((i) => i._id) },
      type: ADJUSTMENT_TYPE.DEBIT_NOTE,
      isActive: true,
      status: { $in: [...DEBITED, ...UNDER_REVIEW] },
    })
      .select("invoiceId dnNumber status lines createdOn createdAt createdByName reason")
      .lean();

    const poIds = [...new Set(invoices.map((i) => String(i.poId || "")).filter(Boolean))];
    const pos = await StockPurchaseOrderModel.find({ _id: { $in: poIds } })
      .select("poNumber items.quotationItemId items.categoryId items.categoryName")
      .lean();
    const poById = new Map(pos.map((p) => [String(p._id), p]));

    const rows = [];
    for (const n of notes) {
      const inv = invById.get(String(n.invoiceId));
      if (!inv) continue;
      const po = poById.get(String(inv.poId)) || null;
      const poLine = new Map((po?.items || []).map((it) => [String(it.quotationItemId), it]));
      const invLine = new Map((inv.lines || []).map((l) => [String(l.quotationItemId), l]));
      (n.lines || []).forEach((l, idx) => {
        const il = invLine.get(String(l.quotationItemId)) || {};
        const pl = poLine.get(String(l.quotationItemId)) || {};
        const received = round2((il.receivedQuantity || 0) + (il.focQuantity || 0));
        const faulty = l.quantity || 0;
        rows.push({
          key: `${n._id}:${idx}`,
          debitNoteId: n._id,
          lineIndex: idx,
          dnNumber: n.dnNumber,
          dnStatus: n.status || DEBIT_NOTE_STATUS.APPROVED,
          state: stateOf(n.status),
          invoiceId: inv._id,
          invoiceNumber: inv.invoiceNumber,
          invoiceDate: inv.invoiceDate,
          poNumber: po?.poNumber || "",
          vendorId: inv.vendorId,
          vendorName: inv.vendorName || "",
          productDefinitionId: l.productDefinitionId,
          productName: l.productName || il.productName || "",
          categoryId: pl.categoryId || il.categoryId || null,
          categoryName: pl.categoryName || il.categoryName || "",
          received,
          faulty,
          percent: received > 0 ? round2((faulty / received) * 100) : null,
          unitCount: (l.inventoryItemIds || []).length,
          amount: l.amount || 0,
          date: n.createdOn || n.createdAt,
          raisedByName: n.createdByName || "",
          reason: n.reason || "",
        });
      });
    }
    return { rows, invoices };
  }

  static async getList(query = {}, dataAccess, moduleKey = MODULE_KEY) {
    const { skip, limit, page } = paginate(query);
    const { search, vendorId, categoryId, state, from, to } = query;
    let { rows } = await StockFaultyItemService._rows(dataAccess, moduleKey, { vendorId });

    if (categoryId) rows = rows.filter((r) => String(r.categoryId) === String(categoryId));
    const fromD = from ? new Date(from) : null;
    const toD = to ? new Date(new Date(to).setHours(23, 59, 59, 999)) : null;
    if (fromD || toD) {
      rows = rows.filter((r) => {
        const d = new Date(r.date);
        return (!fromD || d >= fromD) && (!toD || d <= toD);
      });
    }
    const text = String(search || "").trim().toLowerCase();
    if (text) {
      rows = rows.filter((r) =>
        [r.invoiceNumber, r.poNumber, r.vendorName, r.productName, r.categoryName, `dn-${r.dnNumber}`]
          .some((v) => String(v || "").toLowerCase().includes(text))
      );
    }

    // Counted before the state chip, so each chip says what clicking it shows.
    const counts = {
      ALL: rows.length,
      DEBITED: rows.filter((r) => r.state === FAULTY_STATE.DEBITED).length,
      UNDER_REVIEW: rows.filter((r) => r.state === FAULTY_STATE.UNDER_REVIEW).length,
    };
    if (state && FAULTY_STATE[state]) rows = rows.filter((r) => r.state === state);

    rows.sort((a, b) => new Date(b.date) - new Date(a.date));
    const totals = {
      faulty: round2(rows.reduce((t, r) => t + r.faulty, 0)),
      amount: round2(rows.reduce((t, r) => t + r.amount, 0)),
    };
    return { data: { rows: rows.slice(skip, skip + limit), counts, totals }, total: rows.length, page, limit };
  }

  /*
    Per vendor: how much came in on its invoices, how much of it turned out
    faulty, and the share — which vendor sends bad stock.
  */
  static async getVendorSummary(query = {}, dataAccess, moduleKey = MODULE_KEY) {
    const { state } = query;
    const { rows, invoices } = await StockFaultyItemService._rows(dataAccess, moduleKey);
    const counted = state && FAULTY_STATE[state] ? rows.filter((r) => r.state === state) : rows;

    const byVendor = new Map();
    const bucket = (id, name) => {
      const k = String(id || "none");
      if (!byVendor.has(k)) byVendor.set(k, { vendorId: id, vendorName: name || "—", received: 0, faulty: 0, amount: 0, invoices: new Set(), notes: new Set() });
      return byVendor.get(k);
    };
    // Received: everything on the vendor's invoices, faulty or not.
    invoices.forEach((inv) => {
      const v = bucket(inv.vendorId, inv.vendorName);
      v.received = round2(v.received + (inv.lines || []).reduce((t, l) => t + (l.receivedQuantity || 0) + (l.focQuantity || 0), 0));
    });
    counted.forEach((r) => {
      const v = bucket(r.vendorId, r.vendorName);
      v.faulty = round2(v.faulty + r.faulty);
      v.amount = round2(v.amount + r.amount);
      v.invoices.add(String(r.invoiceId));
      v.notes.add(String(r.debitNoteId));
    });

    const out = [...byVendor.values()]
      .filter((v) => v.faulty > 0)
      .map((v) => ({
        vendorId: v.vendorId, vendorName: v.vendorName,
        received: v.received, faulty: v.faulty,
        percent: v.received > 0 ? round2((v.faulty / v.received) * 100) : null,
        amount: v.amount, invoiceCount: v.invoices.size, debitNoteCount: v.notes.size,
      }))
      .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0));
    return out;
  }

  // The exact units on one debit-note line (serial / MAC), for an individual product.
  static async getUnits(debitNoteId, lineIndex, dataAccess, moduleKey = MODULE_KEY) {
    const note = await StockInvoiceAdjustmentModel.findOne({ _id: debitNoteId, type: ADJUSTMENT_TYPE.DEBIT_NOTE })
      .select("invoiceId lines")
      .lean();
    if (!note) throw new Error("Debit note not found");
    const [inv] = await StockFaultyItemService._scopedInvoices(dataAccess, moduleKey, { _id: note.invoiceId });
    if (!inv) throw new Error("Debit note not found");
    const line = (note.lines || [])[Number(lineIndex)];
    if (!line) throw new Error("Line not found");

    const def = await StockProductDefinitionModel.findOne({ _id: line.productDefinitionId })
      .select("selectedFields unit")
      .populate("selectedFields.fieldDefId", "code label")
      .lean();
    const fields = (def?.selectedFields || []).map((sf) => sf.fieldDefId).filter(Boolean).map((f) => ({ code: f.code, label: f.label }));
    const units = (line.inventoryItemIds || []).length
      ? await StockInventoryItemModel.find({ _id: { $in: line.inventoryItemIds } }).select("fieldValues status isFoc").lean()
      : [];
    return {
      productName: line.productName,
      quantity: line.quantity,
      unit: def?.unit || null,
      fields,
      units: units.map((u) => ({ _id: u._id, fieldValues: u.fieldValues || {}, status: u.status, isFoc: !!u.isFoc })),
    };
  }
}
