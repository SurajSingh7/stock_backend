import StockInvoiceAdjustmentModel from "../models/stock.invoice.adjustment.model.js";
import StockVendorLedgerService from "./stock.vendor.ledger.service.js";
import StockInvoiceService from "./stock.invoice.service.js";
import { paginate } from "../helpers/pagination.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import {
  ADJUSTMENT_TYPE,
  ADJUSTMENT_DIRECTION,
  PAYMENT_MODE_ARRAY,
} from "../constants/stock.enums.js";

const log = getLogger(import.meta.url);

/*
  ── Vendor money reports ──────────────────────────────────────────────────
  Two cross-vendor registers the ledger could not produce.

  Billing and Outstanding are NOT here: they are the vendor ledger's own
  summary read with different columns, so their controllers call
  StockVendorLedgerService.getVendorSummary directly with their own moduleKey.
  Copying that arithmetic into this file would give the same figure two
  implementations and, eventually, two answers.

  What IS here needs data the ledger deliberately does not surface:

      Transaction        every payment, credit note and misc charge across
      register           every vendor, one row each, newest first. The ledger
                         only ever gives per-vendor totals, or one vendor's one
                         month — neither can be ticked off against a bank
                         statement, and neither shows a withdrawn credit note
                         at all.

      Invoice breakup    an invoice's LINES. The ledger stops at the invoice
                         total, so "why is this the amount" had no answer
                         anywhere in the system.

  Both reuse StockVendorLedgerService._loadFacts and _invoiceFacts rather than
  re-querying. Same reason: one definition of what an invoice contributes.
*/

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

/*
  The three kinds of thing that happen to a vendor invoice, plus ALL for the
  tab that interleaves them.

  A parallel vocabulary to ADJUSTMENT_TYPE on purpose: a payment is not an
  adjustment, but on this screen it is the same kind of row — a dated event
  with an amount and a document behind it. One enum lets the register sort and
  count them together without special cases.
*/
export const TXN_TYPE = {
  ALL: "ALL",
  PAYMENT: "PAYMENT",
  CREDIT_NOTE: "CREDIT_NOTE",
  MISC: "MISC",
};
const TXN_TYPE_ARRAY = Object.values(TXN_TYPE);

/*
  What the row DID, which is not the same as its sign.

  A payment and a credit note both make us owe less, but only one of them
  moved money — and a reader reconciling a bank statement needs to tell them
  apart at a glance.
*/
export const TXN_EFFECT = {
  MONEY_OUT: "MONEY_OUT",                   // a payment actually left
  REDUCES_PAYABLE: "REDUCES_PAYABLE",       // credit note
  INCREASES_PAYABLE: "INCREASES_PAYABLE",   // misc charge
};

export const TXN_STATUS = {
  ACTIVE: "ACTIVE",
  WITHDRAWN: "WITHDRAWN",
};

/*
  One invoice's lines, priced and taxed.

  The arithmetic deliberately mirrors StockInvoiceService._computeInvoiceTotals
  step for step — including rounding each line's half-GST at /200 rather than
  halving a rounded total. If it rounded differently the breakup would not add
  up to the invoice it is explaining, which is the one thing it exists to do.

  GST rate comes off the PO line, not the invoice line: the invoice snapshots
  the price it was billed at, while the rate lives with the order.
*/
function lineBreakup(invoice, po) {
  const gstByItem = new Map(
    (po?.items || []).map((it) => [String(it.quotationItemId), it.gstRate || 0])
  );
  const taxType = po?.taxType || "CGST_SGST";
  const isIgst = taxType === "IGST";

  return (invoice.lines || []).map((l) => {
    const quantity = l.receivedQuantity || 0;
    const unitPrice = l.unitPrice || 0;
    const basic = round2(quantity * unitPrice);
    const gstRate = gstByItem.get(String(l.quotationItemId)) || 0;
    const gst = round2((basic * gstRate) / 100);
    const half = round2((basic * gstRate) / 200);

    return {
      categoryName: l.categoryName || "",
      productName: l.productName || "",
      unitPrice,
      quantity,
      /*
        FOC units are received but never priced. Carried as its own number
        because "40 pieces arrived, why is only 36 billed" is the question
        this column answers, and nothing else in the system answers it.
      */
      focQuantity: l.focQuantity || 0,
      basic,
      gstRate,
      cgst: isIgst ? 0 : half,
      sgst: isIgst ? 0 : half,
      igst: isIgst ? gst : 0,
      gst,
      total: round2(basic + gst),
    };
  });
}

export default class StockReportService {
  /*
    Every payment, one row each, across every vendor in scope.

    A register rather than a rollup: reconciling against a bank statement
    means matching individual transfers, and one settlement can be several
    rows — 30,000 by NEFT and 15,000 by UPI on the same day are two bank
    entries with two references. Summing them would destroy exactly the detail
    this page is for.
  */
  static _paymentRows(invoices, poById, adjByInvoice, vendorById) {
    const rows = [];
    /*
      Write-offs come back as dated events rather than one total, so each
      caller can hold them to the same period it holds the payments to. A
      write-off decided in August has no business appearing in a September
      figure just because it is not a payment.
    */
    const writeOffs = [];

    invoices.forEach((inv) => {
      const po = poById.get(String(inv.poId)) || null;
      const f = StockVendorLedgerService._invoiceFacts(
        inv,
        po,
        adjByInvoice.get(String(inv._id)),
        vendorById.get(String(inv.vendorId || po?.vendorId || "")) || null
      );

      (inv.payments || []).forEach((p, i) => {
        rows.push({
          /*
            Payment subdocuments are declared { _id: false }, so a row needs a
            key built from where it sits. Position is stable because payments
            are only ever appended.
          */
          rowKey: `payment:${inv._id}:${i}`,
          type: TXN_TYPE.PAYMENT,
          // The date this event happened on. Named the same across all three
          // kinds so the All tab can sort one mixed list without special cases.
          date: p.paidOn,
          amount: p.amount || 0,
          effect: TXN_EFFECT.MONEY_OUT,
          /*
            The reference only. The mode's display label lives on the client
            (shared/paymentStatus.js) and belongs there — a service that
            formats text for one screen stops being reusable by the next.
            `mode` travels beside this as a code for the client to label.
          */
          detail: p.refNo || "",
          byName: p.byName || "",
          status: TXN_STATUS.ACTIVE,

          mode: p.mode,
          refNo: p.refNo || "",
          remarks: p.remarks || "",
          proofs: p.proofs || [],
          enteredAt: p.at || null,

          vendorId: f.vendorId,
          vendorName: f.vendorName,
          invoiceId: f.invoiceId,
          invoiceNumber: f.invoiceNumber,
          poNumber: f.poNumber,
          invoiceDate: f.invoiceDate,
          dueDate: f.dueDate,
          branchId: inv.branchId || null,

          // The invoice this payment sits against, so a row can be read
          // without opening anything: 45,000 of a 2,53,160 payable.
          invoicePayable: f.payable,
          invoicePaidTotal: f.paidTotal,
          invoiceOutstanding: f.outstanding,
          paymentState: f.paymentState,
        });
      });

      f.writeOffEvents.forEach((e) => {
        writeOffs.push({
          at: e.at,
          amount: e.amount,
          reason: e.reason,
          vendorId: f.vendorId,
          vendorName: f.vendorName,
          invoiceId: f.invoiceId,
          invoiceNumber: f.invoiceNumber,
        });
      });
    });

    return { rows, writeOffs };
  }

  /*
    Credit notes and misc charges, one row each, with their history.

    Queried directly rather than through _loadFacts's adjByInvoice for one
    reason: that map is built with isActive: true, so a withdrawn credit note
    is invisible there — and a withdrawn credit note is precisely what somebody
    comes to a history page looking for ("we raised one, where did it go").

    Scope is inherited from the invoices, not applied here. The adjustment
    collection is deliberately absent from the data-scope registry, so the only
    correct way to scope it is to restrict it to invoice ids that were already
    scoped — the same thing StockVendorLedgerService._loadFacts does.
  */
  static async _adjustmentRows(invoices, poById, vendorById, includeWithdrawn) {
    const invoiceIds = invoices.map((i) => i._id);
    if (!invoiceIds.length) return [];

    const filter = { invoiceId: { $in: invoiceIds } };
    if (!includeWithdrawn) filter.isActive = true;
    const adjustments = await StockInvoiceAdjustmentModel.find(filter).lean();

    const invById = new Map(invoices.map((i) => [String(i._id), i]));

    return adjustments.map((a) => {
      const inv = invById.get(String(a.invoiceId)) || {};
      const po = poById.get(String(inv.poId)) || null;
      const vendor = vendorById.get(String(inv.vendorId || po?.vendorId || "")) || null;
      const isCredit = a.type === ADJUSTMENT_TYPE.CREDIT_NOTE;

      /*
        A one-line summary of what the adjustment is claiming, so the All tab
        can show every kind of row with the same column. A credit note is
        described by the units it claimed; a misc charge has no units, so its
        reason IS the description.
      */
      const detail = (a.lines || []).length
        ? a.lines.map((l) => `${l.quantity} × ${l.productName || "—"}`).join(", ")
        : a.reason || "";

      return {
        rowKey: `adjustment:${a._id}`,
        adjustmentId: a._id,
        type: isCredit ? TXN_TYPE.CREDIT_NOTE : TXN_TYPE.MISC,
        /*
          createdOn, falling back to the document timestamp. An adjustment
          belongs to the day it was PUT ON the invoice — that is when the
          payable actually moved. Editing it later does not move it.
        */
        date: a.createdOn || a.createdAt,
        amount: a.amount || 0,
        effect:
          a.direction === ADJUSTMENT_DIRECTION.DEDUCT
            ? TXN_EFFECT.REDUCES_PAYABLE
            : TXN_EFFECT.INCREASES_PAYABLE,
        detail,
        reason: a.reason || "",
        byName: a.createdByName || "",

        // Withdrawn rows are returned looking like any other, with the fact
        // and the reason attached — never silently dropped.
        status: a.isActive ? TXN_STATUS.ACTIVE : TXN_STATUS.WITHDRAWN,
        deletedByName: a.deletedByName || "",
        deletedReason: a.deletedReason || "",
        deletedAt: a.deletedAt || null,

        /*
          The edit trail, straight off the document. Nothing else in the system
          shows it, and "it used to be 60,000, who changed it" is the second
          question after "where did the credit note go".
        */
        edits: (a.edits || []).map((e) => ({
          fromAmount: e.fromAmount || 0,
          toAmount: e.toAmount || 0,
          reason: e.reason || "",
          byName: e.byName || "",
          at: e.at || null,
        })),

        lines: (a.lines || []).map((l) => ({
          productName: l.productName || "",
          quantity: l.quantity || 0,
          rate: l.rate || 0,
          gstRate: l.gstRate || 0,
          basicAmount: l.basicAmount || 0,
          gstAmount: l.gstAmount || 0,
          amount: l.amount || 0,
        })),
        extras: (a.extras || []).map((e) => ({ note: e.note || "", amount: e.amount || 0 })),

        vendorId: inv.vendorId || po?.vendorId || a.vendorId || null,
        vendorName: vendor?.name || inv.vendorName || po?.vendorName || "—",
        invoiceId: a.invoiceId,
        invoiceNumber: inv.invoiceNumber || "",
        poNumber: po?.poNumber || "",
        invoiceDate: inv.invoiceDate || null,
        branchId: inv.branchId || null,
      };
    });
  }

  /*
    The transaction register: everything that has happened against a vendor
    invoice, in one chronological list.

    One endpoint with a `type` rather than three, because it is one screen with
    tabs. Three endpoints would mean three filter implementations to keep in
    step, and the All tab would have to merge them on the client where it
    cannot paginate correctly.
  */
  static async getTransactionRegister(query = {}, dataAccess, moduleKey) {
    const { skip, limit, page } = paginate(query);
    const { search, vendorId, branchId, mode, from, to } = query;

    const type = TXN_TYPE_ARRAY.includes(query.type) ? query.type : TXN_TYPE.ALL;
    // Only meaningful on the adjustment tabs; a payment cannot be withdrawn,
    // it can only be absent.
    const includeWithdrawn = String(query.includeWithdrawn || "") === "true";

    const extra = {};
    if (vendorId) extra.vendorId = vendorId;
    if (branchId) extra.branchId = branchId;

    const { invoices, poById, adjByInvoice, vendorById } =
      await StockVendorLedgerService._loadFacts(dataAccess, extra, moduleKey);

    /*
      BOTH kinds are always built, whichever tab asked.

      The tab badges have to say "how many will I get if I click this", and
      that can only be counted with every filter EXCEPT the tab's own applied.
      Building just the requested kind would make every tab report its
      siblings as zero — the same faceted-count bug already fixed once on the
      Payments screen. The cost is one extra query on the payment tab, which
      is the right price for a number that is not a lie.
    */
    const { rows: paymentRows, writeOffs } = StockReportService._paymentRows(
      invoices, poById, adjByInvoice, vendorById
    );
    const adjustmentRows = await StockReportService._adjustmentRows(
      invoices, poById, vendorById, includeWithdrawn
    );

    let everything = paymentRows.concat(adjustmentRows);

    const fromDate = from ? startOfDay(from) : null;
    const toDate = to ? startOfDay(to) : null;
    const inWindow = (at) => {
      if (!at) return false;
      const d = startOfDay(at);
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
      return true;
    };

    everything = everything.filter((r) => inWindow(r.date));
    // Held to the same window as everything else on the page.
    const writtenOff = round2(
      writeOffs.filter((w) => inWindow(w.at)).reduce((s, w) => s + w.amount, 0)
    );

    /*
      Mode is a payment-only filter, so asking for one legitimately empties the
      adjustment tabs — a credit note was not paid by NEFT. The screen only
      offers it on the All and Payments tabs for that reason.
    */
    if (mode) everything = everything.filter((r) => r.mode === mode);

    /*
      The reference number is searchable, and that is the point of the field:
      somebody holding a bank statement has a UTR and nothing else. Reason is
      searchable for the same reason on the adjustment side.
    */
    const text = String(search || "").trim().toLowerCase();
    if (text) {
      everything = everything.filter(
        (r) =>
          String(r.vendorName || "").toLowerCase().includes(text) ||
          String(r.invoiceNumber || "").toLowerCase().includes(text) ||
          String(r.poNumber || "").toLowerCase().includes(text) ||
          String(r.refNo || "").toLowerCase().includes(text) ||
          String(r.reason || "").toLowerCase().includes(text) ||
          String(r.detail || "").toLowerCase().includes(text)
      );
    }

    // Counted over everything the other filters allow, before the tab filter.
    const byMode = Object.fromEntries(PAYMENT_MODE_ARRAY.map((m) => [m, 0]));
    const counts = { ALL: everything.length, PAYMENT: 0, CREDIT_NOTE: 0, MISC: 0, WITHDRAWN: 0 };
    const amounts = { PAYMENT: 0, CREDIT_NOTE: 0, MISC: 0 };
    const vendors = new Set();

    everything.forEach((r) => {
      counts[r.type] = (counts[r.type] || 0) + 1;
      amounts[r.type] = round2((amounts[r.type] || 0) + r.amount);
      if (r.status === TXN_STATUS.WITHDRAWN) counts.WITHDRAWN += 1;
      if (r.type === TXN_TYPE.PAYMENT && byMode[r.mode] !== undefined) {
        byMode[r.mode] = round2(byMode[r.mode] + r.amount);
      }
      if (r.vendorId) vendors.add(String(r.vendorId));
    });

    // Now the tab itself, and only now.
    const rows = type === TXN_TYPE.ALL ? everything : everything.filter((r) => r.type === type);

    // Newest first: a register is read from the latest event backwards. Ties
    // keep insertion order, so the page does not reshuffle between reloads.
    rows.sort((a, b) => new Date(b.date) - new Date(a.date));

    log.info(
      `Transaction register (${type}): ${rows.length} row(s) for module ${moduleKey}`
    );
    return {
      data: {
        rows: rows.slice(skip, skip + limit),
        totals: {
          transactions: rows.length,
          vendors: vendors.size,
          paid: amounts.PAYMENT,
          creditNotes: amounts.CREDIT_NOTE,
          misc: amounts.MISC,
          counts,
          byMode,
          /*
            Not a payment and not in byMode — no money left the building. It is
            shown because somebody reconciling payable against paid will be
            short by exactly this, and would otherwise hunt for a missing
            transfer.
          */
          writtenOff,
        },
        modes: PAYMENT_MODE_ARRAY,
        types: TXN_TYPE,
      },
      total: rows.length,
      page,
      limit,
    };
  }

  /*
    What has actually been paid to each vendor, one row per vendor.

    Built from the same _paymentRows the transaction register uses, then
    grouped — so the figure a vendor shows here and the payments listed on the
    register can never disagree. Rolling this up from a second query would put
    two answers to one question in the product.

    Deliberately small. Billing decomposes into basic, extra and three taxes
    because that is how a bill is built; a payment has no such parts — money
    left, and the only breakdown that means anything is which channel it left
    by. That rides as a per-vendor byMode map rather than five mostly-empty
    columns.
  */
  static async getPaymentSummary(query = {}, dataAccess, moduleKey) {
    const { skip, limit, page } = paginate(query);
    const { search, branchId, mode, from, to } = query;

    const extra = {};
    if (branchId) extra.branchId = branchId;

    const { invoices, poById, adjByInvoice, vendorById } =
      await StockVendorLedgerService._loadFacts(dataAccess, extra, moduleKey);

    const { rows: paymentRows, writeOffs } = StockReportService._paymentRows(
      invoices, poById, adjByInvoice, vendorById
    );

    const fromDate = from ? startOfDay(from) : null;
    const toDate = to ? startOfDay(to) : null;
    const inWindow = (at) => {
      if (!at) return false;
      const d = startOfDay(at);
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
      return true;
    };

    let payments = paymentRows.filter((p) => inWindow(p.date));
    if (mode) payments = payments.filter((p) => p.mode === mode);

    const byVendor = new Map();
    payments.forEach((p) => {
      const key = String(p.vendorId || "none");
      if (!byVendor.has(key)) {
        byVendor.set(key, {
          vendorId: p.vendorId,
          vendorName: p.vendorName,
          payments: 0,
          paid: 0,
          lastPaidOn: null,
          byMode: Object.fromEntries(PAYMENT_MODE_ARRAY.map((m) => [m, 0])),
          // Distinct invoices the money went against — a vendor paid five
          // times on one invoice is a different picture from five invoices.
          invoiceIds: new Set(),
        });
      }
      const v = byVendor.get(key);
      v.payments += 1;
      v.paid = round2(v.paid + p.amount);
      if (!v.lastPaidOn || new Date(p.date) > new Date(v.lastPaidOn)) v.lastPaidOn = p.date;
      if (v.byMode[p.mode] !== undefined) v.byMode[p.mode] = round2(v.byMode[p.mode] + p.amount);
      if (p.invoiceId) v.invoiceIds.add(String(p.invoiceId));
    });

    // Written off per vendor, so a reader checking payable against paid can
    // see where the shortfall went instead of hunting for a missing transfer.
    const writtenOffByVendor = new Map();
    let writtenOff = 0;
    writeOffs.filter((w) => inWindow(w.at)).forEach((w) => {
      const key = String(w.vendorId || "none");
      writtenOffByVendor.set(key, round2((writtenOffByVendor.get(key) || 0) + w.amount));
      writtenOff = round2(writtenOff + w.amount);
    });

    let rows = [...byVendor.entries()].map(([key, v]) => ({
      vendorId: v.vendorId,
      vendorName: v.vendorName,
      payments: v.payments,
      paid: v.paid,
      lastPaidOn: v.lastPaidOn,
      byMode: v.byMode,
      invoiceCount: v.invoiceIds.size,
      writtenOff: writtenOffByVendor.get(key) || 0,
    }));

    const text = String(search || "").trim().toLowerCase();
    if (text) rows = rows.filter((r) => String(r.vendorName || "").toLowerCase().includes(text));

    // Most paid first — the page exists to answer "where did the money go".
    rows.sort((a, b) => b.paid - a.paid);

    const totals = {
      vendors: rows.length,
      payments: 0,
      paid: 0,
      invoiceCount: 0,
      writtenOff,
      byMode: Object.fromEntries(PAYMENT_MODE_ARRAY.map((m) => [m, 0])),
    };
    rows.forEach((r) => {
      totals.payments += r.payments;
      totals.paid = round2(totals.paid + r.paid);
      totals.invoiceCount += r.invoiceCount;
      PAYMENT_MODE_ARRAY.forEach((m) => {
        totals.byMode[m] = round2(totals.byMode[m] + (r.byMode[m] || 0));
      });
    });

    log.info(`Paid report: ${rows.length} vendor(s) for module ${moduleKey}`);
    return {
      data: { rows: rows.slice(skip, skip + limit), totals, modes: PAYMENT_MODE_ARRAY },
      total: rows.length,
      page,
      limit,
    };
  }

  /*
    How each invoice's amount was arrived at, line by line.

    The question this answers is "how was this amount reached" — so it returns
    the whole chain in one row, in the order the arithmetic runs: lines priced,
    extra charges added, GST applied, credit notes taken off, misc charges
    added, payments deducted. A screen can then print the working rather than
    asking somebody to trust a total.

    Adjustments come back whole, with their own lines and extras, because a
    credit note's amount is only checkable against the units it claimed.
  */
  static async getInvoiceBreakup(query = {}, dataAccess, moduleKey) {
    const { skip, limit, page } = paginate(query);
    const { search, vendorId, branchId, from, to, state, paymentState } = query;

    const extra = {};
    if (vendorId) extra.vendorId = vendorId;
    if (branchId) extra.branchId = branchId;

    const { invoices, poById, adjByInvoice, vendorById } =
      await StockVendorLedgerService._loadFacts(dataAccess, extra, moduleKey);

    let rows = invoices.map((inv) => {
      const po = poById.get(String(inv.poId)) || null;
      const adjustments = adjByInvoice.get(String(inv._id)) || [];
      const f = StockVendorLedgerService._invoiceFacts(
        inv,
        po,
        adjustments,
        vendorById.get(String(inv.vendorId || po?.vendorId || "")) || null
      );

      const lines = lineBreakup(inv, po);
      const totals = StockInvoiceService._computeInvoiceTotals(inv, po);
      const basicFromLines = round2(lines.reduce((s, l) => s + l.basic, 0));

      return {
        invoiceId: f.invoiceId,
        invoiceNumber: f.invoiceNumber,
        invoiceDate: f.invoiceDate,
        dueDate: f.dueDate,
        paymentTerms: f.paymentTerms,
        poNumber: f.poNumber,
        vendorId: f.vendorId,
        vendorName: f.vendorName,
        branchId: inv.branchId || null,
        branchName: inv.branchName || "",
        invoiceStatus: inv.status,

        /*
          Named, not just applied. IGST versus CGST+SGST is the single most
          queried thing on a purchase invoice, and the reason lives on the PO
          where nobody looking at the invoice can see it.
        */
        taxType: totals.taxType,

        lines,
        extraCharges: (inv.extraCharges || []).map((c) => ({
          note: c.note || "",
          amount: c.amount || 0,
          includeInBilling: c.includeInBilling !== false,
        })),

        totals: {
          basicAmount: totals.basicAmount,
          extraChargesTotal: totals.extraChargesTotal,
          nonBilledChargesTotal: totals.nonBilledChargesTotal,
          cgstAmount: totals.cgstAmount,
          sgstAmount: totals.sgstAmount,
          igstAmount: totals.igstAmount,
          gstAmount: totals.gstAmount,
          grandTotal: totals.grandTotal,
        },
        /*
          Returned so a reader can see the lines reconcile to the stored
          basic. They always should — both come from the same fields — but a
          breakup that cannot be checked against the invoice it explains is
          worth nothing.
        */
        basicFromLines,

        adjustments: adjustments.map((a) => ({
          _id: a._id,
          type: a.type,
          direction: a.direction,
          amount: a.amount || 0,
          reason: a.reason || "",
          createdByName: a.createdByName || "",
          createdOn: a.createdOn || a.createdAt,
          lines: (a.lines || []).map((l) => ({
            productName: l.productName || "",
            quantity: l.quantity || 0,
            rate: l.rate || 0,
            gstRate: l.gstRate || 0,
            basicAmount: l.basicAmount || 0,
            gstAmount: l.gstAmount || 0,
            amount: l.amount || 0,
          })),
          extras: (a.extras || []).map((e) => ({ note: e.note || "", amount: e.amount || 0 })),
        })),
        creditTotal: f.creditTotal,
        miscTotal: f.miscTotal,

        payable: f.payable,
        payments: (inv.payments || []).map((p) => ({
          paidOn: p.paidOn,
          amount: p.amount || 0,
          mode: p.mode,
          refNo: p.refNo || "",
          proofs: p.proofs || [],
          byName: p.byName || "",
        })),
        paidTotal: f.paidTotal,
        writtenOff: f.writtenOff,
        outstanding: f.outstanding,

        approvalStatus: f.approvalStatus,
        rejectedReason: f.rejectedReason,
        paymentState: f.paymentState,
        stage: f.stage,
      };
    });

    const fromDate = from ? startOfDay(from) : null;
    const toDate = to ? startOfDay(to) : null;
    if (fromDate || toDate) {
      rows = rows.filter((r) => {
        const d = startOfDay(r.invoiceDate);
        if (fromDate && d < fromDate) return false;
        if (toDate && d > toDate) return false;
        return true;
      });
    }

    if (state) rows = rows.filter((r) => r.taxType === state);
    if (paymentState) rows = rows.filter((r) => r.paymentState === paymentState);

    /*
      Product name is searchable as well as the document numbers, because the
      other way into this page is "which invoices had that router on them".
    */
    const text = String(search || "").trim().toLowerCase();
    if (text) {
      rows = rows.filter(
        (r) =>
          String(r.invoiceNumber || "").toLowerCase().includes(text) ||
          String(r.poNumber || "").toLowerCase().includes(text) ||
          String(r.vendorName || "").toLowerCase().includes(text) ||
          r.lines.some((l) => String(l.productName || "").toLowerCase().includes(text))
      );
    }

    rows.sort((a, b) => new Date(b.invoiceDate) - new Date(a.invoiceDate));

    const totals = {
      invoiceCount: rows.length,
      basic: 0, extraCharges: 0, gst: 0, billing: 0,
      creditNotes: 0, misc: 0, payable: 0, paid: 0, writtenOff: 0, outstanding: 0,
    };
    rows.forEach((r) => {
      totals.basic = round2(totals.basic + r.totals.basicAmount);
      totals.extraCharges = round2(totals.extraCharges + r.totals.extraChargesTotal);
      totals.gst = round2(totals.gst + r.totals.gstAmount);
      totals.billing = round2(totals.billing + r.totals.grandTotal);
      totals.creditNotes = round2(totals.creditNotes + r.creditTotal);
      totals.misc = round2(totals.misc + r.miscTotal);
      totals.payable = round2(totals.payable + r.payable);
      totals.paid = round2(totals.paid + r.paidTotal);
      totals.writtenOff = round2(totals.writtenOff + r.writtenOff);
      totals.outstanding = round2(totals.outstanding + r.outstanding);
    });

    log.info(`Invoice breakup: ${rows.length} invoice(s) for module ${moduleKey}`);
    return {
      data: {
        rows: rows.slice(skip, skip + limit),
        totals,
        directions: ADJUSTMENT_DIRECTION,
      },
      total: rows.length,
      page,
      limit,
    };
  }
}
