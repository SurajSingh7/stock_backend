import StockInvoiceModel from "../models/stock.invoice.model.js";
import StockInvoiceAdjustmentModel from "../models/stock.invoice.adjustment.model.js";
import StockPurchaseOrderModel from "../models/stock.purchase.order.model.js";
import StockVendorModel from "../models/stock.vendor.model.js";
import StockInvoiceService from "./stock.invoice.service.js";
import { applyDataScope } from "../helpers/data.scope.helper.js";
import { paginate } from "../helpers/pagination.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import {
  INVOICE_STATUS,
  ADJUSTMENT_TYPE,
  ADJUSTMENT_DIRECTION,
  PAYMENT_APPROVAL_STATUS,
  PAYMENT_STATE,
  termDays,
} from "../constants/stock.enums.js";

const log = getLogger(import.meta.url);

/*
  ── Vendor ledger ─────────────────────────────────────────────────────────
  What we owe each vendor, month by month, and how that number was reached.

  The thing to understand about a ledger, and the reason it is NOT a report:
  one row's columns come from three DIFFERENT dates.

      billing        the INVOICE date     — the bill's own date
      credit / misc  the date RAISED      — when accounts put it on the invoice
      paid           the date PAID        — when the money actually left

  That is correct, not a bug: a January bill settled in March belongs to
  January's billing and March's payments. It is also exactly why a ledger has
  to carry a balance forward — without an opening and a closing, the columns
  of any single month will never add up to what is outstanding, and the first
  question anyone asks is "where is this difference coming from".

  Outstanding and ageing are the one exception to the period filter: they are
  always AS ON TODAY across every invoice, because "how much is stuck" is not
  a question about a date range.
*/

/*
  The ledger's own module. Every method below takes a moduleKey and defaults
  to this one, because the report pages read the SAME data through their own
  modules — billing-report, outstanding-report, transaction-register,
  invoice-breakup — and the data scope is resolved per module. Hardcoding this
  key would silently give every report the ledger's scope instead of its own.
*/
const SCOPE_MODULE_KEY = "vendor-ledger";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const dayDiff = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / 86400000);
// "2026-09" — the key every bucket is grouped on, so one helper decides what
// month a date belongs to and nothing else has an opinion.
const monthKey = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`;
};

// Overdue buckets, in the order an accounts desk reads them.
const AGEING_BUCKETS = [
  { key: "CURRENT", label: "Not due", min: -Infinity, max: 0 },
  { key: "D0_30", label: "0-30 days", min: 1, max: 30 },
  { key: "D31_60", label: "31-60 days", min: 31, max: 60 },
  { key: "D61_90", label: "61-90 days", min: 61, max: 90 },
  { key: "D90_PLUS", label: "90+ days", min: 91, max: Infinity },
];
const bucketFor = (daysOverdue) =>
  (AGEING_BUCKETS.find((b) => daysOverdue >= b.min && daysOverdue <= b.max) || AGEING_BUCKETS[0]).key;

/*
  WHERE an outstanding amount is stuck — a different question from how old it
  is, and one this module could not answer at all.

  Rejecting a payment approval does not cancel a debt: the vendor still billed
  us, so a rejected invoice stays here and keeps counting towards what we owe.
  Dropping it would make outstanding fall the moment somebody rejected
  something, which is the most dangerous lie a ledger can tell.

  But a total with no explanation is why a rejected invoice looked identical to
  one about to be paid. So the outstanding is also split by the stage its
  payment has reached. Same money, same total, with the reason it has not
  moved attached.
*/
export const OUTSTANDING_STAGE = {
  NOT_SENT: "NOT_SENT",        // no payment approval requested yet
  IN_APPROVAL: "IN_APPROVAL",  // waiting on the approval team
  REJECTED: "REJECTED",        // sent back — somebody has to fix it
  CLEARED: "CLEARED",          // approved, money not out yet
};

const stageFor = (approvalStatus) =>
  !approvalStatus
    ? OUTSTANDING_STAGE.NOT_SENT
    : approvalStatus === PAYMENT_APPROVAL_STATUS.PENDING
      ? OUTSTANDING_STAGE.IN_APPROVAL
      : approvalStatus === PAYMENT_APPROVAL_STATUS.REJECTED
        ? OUTSTANDING_STAGE.REJECTED
        : OUTSTANDING_STAGE.CLEARED;

const emptyStages = () =>
  Object.fromEntries(Object.keys(OUTSTANDING_STAGE).map((k) => [k, 0]));

/*
  Which invoices count, by whether money has actually moved on them.

  Asked for as "only show it once an amount has been entered". As a FILTER
  that is a fair question and this is it. As the ledger's only reality it
  would be fatal: hide every unpaid invoice and outstanding is always zero,
  the ageing buckets are always empty, and the one number this page exists to
  produce can never be shown.
*/
export const MOVEMENT_FILTER = {
  ALL: "ALL",
  MOVED: "MOVED",  // something has been paid against it
  NONE: "NONE",    // billed, nothing paid
};

export default class StockVendorLedgerService {
  /*
    Loads every approved invoice in scope, with its PO, its accepted
    adjustments and its payments — the raw material every view here is built
    from.

    One pass for the whole page rather than per vendor. Resolved in memory for
    the same reason the rest of this module is: payment terms live on the
    purchase order, so no single query can group by due date anyway. Same
    "volumes here are small" tradeoff documented on
    StockInvoicePaymentService.getList.
  */
  static async _loadFacts(dataAccess, extraFilter = {}, moduleKey = SCOPE_MODULE_KEY) {
    const filter = applyDataScope(
      { isActive: true, status: INVOICE_STATUS.APPROVED, ...extraFilter },
      dataAccess,
      moduleKey
    );

    const invoices = await StockInvoiceModel.find(filter).lean();
    if (!invoices.length) {
      return { invoices: [], poById: new Map(), adjByInvoice: new Map(), vendorById: new Map() };
    }

    /*
      vendorId and vendorName are pulled off the PO as well, because the
      invoice's own vendorId is NULLABLE (default: null) while the PO's is
      required.

      That nullable field is what made this page merge unrelated invoices: the
      vendor rollup keys on String(vendorId || "none"), so every invoice
      missing one landed in a single row wearing whichever vendor name arrived
      first — different invoices' figures added up under one wrong name.
      Falling back to the PO removes the "none" case rather than labelling it.
    */
    const poIds = [...new Set(invoices.map((i) => String(i.poId)).filter(Boolean))];
    const pos = await StockPurchaseOrderModel.find({ _id: { $in: poIds } })
      .select("poNumber paymentTerms taxType vendorId vendorName items.quotationItemId items.gstRate")
      .lean();
    const poById = new Map(pos.map((p) => [String(p._id), p]));

    // Every live adjustment counts. They no longer carry a status — accounts
    // create them and they take effect at once — so isActive is the whole
    // test: a withdrawn one is soft-deleted and drops out here by itself.
    const adjustments = await StockInvoiceAdjustmentModel.find({
      invoiceId: { $in: invoices.map((i) => i._id) },
      isActive: true,
    }).lean();

    const adjByInvoice = new Map();
    adjustments.forEach((a) => {
      const key = String(a.invoiceId);
      if (!adjByInvoice.has(key)) adjByInvoice.set(key, []);
      adjByInvoice.get(key).push(a);
    });

    /*
      Live vendor names, not the snapshot sitting on the invoice.

      invoice.vendorName is copied off the PO when the invoice is created, and
      that is right for the invoice — it records who was billed at the time.
      But this module LISTS BY vendor, and a rollup named after whichever
      invoice happened to be first goes stale the moment a vendor is renamed.
    */
    const vendorIds = [...new Set(
      invoices
        .map((i) => String(i.vendorId || poById.get(String(i.poId))?.vendorId || ""))
        .filter(Boolean)
    )];
    const vendors = await StockVendorModel.find({ _id: { $in: vendorIds } })
      .select("name gst panNumber paymentTerms")
      .lean();
    const vendorById = new Map(vendors.map((v) => [String(v._id), v]));

    return { invoices, poById, adjByInvoice, vendorById };
  }

  // Everything one invoice contributes, already split by the date each part
  // belongs to. Every view below reads these and nothing re-derives them.
  static _invoiceFacts(invoice, po, adjustments, vendor = null) {
    const totals = StockInvoiceService._computeInvoiceTotals(invoice, po);
    /*
      The CONTRACTUAL due date, always: the bill's own date plus the term.

      Deliberately NOT the scheduled date. If we defer an invoice because the
      money is not there, the vendor still counts it overdue from the day the
      terms said — and a ledger exists to be reconciled against the vendor's
      own books, not against our intentions. Ageing that ran off our schedule
      would always report that nothing is late, which is the one thing a ledger
      must never do.
    */
    const days = termDays(po?.paymentTerms || "");
    const dueDate = addDays(startOfDay(invoice.invoiceDate), days);

    const credits = (adjustments || []).filter((a) => a.direction === ADJUSTMENT_DIRECTION.DEDUCT);
    const miscs = (adjustments || []).filter((a) => a.direction === ADJUSTMENT_DIRECTION.ADD);

    const creditTotal = round2(credits.reduce((s, a) => s + (a.amount || 0), 0));
    const miscTotal = round2(miscs.reduce((s, a) => s + (a.amount || 0), 0));
    const payable = round2(totals.grandTotal - creditTotal + miscTotal);
    const paidTotal = round2((invoice.payments || []).reduce((s, p) => s + (p.amount || 0), 0));

    /*
      How far this invoice's payment has got, and how much of it is real money
      still owed.

      The ledger knew none of this before, which is exactly why a rejected
      invoice looked identical to one about to be paid. Read once here so every
      view agrees instead of each deriving its own answer.
    */
    const approvalStatus = invoice.paymentApprovalStatus || null;
    const remaining = round2(payable - paidTotal);
    const autoPaymentState =
      paidTotal <= 0
        ? PAYMENT_STATE.UNPAID
        : remaining > 0
          ? PAYMENT_STATE.PARTIAL
          : PAYMENT_STATE.PAID;
    const paymentState = invoice.paymentStateOverride || autoPaymentState;
    const paymentClosed = paymentState === PAYMENT_STATE.PAID;

    /*
      Money settled short is NOT outstanding.

      Close a 45,000 invoice at 44,000 and that 1,000 will never be paid — it
      is a write-off, not a debt. Left in outstanding it would sit in the 90+
      ageing bucket for ever and quietly overstate what we owe. It is carried
      as its own figure so it stays visible and the balance still reconciles.
    */
    const writtenOff = paymentClosed && remaining > 0 ? remaining : 0;
    const outstanding = paymentClosed ? 0 : remaining;

    return {
      invoiceId: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      poNumber: po?.poNumber || "",
      vendorId: invoice.vendorId || po?.vendorId || null,
      // Live name first, then the invoice's snapshot, then the PO's.
      vendorName: vendor?.name || invoice.vendorName || po?.vendorName || "—",
      paymentTerms: po?.paymentTerms || "",
      dueDate,

      approvalStatus,
      rejectedReason:
        approvalStatus === PAYMENT_APPROVAL_STATUS.REJECTED
          ? invoice.paymentApproval?.rejectedReason || ""
          : "",
      paymentState,
      stage: stageFor(approvalStatus),
      paymentClosed,

      totals,
      // Each carries the date it belongs to, so the month grouping below never
      // has to guess which one applies.
      /*
        createdOn, falling back to the document's own timestamp.

        An adjustment belongs to the month it was PUT ON the invoice, not the
        month the invoice is dated: that is when the payable actually moved,
        and the ledger has to show the balance changing on the day it changed.
        Editing one later does not move it — the correction belongs where the
        original decision was made.
      */
      creditEvents: credits.map((a) => ({
        at: a.createdOn || a.createdAt,
        amount: a.amount || 0,
        basicAmount: a.itemsBasicAmount || 0,
        gstAmount: a.itemsGstAmount || 0,
        extrasAmount: a.extrasAmount || 0,
        reason: a.reason || "",
      })),
      miscEvents: miscs.map((a) => ({
        at: a.createdOn || a.createdAt,
        amount: a.amount || 0,
        reason: a.reason || "",
      })),
      paymentEvents: (invoice.payments || []).map((p) => ({
        at: p.paidOn,
        amount: p.amount || 0,
        mode: p.mode,
        refNo: p.refNo || "",
      })),
      /*
        A write-off is a movement like any other: it happened on the day
        somebody decided it. The month-wise ledger has to see it or its
        closing balance will carry a debt nobody intends to settle, for ever.
        Same shape as the other event arrays for that reason.
      */
      writeOffEvents:
        writtenOff > 0 && invoice.paymentOverrideAt
          ? [{
              at: invoice.paymentOverrideAt,
              amount: writtenOff,
              reason: invoice.paymentOverrideReason || "",
            }]
          : [],

      creditTotal,
      miscTotal,
      payable,
      paidTotal,
      writtenOff,
      outstanding,
    };
  }

  /*
    The list page: one row per vendor.

    Period columns (billing, credit, misc, paid) respect from/to. Outstanding
    and ageing deliberately do not — see the note at the top of this file.
  */
  static async getVendorSummary(query = {}, dataAccess, moduleKey = SCOPE_MODULE_KEY) {
    const { skip, limit, page } = paginate(query);
    const { search, branchId, from, to, ageing, movement, stage } = query;

    const extra = {};
    if (branchId) extra.branchId = branchId;

    const { invoices, poById, adjByInvoice, vendorById } =
      await StockVendorLedgerService._loadFacts(dataAccess, extra, moduleKey);

    const fromDate = from ? startOfDay(from) : null;
    const toDate = to ? startOfDay(to) : null;
    const inPeriod = (d) => {
      if (!d) return false;
      const x = startOfDay(d);
      if (fromDate && x < fromDate) return false;
      if (toDate && x > toDate) return false;
      return true;
    };

    const today = new Date();
    const byVendor = new Map();

    const wanted = movement && movement !== MOVEMENT_FILTER.ALL ? movement : null;

    invoices.forEach((inv) => {
      const po = poById.get(String(inv.poId)) || null;
      const vendorKey = String(inv.vendorId || po?.vendorId || "");
      const f = StockVendorLedgerService._invoiceFacts(
        inv, po, adjByInvoice.get(String(inv._id)), vendorById.get(vendorKey) || null
      );

      /*
        Applied per INVOICE, before anything is added up: a vendor whose
        invoices all fail the filter should drop off the list entirely, not
        appear with a zero in every column.
      */
      if (wanted === MOVEMENT_FILTER.MOVED && f.paidTotal <= 0) return;
      if (wanted === MOVEMENT_FILTER.NONE && f.paidTotal > 0) return;

      const key = vendorKey || "none";
      if (!byVendor.has(key)) {
        byVendor.set(key, {
          vendorId: f.vendorId,
          vendorName: f.vendorName,
          invoiceCount: 0,
          /*
            extraCharges is its own column, not folded into basic.

            Billing is (basic + extraCharges) + GST, so a screen showing only
            basic and GST leaves an unexplained gap on any invoice carrying
            freight or handling — the row simply does not add up, and the first
            thing a reader does is distrust the total.
          */
          basic: 0, extraCharges: 0, cgst: 0, sgst: 0, igst: 0,
          billing: 0, creditNotes: 0, misc: 0, netPayable: 0, paid: 0,
          writtenOff: 0,
          outstanding: 0,
          // The same outstanding, split by why it has not moved.
          outstandingBy: emptyStages(),
          stageCount: emptyStages(),
          overdueCount: 0, overdueAmount: 0,
          ageing: Object.fromEntries(AGEING_BUCKETS.map((b) => [b.key, 0])),
        });
      }
      const v = byVendor.get(key);

      if (inPeriod(f.invoiceDate)) {
        v.invoiceCount += 1;
        v.basic = round2(v.basic + f.totals.basicAmount);
        v.extraCharges = round2(v.extraCharges + f.totals.extraChargesTotal);
        v.cgst = round2(v.cgst + f.totals.cgstAmount);
        v.sgst = round2(v.sgst + f.totals.sgstAmount);
        v.igst = round2(v.igst + f.totals.igstAmount);
        v.billing = round2(v.billing + f.totals.grandTotal);
      }
      f.creditEvents.forEach((e) => { if (inPeriod(e.at)) v.creditNotes = round2(v.creditNotes + e.amount); });
      f.miscEvents.forEach((e) => { if (inPeriod(e.at)) v.misc = round2(v.misc + e.amount); });
      f.paymentEvents.forEach((e) => { if (inPeriod(e.at)) v.paid = round2(v.paid + e.amount); });
      f.writeOffEvents.forEach((e) => { if (inPeriod(e.at)) v.writtenOff = round2(v.writtenOff + e.amount); });

      // As on today, whatever the period filter says.
      v.outstanding = round2(v.outstanding + f.outstanding);
      if (f.outstanding > 0) {
        v.outstandingBy[f.stage] = round2(v.outstandingBy[f.stage] + f.outstanding);
        v.stageCount[f.stage] += 1;

        const overdueBy = dayDiff(today, f.dueDate);
        v.ageing[bucketFor(overdueBy)] = round2(v.ageing[bucketFor(overdueBy)] + f.outstanding);
        if (overdueBy > 0) {
          v.overdueCount += 1;
          v.overdueAmount = round2(v.overdueAmount + f.outstanding);
        }
      }
    });

    let rows = [...byVendor.values()].map((v) => ({
      ...v,
      netPayable: round2(v.billing - v.creditNotes + v.misc),
    }));

    const text = String(search || "").trim().toLowerCase();
    if (text) rows = rows.filter((r) => String(r.vendorName || "").toLowerCase().includes(text));
    if (ageing && ageing !== "ALL") rows = rows.filter((r) => (r.ageing[ageing] || 0) > 0);
    /*
      Vendors with outstanding sitting at this stage. Mirrors the ageing filter
      above rather than dropping rows to zero: asking for "Rejected" means
      "show me who has something rejected", not "show me every vendor with a
      rejected column of nil".
    */
    if (stage && stage !== "ALL") rows = rows.filter((r) => (r.outstandingBy[stage] || 0) > 0);

    // Most owed first — the page exists to answer "who is waiting on us".
    rows.sort((a, b) => b.outstanding - a.outstanding);

    // A plain loop rather than a reduce: the stage breakdown is a nested
    // object, and threading that through an accumulator spread reads worse
    // than it runs.
    const totals = {
      vendors: rows.length,
      invoiceCount: 0,
      // The tax columns were missing here, so every one of them totalled to
      // undefined and every screen rendered the footer as zero while the rows
      // above it held real figures.
      basic: 0, extraCharges: 0, cgst: 0, sgst: 0, igst: 0, gst: 0,
      billing: 0, creditNotes: 0, misc: 0,
      netPayable: 0, paid: 0, writtenOff: 0, outstanding: 0,
      // Overdue sat on every row but was never totalled, so the Outstanding
      // footer had nothing to show under a column the page leans on.
      overdueCount: 0, overdueAmount: 0,
      outstandingBy: emptyStages(),
    };
    rows.forEach((r) => {
      totals.invoiceCount += r.invoiceCount;
      totals.basic = round2(totals.basic + r.basic);
      totals.extraCharges = round2(totals.extraCharges + r.extraCharges);
      totals.cgst = round2(totals.cgst + r.cgst);
      totals.sgst = round2(totals.sgst + r.sgst);
      totals.igst = round2(totals.igst + r.igst);
      // Summed from the parts rather than carried on the row: nothing stores a
      // combined GST per vendor, and deriving it twice is how the two stop
      // agreeing.
      totals.gst = round2(totals.gst + r.cgst + r.sgst + r.igst);
      totals.billing = round2(totals.billing + r.billing);
      totals.creditNotes = round2(totals.creditNotes + r.creditNotes);
      totals.misc = round2(totals.misc + r.misc);
      totals.netPayable = round2(totals.netPayable + r.netPayable);
      totals.paid = round2(totals.paid + r.paid);
      totals.writtenOff = round2(totals.writtenOff + r.writtenOff);
      totals.outstanding = round2(totals.outstanding + r.outstanding);
      totals.overdueCount += r.overdueCount;
      totals.overdueAmount = round2(totals.overdueAmount + r.overdueAmount);
      Object.keys(OUTSTANDING_STAGE).forEach((k) => {
        totals.outstandingBy[k] = round2(totals.outstandingBy[k] + (r.outstandingBy[k] || 0));
      });
    });

    return {
      data: {
        rows: rows.slice(skip, skip + limit),
        totals,
        buckets: AGEING_BUCKETS,
        stages: OUTSTANDING_STAGE,
      },
      total: rows.length,
      page,
      limit,
    };
  }

  /*
    One vendor, twelve months of one year, with the balance carried forward.

    Opening is everything that happened BEFORE 1 January of that year — which
    is what makes this a ledger rather than a stack of monthly summaries. Read
    down the closing column and it reconciles; without it, it never would.
  */
  static async getVendorLedger(vendorId, query = {}, dataAccess, moduleKey = SCOPE_MODULE_KEY) {
    const year = Number(query.year) || new Date().getFullYear();
    const { invoices, poById, adjByInvoice, vendorById } = await StockVendorLedgerService._loadFacts(
      dataAccess, { vendorId }, moduleKey
    );

    const vendor = await StockVendorModel.findOne({ _id: vendorId })
      .select("name gst panNumber paymentTerms branchId")
      .lean();

    const facts = invoices.map((inv) => {
      const po = poById.get(String(inv.poId)) || null;
      return StockVendorLedgerService._invoiceFacts(
        inv, po, adjByInvoice.get(String(inv._id)),
        vendorById.get(String(inv.vendorId || po?.vendorId || "")) || vendor || null
      );
    });

    const empty = () => ({
      invoiceCount: 0, basic: 0, cgst: 0, sgst: 0, igst: 0,
      billing: 0, creditNotes: 0, creditBasic: 0, creditGst: 0, misc: 0, paid: 0,
      writtenOff: 0,
    });
    const months = Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      key: `${year}-${String(i + 1).padStart(2, "0")}`,
      ...empty(),
    }));
    const byKey = new Map(months.map((m) => [m.key, m]));

    // Anything dated before this year rolls into the opening balance.
    let opening = 0;
    const beforeYear = (d) => d && new Date(d).getFullYear() < year;

    const put = (d, fn) => {
      const k = monthKey(d);
      const bucket = byKey.get(k);
      if (bucket) fn(bucket);
    };

    facts.forEach((f) => {
      if (beforeYear(f.invoiceDate)) opening = round2(opening + f.totals.grandTotal);
      put(f.invoiceDate, (m) => {
        m.invoiceCount += 1;
        m.basic = round2(m.basic + f.totals.basicAmount);
        m.cgst = round2(m.cgst + f.totals.cgstAmount);
        m.sgst = round2(m.sgst + f.totals.sgstAmount);
        m.igst = round2(m.igst + f.totals.igstAmount);
        m.billing = round2(m.billing + f.totals.grandTotal);
      });

      f.creditEvents.forEach((e) => {
        if (beforeYear(e.at)) opening = round2(opening - e.amount);
        put(e.at, (m) => {
          m.creditNotes = round2(m.creditNotes + e.amount);
          m.creditBasic = round2(m.creditBasic + e.basicAmount + e.extrasAmount);
          m.creditGst = round2(m.creditGst + e.gstAmount);
        });
      });
      f.miscEvents.forEach((e) => {
        if (beforeYear(e.at)) opening = round2(opening + e.amount);
        put(e.at, (m) => { m.misc = round2(m.misc + e.amount); });
      });
      f.paymentEvents.forEach((e) => {
        if (beforeYear(e.at)) opening = round2(opening - e.amount);
        put(e.at, (m) => { m.paid = round2(m.paid + e.amount); });
      });
      // A write-off reduces the balance exactly the way a payment does — it
      // just never reaches the vendor. Without it the closing column would
      // carry a debt nobody intends to settle.
      f.writeOffEvents.forEach((e) => {
        if (beforeYear(e.at)) opening = round2(opening - e.amount);
        put(e.at, (m) => { m.writtenOff = round2(m.writtenOff + e.amount); });
      });
    });

    // The carry-forward itself.
    let running = opening;
    const rows = months.map((m) => {
      const netPayable = round2(m.billing - m.creditNotes + m.misc);
      const openingBalance = running;
      const closing = round2(openingBalance + netPayable - m.paid - m.writtenOff);
      running = closing;
      return { ...m, netPayable, opening: openingBalance, closing };
    });

    const totals = rows.reduce(
      (t, r) => ({
        invoiceCount: t.invoiceCount + r.invoiceCount,
        basic: round2(t.basic + r.basic),
        cgst: round2(t.cgst + r.cgst),
        sgst: round2(t.sgst + r.sgst),
        igst: round2(t.igst + r.igst),
        billing: round2(t.billing + r.billing),
        creditNotes: round2(t.creditNotes + r.creditNotes),
        creditBasic: round2(t.creditBasic + r.creditBasic),
        creditGst: round2(t.creditGst + r.creditGst),
        misc: round2(t.misc + r.misc),
        netPayable: round2(t.netPayable + r.netPayable),
        paid: round2(t.paid + r.paid),
        writtenOff: round2(t.writtenOff + r.writtenOff),
      }),
      { invoiceCount: 0, basic: 0, cgst: 0, sgst: 0, igst: 0, billing: 0, creditNotes: 0, creditBasic: 0, creditGst: 0, misc: 0, netPayable: 0, paid: 0, writtenOff: 0 }
    );

    // Which years actually have something in them, so the year pager only
    // offers years there is data for instead of scrolling into empty space.
    const years = [...new Set(
      facts.flatMap((f) => [
        new Date(f.invoiceDate).getFullYear(),
        ...f.paymentEvents.map((e) => new Date(e.at).getFullYear()),
      ])
    )].filter(Boolean).sort();

    return {
      vendor: {
        _id: vendorId,
        name: vendor?.name || facts[0]?.vendorName || "—",
        gstNumber: vendor?.gst?.gstNumber || "",
        panNumber: vendor?.panNumber || "",
        paymentTerms: vendor?.paymentTerms || "",
      },
      year,
      years,
      opening,
      rows,
      totals,
      closing: running,
    };
  }

  /*
    One month of one vendor, transaction by transaction.

    A ledger with no way in is a dead end: the first thing anyone does on
    seeing an unexpected figure is ask which documents are behind it.
  */
  static async getMonthDetail(vendorId, query = {}, dataAccess, moduleKey = SCOPE_MODULE_KEY) {
    const year = Number(query.year) || new Date().getFullYear();
    const month = Number(query.month) || 1;
    const key = `${year}-${String(month).padStart(2, "0")}`;

    const { invoices, poById, adjByInvoice } = await StockVendorLedgerService._loadFacts(
      dataAccess, { vendorId }, moduleKey
    );

    const billing = [];
    const credits = [];
    const miscs = [];
    const payments = [];
    const writeOffs = [];

    invoices.forEach((inv) => {
      const f = StockVendorLedgerService._invoiceFacts(
        inv, poById.get(String(inv.poId)) || null, adjByInvoice.get(String(inv._id))
      );

      if (monthKey(f.invoiceDate) === key) {
        billing.push({
          invoiceId: f.invoiceId, invoiceNumber: f.invoiceNumber, poNumber: f.poNumber,
          date: f.invoiceDate, dueDate: f.dueDate,
          basic: f.totals.basicAmount, cgst: f.totals.cgstAmount,
          sgst: f.totals.sgstAmount, igst: f.totals.igstAmount,
          amount: f.totals.grandTotal,
        });
      }
      /*
        Every event row now carries the invoice it belongs to by ID, plus the
        PO number and the invoice's own date.

        invoiceNumber alone identified nothing: NOTHING makes it unique (the
        model only marks it required — no unique index, no duplicate check in
        the service or the validator), so two invoices can share a number and
        the rows for both read as one invoice listed twice. The PO number and
        date tell them apart on sight; the id tells them apart in code.
      */
      const ref = {
        invoiceId: f.invoiceId,
        invoiceNumber: f.invoiceNumber,
        poNumber: f.poNumber,
        invoiceDate: f.invoiceDate,
      };

      f.creditEvents.forEach((e) => {
        if (monthKey(e.at) === key) {
          credits.push({ ...ref, date: e.at, amount: e.amount, basicAmount: e.basicAmount, gstAmount: e.gstAmount, reason: e.reason });
        }
      });
      f.miscEvents.forEach((e) => {
        if (monthKey(e.at) === key) {
          miscs.push({ ...ref, date: e.at, amount: e.amount, reason: e.reason });
        }
      });
      f.paymentEvents.forEach((e) => {
        if (monthKey(e.at) === key) {
          payments.push({ ...ref, date: e.at, amount: e.amount, mode: e.mode, refNo: e.refNo });
        }
      });
      f.writeOffEvents.forEach((e) => {
        if (monthKey(e.at) === key) {
          writeOffs.push({ ...ref, date: e.at, amount: e.amount, reason: e.reason });
        }
      });
    });

    const byDate = (a, b) => new Date(a.date) - new Date(b.date);
    billing.sort(byDate); credits.sort(byDate); miscs.sort(byDate);
    payments.sort(byDate); writeOffs.sort(byDate);

    log.info(`Vendor ledger month detail ${key} for vendor ${vendorId}`);
    return { year, month, billing, credits, miscs, payments, writeOffs };
  }

  /*
    One vendor, invoice by invoice — the level this module was missing.

    There were only two views before: a single rolled-up row per vendor, and a
    month of transactions. Neither answers "which invoice is this, and what is
    happening to it", so an unexpected figure had nowhere to be traced back to
    and two invoices sharing a number were indistinguishable.

    Deliberately NOT grouped by month: an invoice is one thing whatever month
    its payments happened to land in. The month view already answers the other
    question.
  */
  static async getVendorInvoices(vendorId, query = {}, dataAccess, moduleKey = SCOPE_MODULE_KEY) {
    const { skip, limit, page } = paginate(query);
    const { search, movement, stage, year } = query;

    const { invoices, poById, adjByInvoice, vendorById } =
      await StockVendorLedgerService._loadFacts(dataAccess, { vendorId }, moduleKey);

    const vendor = await StockVendorModel.findOne({ _id: vendorId })
      .select("name gst panNumber paymentTerms")
      .lean();

    const today = new Date();

    let rows = invoices.map((inv) => {
      const po = poById.get(String(inv.poId)) || null;
      const f = StockVendorLedgerService._invoiceFacts(
        inv, po, adjByInvoice.get(String(inv._id)),
        vendorById.get(String(inv.vendorId || po?.vendorId || "")) || vendor || null
      );
      const overdueBy = dayDiff(today, f.dueDate);
      return {
        invoiceId: f.invoiceId,
        invoiceNumber: f.invoiceNumber,
        poNumber: f.poNumber,
        invoiceDate: f.invoiceDate,
        dueDate: f.dueDate,
        paymentTerms: f.paymentTerms,

        billing: f.totals.grandTotal,
        basic: f.totals.basicAmount,
        cgst: f.totals.cgstAmount,
        sgst: f.totals.sgstAmount,
        igst: f.totals.igstAmount,
        creditNotes: f.creditTotal,
        misc: f.miscTotal,
        payable: f.payable,
        paid: f.paidTotal,
        writtenOff: f.writtenOff,
        outstanding: f.outstanding,

        approvalStatus: f.approvalStatus,
        rejectedReason: f.rejectedReason,
        paymentState: f.paymentState,
        stage: f.stage,

        /*
          Ageing is meaningless once nothing is owed, so a settled invoice
          reports 0 and a null bucket rather than however overdue it was on
          the day it got paid.
        */
        daysOverdue: f.outstanding > 0 && overdueBy > 0 ? overdueBy : 0,
        ageingBucket: f.outstanding > 0 ? bucketFor(overdueBy) : null,
        paymentCount: (inv.payments || []).length,
      };
    });

    if (year) {
      const y = Number(year);
      rows = rows.filter((r) => new Date(r.invoiceDate).getFullYear() === y);
    }

    // Both numbers, because a duplicate invoice number is exactly the case
    // somebody is trying to pull apart when they search here.
    const text = String(search || "").trim().toLowerCase();
    if (text) {
      rows = rows.filter(
        (r) =>
          String(r.invoiceNumber || "").toLowerCase().includes(text) ||
          String(r.poNumber || "").toLowerCase().includes(text)
      );
    }

    if (movement === MOVEMENT_FILTER.MOVED) rows = rows.filter((r) => r.paid > 0);
    else if (movement === MOVEMENT_FILTER.NONE) rows = rows.filter((r) => r.paid <= 0);

    // A stage only describes money still owed, so this implies outstanding.
    if (stage && stage !== "ALL") {
      rows = rows.filter((r) => r.stage === stage && r.outstanding > 0);
    }

    // Newest bill first: the question on this screen is nearly always about
    // something recent.
    rows.sort((a, b) => new Date(b.invoiceDate) - new Date(a.invoiceDate));

    const totals = {
      invoiceCount: rows.length,
      billing: 0, creditNotes: 0, misc: 0, payable: 0,
      paid: 0, writtenOff: 0, outstanding: 0,
    };
    rows.forEach((r) => {
      totals.billing = round2(totals.billing + r.billing);
      totals.creditNotes = round2(totals.creditNotes + r.creditNotes);
      totals.misc = round2(totals.misc + r.misc);
      totals.payable = round2(totals.payable + r.payable);
      totals.paid = round2(totals.paid + r.paid);
      totals.writtenOff = round2(totals.writtenOff + r.writtenOff);
      totals.outstanding = round2(totals.outstanding + r.outstanding);
    });

    log.info(`Vendor ledger invoices for vendor ${vendorId}: ${rows.length} row(s)`);
    return {
      data: {
        vendor: {
          _id: vendorId,
          name: vendor?.name || "—",
          gstNumber: vendor?.gst?.gstNumber || "",
          panNumber: vendor?.panNumber || "",
          paymentTerms: vendor?.paymentTerms || "",
        },
        rows: rows.slice(skip, skip + limit),
        totals,
        stages: OUTSTANDING_STAGE,
      },
      total: rows.length,
      page,
      limit,
    };
  }
}
