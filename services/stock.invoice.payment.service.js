import StockInvoiceModel from "../models/stock.invoice.model.js";
import StockInvoiceAdjustmentModel from "../models/stock.invoice.adjustment.model.js";
import StockPurchaseOrderModel from "../models/stock.purchase.order.model.js";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockInvoiceService from "./stock.invoice.service.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import { applyDataScope, isWithinDataScope } from "../helpers/data.scope.helper.js";
import { paginate } from "../helpers/pagination.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import { countsInPayable } from "../helpers/adjustment.helper.js";
import {
  INVOICE_STATUS,
  DUE_FILTER,
  PAYABLE_FILTER,
  PAYMENT_APPROVAL_STATUS,
  PAYMENT_STATE,
  PAYMENT_STATE_OVERRIDE_ARRAY,
  ADJUSTMENT_TYPE,
  ADJUSTMENT_DIRECTION,
  DEBIT_NOTE_STATUS,
  DEBIT_NOTE_LIVE_STATUSES,
  DEBIT_NOTE_RELEASED_STATUSES,
  ITEM_STATUS,
  ITEM_APPROVAL_STATUS,
  TRACKING_METHODS,
  termDays,
} from "../constants/stock.enums.js";

const log = getLogger(import.meta.url);

/*
  The PAYMENT side of an invoice — what we owe, when it falls due, what adjusts
  it, and what has been paid.

  Its own service and its own module keys, separate from StockInvoiceService,
  because it answers a different question for a different team. Receiving asks
  "are the goods good"; this asks "when does the money go".

  Adjustments are created here by ACCOUNTS and take effect immediately. There
  is no request-and-review round trip: that existed while the stock team raised
  them, and every trace of it has been removed rather than left as dead code
  somebody would later mistake for a live path.
*/

const SCOPE_MODULE_KEY = "invoice-list";
const ENTITY_TYPE = "invoices";
const ADJUSTMENT_ENTITY_TYPE = "invoice-adjustments";

// Midnight-anchored so "days left" never depends on the time of day a page is
// opened — 09:00 and 23:00 on the same date must give the same answer.
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
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/*
  What live adjustments do to a payable, in one place.

  Every non-deleted adjustment counts — there is no status to filter on any
  more. Direction is read off each row rather than inferred from its type, so a
  future type that can go either way needs no change here.
*/
const netAdjustment = (adjustments) =>
  round2(
    (adjustments || []).reduce(
      (sum, a) => sum + (a.direction === ADJUSTMENT_DIRECTION.DEDUCT ? -1 : 1) * (a.amount || 0),
      0
    )
  );

/*
  One debit-note line, priced the way the invoice priced it: basic at the
  snapshotted rate, plus the slab that line was billed at.

  Rounded per line rather than once at the end, so the stored line totals add
  up to the stored note total exactly — a note whose rows do not sum to its own
  figure is the first thing anyone queries.
*/
const debitLine = (src, quantity, inventoryItemIds) => {
  const basicAmount = round2(quantity * (src.rate || 0));
  const gstAmount = round2((basicAmount * (src.gstRate || 0)) / 100);
  return {
    productDefinitionId: src.productDefinitionId,
    productName: src.productName,
    quotationItemId: src.quotationItemId,
    inventoryItemIds,
    batchDraws: [],
    quantity,
    rate: src.rate,
    gstRate: src.gstRate || 0,
    basicAmount,
    gstAmount,
    amount: round2(basicAmount + gstAmount),
  };
};

export default class StockInvoicePaymentService {
  /*
    When a payment may be scheduled for: today, or any day after it.

    Returned to the client as well as enforced here, so the date picker greys
    out what would be refused instead of finding out on submit.

    `max` is null on purpose — deferring has no ceiling, because "we will pay
    after 100 days, not 90" is a real instruction and a window could not
    express it. What stops a date being pushed away for ever is the two locks
    below, plus a history of every change.

    `min` is today rather than the invoice date: scheduling something into the
    past would only manufacture overdue days for a decision taken now.
  */
  static scheduleWindow() {
    return { min: startOfDay(new Date()), max: null };
  }

  /*
    Everything the screens need about one invoice's payment position, derived —
    none of it is stored.

    The two statuses are deliberately independent: `approvalStatus` is stored
    and says whether this is cleared to pay; `paymentState` is worked out from
    the payments and says how much has gone. A screen shows both at once, which
    is only possible because neither overwrites the other.
  */
  static derivePayment(invoice, po, adjustments = []) {
    const term = po?.paymentTerms || "";
    const days = termDays(term);

    /*
      Two dates, and keeping them apart is the whole point.

      dueDate is the CONTRACT: the bill's own date plus the term. It never
      moves, because it is what the vendor's books say and what a statement has
      to reconcile against.

      scheduledOn is OUR decision about when to act on it — earlier when a
      vendor asks to be paid ahead of terms, later when the money is not there.
      Unset means "on the due date", so an untouched invoice behaves exactly as
      the terms say.
    */
    const dueDate = addDays(startOfDay(invoice.invoiceDate), days);
    const scheduledOn = invoice.paymentScheduledOn
      ? startOfDay(invoice.paymentScheduledOn)
      : dueDate;
    const rescheduled = !!invoice.paymentScheduledOn;
    const scheduleOffset = dayDiff(scheduledOn, dueDate);

    // Counts down to the SCHEDULED date: that is when work actually starts.
    // Positive = still to come, negative = overdue by that many days.
    const daysLeft = dayDiff(scheduledOn, new Date());
    // Against the contract, for anything that has to answer to the vendor.
    const daysToDue = dayDiff(dueDate, new Date());

    const totals = StockInvoiceService._computeInvoiceTotals(invoice, po);
    // A debit note still in review or approval is a claim, not money yet.
    const counted = (adjustments || []).filter(countsInPayable);
    const debitNoteLive = (adjustments || []).some(
      (a) => a.type === ADJUSTMENT_TYPE.DEBIT_NOTE && DEBIT_NOTE_LIVE_STATUSES.includes(a.status)
    );
    const adjustmentTotal = netAdjustment(counted);
    // TDS is held back from the bill itself, before any adjustment.
    const payable = round2(totals.netTotal + adjustmentTotal);
    const paidTotal = round2((invoice.payments || []).reduce((s, p) => s + (p.amount || 0), 0));
    const balance = round2(payable - paidTotal);

    const approvalStatus = invoice.paymentApprovalStatus || null;

    /*
      What the amounts say, and what somebody decided — kept apart.

      autoPaymentState is arithmetic. The override exists for the case
      arithmetic cannot express: a vendor takes 44,000 on a 45,000 invoice and
      it is PAID with 1,000 outstanding. Both are returned so a screen can show
      the state AND say it was set by hand.
    */
    const autoPaymentState =
      paidTotal <= 0 ? PAYMENT_STATE.UNPAID : balance > 0 ? PAYMENT_STATE.PARTIAL : PAYMENT_STATE.PAID;
    const paymentState = invoice.paymentStateOverride || autoPaymentState;
    const stateOverridden = !!invoice.paymentStateOverride;

    /*
      A paid invoice is CLOSED, and closed means closed — no further payment,
      whether it got the full amount or was settled short. Reopening it would
      make "paid" mean nothing, and a mistake is corrected with a misc
      adjustment rather than by quietly letting more money through.
    */
    const paymentClosed = paymentState === PAYMENT_STATE.PAID;
    // Money that will never be paid because the invoice was closed short of
    // its payable. The number an auditor asks about, so it is named.
    const writtenOff = paymentClosed && balance > 0 ? balance : 0;

    /*
      Adjustments may be touched while nothing is pending a verdict, and again
      after a rejection — a rejection usually MEANS "the debit note is wrong,
      fix it". They are frozen while an approval is pending or granted, because
      by then the payable has been quoted to somebody.
    */
    const inApprovalFlow =
      approvalStatus === PAYMENT_APPROVAL_STATUS.PENDING ||
      approvalStatus === PAYMENT_APPROVAL_STATUS.APPROVED;

    return {
      poNumber: po?.poNumber || "",
      paymentTerms: term,
      termDays: days,

      // The contract.
      dueDate,
      daysToDue,

      // The decision. scheduleKind is what the screens put a badge on, so the
      // difference between "nobody touched this" and "somebody moved it" is
      // visible without comparing two dates by eye.
      scheduledOn,
      rescheduled,
      scheduleOffset,
      scheduleKind: !rescheduled ? "ON_DUE" : scheduleOffset < 0 ? "EARLY" : scheduleOffset > 0 ? "DEFERRED" : "ON_DUE",

      daysLeft,
      dueStatus: daysLeft > 0 ? DUE_FILTER.NOT_DUE : daysLeft === 0 ? DUE_FILTER.DUE : DUE_FILTER.OVERDUE,
      payableNow: daysLeft <= 0,

      // The GRAND total as billed — what the vendor invoiced, GST included.
      // invoice.amount is only basic + extra charges.
      grossAmount: totals.grandTotal,
      // Held back on the basic at the invoice's snapshotted rate.
      tdsRate: totals.tdsRate,
      tdsAmount: totals.tdsAmount,
      // What the Billing figure is made of, and the adjustments split by
      // direction — so a screen can show the whole Net Payable working
      // without a second request.
      breakup: {
        basicAmount: totals.basicAmount,
        // Misc = the invoice's own charges + any separate misc charge.
        extraChargesTotal: totals.miscTotal,
        cgstAmount: totals.cgstAmount,
        sgstAmount: totals.sgstAmount,
        igstAmount: totals.igstAmount,
        gstAmount: totals.gstAmount,
        miscTotal: round2(
          (totals.miscTotal || 0) +
            counted.filter((a) => a.direction !== ADJUSTMENT_DIRECTION.DEDUCT).reduce((t, a) => t + (a.amount || 0), 0)
        ),
        debitTotal: round2(counted.filter((a) => a.direction === ADJUSTMENT_DIRECTION.DEDUCT).reduce((t, a) => t + (a.amount || 0), 0)),
      },
      // Negative when debit notes outweigh misc charges, which is the usual
      // case. Its own number because three teams need to see WHY payable
      // differs from the invoice, not just that it does.
      adjustmentTotal,
      payable,
      paidTotal,
      balance,

      approvalStatus,
      paymentState,
      autoPaymentState,
      stateOverridden,
      paymentOverrideReason: invoice.paymentOverrideReason || "",
      paymentOverrideByName: invoice.paymentOverrideByName || "",
      paymentOverrideAt: invoice.paymentOverrideAt || null,
      paymentClosed,
      writtenOff,

      /*
        Two things freeze the schedule, and the screen needs to say WHICH — a
        disabled option with no reason just looks broken.

        Once an invoice is payable it is sitting in the account team's queue;
        rescheduling it would pull it straight back out again. And once an
        approval has been asked for, the date has been shown to somebody who
        signed off on it.
      */
      canSchedulePayment: daysLeft > 0 && !approvalStatus,
      scheduleLockReason: approvalStatus
        ? "IN_APPROVAL"
        : daysLeft <= 0
          ? "PAYABLE"
          : null,
      /*
        What each screen may offer, decided here rather than in three different
        components. A rule re-implemented per screen is a rule that drifts, and
        every one of these is also enforced on the write path.
      */
      canEditAdjustments: !inApprovalFlow,
      // A debit note still moving (review / approval) means the amount is not
      // settled yet — nobody may ask to pay it until it is.
      debitNoteLive,
      canSendForApproval:
        !inApprovalFlow && !debitNoteLive && daysLeft <= 0 && payable > 0 && invoice.status === INVOICE_STATUS.APPROVED,
      /*
        Why a payment request cannot be made yet, so the screen can say so
        instead of the button silently not being there. First reason wins.
      */
      paymentLockReason: inApprovalFlow
        ? null
        : invoice.status !== INVOICE_STATUS.APPROVED
          ? "ITEMS_PENDING"
          : debitNoteLive
            ? "DN_IN_PROGRESS"
            : daysLeft > 0
              ? "NOT_DUE"
              : payable <= 0
                ? "NOTHING_PAYABLE"
                : null,
      // A new debit note: none already moving, and payment not yet approved.
      canRaiseDebitNote: !debitNoteLive && approvalStatus !== PAYMENT_APPROVAL_STATUS.APPROVED,
      canEnterPayment:
        approvalStatus === PAYMENT_APPROVAL_STATUS.APPROVED && !paymentClosed && balance > 0,
    };
  }

  /*
    What the Debit Note column shows for one invoice: the LATEST note and its
    status (with its last note, for the ⓘ), how many there have been, and how
    much is already approved.
  */
  static _debitNoteSummary(adjustments) {
    const dns = (adjustments || [])
      .filter((a) => a.type === ADJUSTMENT_TYPE.DEBIT_NOTE)
      .sort((a, b) => (b.dnNumber || 0) - (a.dnNumber || 0) || new Date(b.createdOn || 0) - new Date(a.createdOn || 0));
    if (!dns.length) return null;
    const latest = dns[0];
    const last = (latest.history || [])[latest.history?.length - 1] || null;
    return {
      latest: {
        _id: latest._id,
        dnNumber: latest.dnNumber,
        // No status = predates the approval chain = approved.
        status: latest.status || DEBIT_NOTE_STATUS.APPROVED,
        amount: latest.amount || 0,
        lastNote: last?.note || "",
        lastByName: last?.byName || "",
        lastAt: last?.at || latest.createdOn || null,
      },
      count: dns.length,
      approvedTotal: round2(dns.filter(countsInPayable).reduce((t, a) => t + (a.amount || 0), 0)),
    };
  }

  /*
    The shared list behind all three screens.

    Resolved and filtered in application memory rather than by the database.
    The due status depends on paymentTerms, which lives on the PURCHASE ORDER,
    not the invoice — so no single query can filter or count on it. The same
    tradeoff (and the same "volumes here are small" reasoning) as
    StockInventoryItemService.getInventoryCards and StockInvoiceService.getBoard.
  */
  static async getList(query = {}, dataAccess, moduleKey = SCOPE_MODULE_KEY) {
    const { skip, limit, page } = paginate(query);
    const { search, vendorId, approvalStatus, paymentState, payable, dateFrom, dateTo } = query;

    const filter = applyDataScope(
      { isActive: true, $or: [{ status: INVOICE_STATUS.APPROVED }, { inLedger: true }] },
      dataAccess,
      moduleKey
    );
    if (vendorId) filter.vendorId = vendorId;
    if (dateFrom || dateTo) {
      filter.invoiceDate = {};
      if (dateFrom) filter.invoiceDate.$gte = new Date(dateFrom);
      if (dateTo) filter.invoiceDate.$lte = new Date(dateTo);
    }
    /*
      approvalStatus is NOT applied here, deliberately — it is one of the three
      facet filters, and all three are applied in memory below so that each
      one's counts can be worked out with the OTHER two still in force. Doing
      it in the query would leave the approval tabs unable to count anything
      but the tab already selected.
    */
    const invoices = await StockInvoiceModel.find(filter).lean();

    const poIds = [...new Set(invoices.map((i) => String(i.poId)).filter(Boolean))];
    const pos = await StockPurchaseOrderModel.find({ _id: { $in: poIds } })
      .select("poNumber paymentTerms taxType items.quotationItemId items.gstRate")
      .lean();
    const poById = new Map(pos.map((p) => [String(p._id), p]));

    // One query for the whole page, not one per row. Fetched by invoiceId
    // only: the invoices above are already scoped, so re-scoping here would be
    // a second answer to a settled question.
    const adjustments = await StockInvoiceAdjustmentModel.find({
      invoiceId: { $in: invoices.map((i) => i._id) },
      isActive: true,
    })
      .select("invoiceId type direction amount status dnNumber history reason createdOn")
      .lean();
    const adjByInvoice = new Map();
    adjustments.forEach((adj) => {
      const key = String(adj.invoiceId);
      if (!adjByInvoice.has(key)) adjByInvoice.set(key, []);
      adjByInvoice.get(key).push(adj);
    });

    const rows = invoices.map((inv) => {
      const po = poById.get(String(inv.poId)) || null;
      return {
        _id: inv._id,
        trackingOrderId: inv.trackingOrderId,
        invoiceNumber: inv.invoiceNumber,
        invoiceDate: inv.invoiceDate,
        vendorId: inv.vendorId,
        vendorName: inv.vendorName,
        branchId: inv.branchId,
        paymentScheduleHistory: inv.paymentScheduleHistory || [],
        scheduleWindow: StockInvoicePaymentService.scheduleWindow(),
        paymentApproval: inv.paymentApproval || null,
        payments: inv.payments || [],
        invoiceFile: inv.invoiceFile || "",
        // Misc as entered (with its In bill / Note flag), for the edit form.
        extraCharges: inv.extraCharges || [],
        miscEdits: inv.miscEdits || [],
        debitNote: StockInvoicePaymentService._debitNoteSummary(adjByInvoice.get(String(inv._id)) || []),
        // Carried for the sort below: it breaks ties between invoices that
        // share an invoice date.
        createdAt: inv.createdAt || null,
        ...StockInvoicePaymentService.derivePayment(inv, po, adjByInvoice.get(String(inv._id)) || []),
      };
    });

    const searchText = String(search || "").trim().toLowerCase();
    const matchesSearch = (r) =>
      !searchText ||
      String(r.invoiceNumber || "").toLowerCase().includes(searchText) ||
      String(r.poNumber || "").toLowerCase().includes(searchText) ||
      String(r.vendorName || "").toLowerCase().includes(searchText);

    const searched = rows.filter(matchesSearch);

    /*
      Three facets, and each one's counts must be worked out with the OTHER two
      still applied.

      Counting them all against the unfiltered list is what made a tab read
      "Paid 1" while clicking it showed nothing: the one paid invoice was
      Payable Now, and the Payable Later dropdown beside it had already ruled
      that row out. A count has to answer "how many will I get if I click
      this", and it can only do that if everything not in its own group is
      already in force.
    */
    const passPayable = (r) =>
      payable === PAYABLE_FILTER.NOW ? r.payableNow
        : payable === PAYABLE_FILTER.LATER ? !r.payableNow
          : true;
    const passApproval = (r) =>
      !approvalStatus ? true
        // Not sent, and nothing stopping it being sent right now.
        : approvalStatus === "READY" ? !!r.canSendForApproval
        : approvalStatus === "NONE" ? !r.approvalStatus
          : r.approvalStatus === approvalStatus;
    const passState = (r) => !paymentState || r.paymentState === paymentState;

    // Each list holds every filter EXCEPT the group being counted.
    const forApproval = searched.filter((r) => passPayable(r) && passState(r));
    const forState = searched.filter((r) => passPayable(r) && passApproval(r));
    const forAll = searched.filter(passPayable);
    const forPayable = searched.filter((r) => passApproval(r) && passState(r));

    const countIn = (list, fn) => list.filter(fn).length;
    const counts = {
      // "All" clears both groups but keeps the dropdown — that is what the
      // button does, so that is what its number has to mean.
      ALL: forAll.length,
      // Approval-side and payment-side, shown as two independent groups on the
      // Payments screen — which is the whole reason they are two fields.
      NONE: countIn(forApproval, (r) => !r.approvalStatus),
      PENDING: countIn(forApproval, (r) => r.approvalStatus === PAYMENT_APPROVAL_STATUS.PENDING),
      APPROVED: countIn(forApproval, (r) => r.approvalStatus === PAYMENT_APPROVAL_STATUS.APPROVED),
      REJECTED: countIn(forApproval, (r) => r.approvalStatus === PAYMENT_APPROVAL_STATUS.REJECTED),
      UNPAID: countIn(forState, (r) => r.paymentState === PAYMENT_STATE.UNPAID),
      PARTIAL: countIn(forState, (r) => r.paymentState === PAYMENT_STATE.PARTIAL),
      PAID: countIn(forState, (r) => r.paymentState === PAYMENT_STATE.PAID),
      // The Payable Now / Later / All group, with the other two in force.
      PAYABLE_NOW: countIn(forPayable, (r) => r.payableNow),
      PAYABLE_LATER: countIn(forPayable, (r) => !r.payableNow),
      PAYABLE_ALL: forPayable.length,
      // Not facets — plain informational counts over what is on screen.
      // Ready to send now — a slice of NONE, counted like the other chips.
      READY: countIn(forApproval, (r) => r.canSendForApproval),
      // How many have been moved off their contractual date, either way. The
      // number a ledger reader asks for as soon as ageing looks worse than
      // they expected.
      RESCHEDULED: countIn(forAll, (r) => r.rescheduled),
    };

    const filtered = searched.filter((r) => passPayable(r) && passApproval(r) && passState(r));

    /*
      Newest invoice first.

      This used to lead with whatever was soonest due, on the reasoning that
      these are work queues. In practice people open them looking for the
      invoice they just entered, and finding it buried three rows down reads
      as a bug. Urgency has not been lost: the Payable In column still calls
      out "5 days overdue" and "Due today" on the row itself, which is where a
      reader looks for it anyway.

      Ties break on createdAt, so two invoices sharing a date show the most
      recently entered first and the order never shuffles between reloads.
    */
    filtered.sort((a, b) => {
      const byDate = new Date(b.invoiceDate) - new Date(a.invoiceDate);
      if (byDate !== 0) return byDate;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });

    return {
      data: { rows: filtered.slice(skip, skip + limit), counts },
      total: filtered.length,
      page,
      limit,
    };
  }

  /*
    Decide when this invoice becomes payable, instead of on its due date.

    `onDueDate: true` clears the override and puts it back on the contract —
    without that there would be no way to undo a schedule, only to keep moving
    it, and "actually, pay it when it falls due" is a real instruction.

    Refused once the invoice is payable: it is already in the account team's
    queue, and rescheduling would quietly take it back off their list. Refused
    once an approval exists, for the same reason one step later.

    Every change is kept — this field decides when money leaves.
  */
  static async schedulePayment(id, payload, actor, session, dataAccess) {
    const { scheduledOn, onDueDate } = payload || {};
    const invoice = await StockInvoicePaymentService._loadScopedInvoice(
      id, dataAccess, SCOPE_MODULE_KEY, session
    );

    if (invoice.paymentApprovalStatus) {
      throw new Error(
        "This invoice has already been sent for payment approval — its payment schedule can no longer be changed"
      );
    }

    // Checked against where it stands NOW, not against the date being proposed.
    const current = await StockInvoicePaymentService._payableNow(invoice, session);
    if (current.daysLeft <= 0) {
      throw new Error("This invoice is already payable — its payment schedule can no longer be changed");
    }

    const previous = current.scheduledOn;
    let next;

    if (onDueDate) {
      next = current.dueDate;
      if (!invoice.paymentScheduledOn) return invoice; // already on the due date
    } else {
      next = startOfDay(scheduledOn);
      if (Number.isNaN(next.getTime())) throw new Error("Invalid schedule date");

      const { min } = StockInvoicePaymentService.scheduleWindow();
      if (next < min) {
        throw new Error(`A payment can only be scheduled for today or later (from ${min.toDateString()})`);
      }
      if (dayDiff(next, previous) === 0) return invoice; // nothing moved
    }

    const before = invoice.toObject();

    invoice.paymentScheduleHistory.push({
      from: previous,
      to: next,
      by: actor?.id || actor?._id || null,
      byName: actor?.name || "",
      at: new Date(),
    });
    // Null, not the due date itself: "nobody has scheduled this" and "somebody
    // chose the due date" look the same on screen but are different facts, and
    // the history is what tells them apart.
    invoice.paymentScheduledOn = onDueDate ? null : next;
    await invoice.save({ session });

    const offset = dayDiff(next, current.dueDate);
    const how = onDueDate
      ? "back to its due date"
      : offset < 0
        ? `${Math.abs(offset)} days before its due date`
        : `${offset} days after its due date`;

    log.info(`Invoice ${invoice.invoiceNumber} scheduled for ${next.toDateString()} (${how})`);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: invoice._id, action: "SCHEDULE_PAYMENT",
      actor, before, after: invoice.toObject(),
      reason: `Payment moved from ${startOfDay(previous).toDateString()} to ${next.toDateString()} — ${how}`,
    });
    return invoice;
  }

  /* -------------------------------------------------------------------- */
  /* Adjustments — debit notes and misc charges                           */
  /* -------------------------------------------------------------------- */

  /*
    Loads an invoice for a payment-side read or write, through whichever module
    is asking. Scope lives on the INVOICE, so every adjustment goes through
    here and there is only ever one answer to "may this person touch this".
  */
  static async _loadScopedInvoice(id, dataAccess, moduleKey, session) {
    const invoice = await StockInvoiceModel.findOne({ _id: id, isActive: true }).session(session ?? null);
    if (!invoice) throw new Error("Invoice not found");
    if (!isWithinDataScope(invoice, dataAccess, moduleKey)) throw new Error("Invoice not found");
    if (invoice.status !== INVOICE_STATUS.APPROVED && !invoice.inLedger) {
      throw new Error("Only an approved invoice has a payment side");
    }
    return invoice;
  }

  static async _adjustmentsFor(invoiceId, session) {
    return StockInvoiceAdjustmentModel.find({ invoiceId, isActive: true })
      .sort({ createdAt: -1 })
      .session(session ?? null)
      .lean();
  }

  // The payable as it stands, for the guards that need it mid-transaction.
  static async _payableNow(invoice, session, excludeAdjustmentId = null) {
    const po = invoice.poId
      ? await StockPurchaseOrderModel.findOne({ _id: invoice.poId }).session(session ?? null).lean()
      : null;
    let adjustments = await StockInvoicePaymentService._adjustmentsFor(invoice._id, session);
    if (excludeAdjustmentId) {
      adjustments = adjustments.filter((a) => String(a._id) !== String(excludeAdjustmentId));
    }
    return StockInvoicePaymentService.derivePayment(invoice, po, adjustments);
  }

  /*
    What a debit note may be claimed against: the units this invoice brought
    in, that are STILL here to be written off.

    Only APPROVED items still AVAILABLE in the invoice's own branch qualify. A
    unit already transferred out, assigned, scrapped or previously debited
    cannot be marked DEBITED by this invoice — money and stock would stop
    agreeing, which is the whole reason DEBITED exists. Blocked units are still
    RETURNED, each with a reason, so the screen can grey them out and say why
    instead of silently omitting stock the user can see elsewhere.

    `excludeAdjustmentId` is what makes EDITING possible: the note being edited
    must not count its own claims as "already taken", or every unit it already
    holds would come back blocked.
  */
  static async getDebitNoteItems(invoiceId, dataAccess, moduleKey = SCOPE_MODULE_KEY, excludeAdjustmentId = null) {
    const invoice = await StockInvoicePaymentService._loadScopedInvoice(invoiceId, dataAccess, moduleKey);

    /*
      The GST slab each line was billed at. It lives on the PURCHASE ORDER, not
      the invoice — the invoice line only snapshots the basic unitPrice — so a
      debit note has to reach back here for it. Without the slab the note
      would debit basic only and under-settle by the whole tax.
    */
    const po = invoice.poId
      ? await StockPurchaseOrderModel.findOne({ _id: invoice.poId })
          .select("taxType items.quotationItemId items.gstRate")
          .lean()
      : null;
    const gstRateByLine = new Map(
      (po?.items || []).map((it) => [String(it.quotationItemId), it.gstRate || 0])
    );

    const defIds = [...new Set((invoice.lines || []).map((l) => String(l.productDefinitionId)))];
    const defs = await StockProductDefinitionModel.find({ _id: { $in: defIds } })
      .select("name trackingMethod unit selectedFields")
      .populate("selectedFields.fieldDefId", "code label")
      .lean();
    const defById = new Map(defs.map((d) => [String(d._id), d]));

    const items = await StockInventoryItemModel.find({ invoiceId: invoice._id, isActive: true })
      .select("productDefinitionId status approvalStatus branchId fieldValues quantity isFoc lock")
      .lean();

    // Claimed by some OTHER live debit note on this invoice. Offering the
    // same unit twice would let one faulty piece be debited on two notes.
    const claimedUnits = new Set();
    const claimedQtyByLine = new Map();
    const mineByLine = new Map();
    const existing = await StockInvoiceAdjustmentModel.find({
      invoiceId: invoice._id,
      type: ADJUSTMENT_TYPE.DEBIT_NOTE,
      isActive: true,
      // A rejected or withdrawn note gave its units back.
      status: { $nin: DEBIT_NOTE_RELEASED_STATUSES },
    })
      .select("lines")
      .lean();

    existing.forEach((adj) => {
      const isMine = excludeAdjustmentId && String(adj._id) === String(excludeAdjustmentId);
      (adj.lines || []).forEach((l) => {
        const key = String(l.quotationItemId);
        if (isMine) {
          // Fed back to the screen so an edit opens with its own picks ticked.
          if (!mineByLine.has(key)) mineByLine.set(key, { units: [], quantity: 0 });
          const mine = mineByLine.get(key);
          (l.inventoryItemIds || []).forEach((id) => mine.units.push(String(id)));
          if (!(l.inventoryItemIds || []).length) mine.quantity += l.quantity || 0;
          return;
        }
        (l.inventoryItemIds || []).forEach((id) => claimedUnits.add(String(id)));
        if (!(l.inventoryItemIds || []).length) {
          claimedQtyByLine.set(key, (claimedQtyByLine.get(key) || 0) + (l.quantity || 0));
        }
      });
    });

    const lines = (invoice.lines || []).map((line) => {
      const def = defById.get(String(line.productDefinitionId)) || null;
      const isIndividual = def?.trackingMethod === TRACKING_METHODS.INDIVIDUAL;
      const key = String(line.quotationItemId);
      const mine = mineByLine.get(key) || { units: [], quantity: 0 };
      const mineUnits = new Set(mine.units);

      const fields = (def?.selectedFields || [])
        .map((sf) => sf.fieldDefId)
        .filter(Boolean)
        .map((fd) => ({ code: fd.code, label: fd.label }));

      const lineItems = items.filter(
        (it) => String(it.productDefinitionId) === String(line.productDefinitionId)
      );

      // Why a unit cannot be picked, in the order the reasons matter. A unit
      // this very note already holds is DEBITED but still selectable — it is
      // being re-decided, not claimed afresh.
      const blockReason = (it) => {
        if (mineUnits.has(String(it._id))) return null;
        if (it.approvalStatus !== ITEM_APPROVAL_STATUS.APPROVED) return "not approved yet";
        if (String(it.branchId) !== String(invoice.branchId)) return "moved to another branch";
        if (it.status === ITEM_STATUS.DEBITED) return "already debited";
        if (it.lock) return `on pending Lost entry ${it.lock.refNumber}`;
        if (it.status !== ITEM_STATUS.AVAILABLE) return String(it.status).toLowerCase().replace(/_/g, " ");
        if (claimedUnits.has(String(it._id))) return "on another debit note";
        return null;
      };

      const freeQty = lineItems
        .filter((it) => !blockReason(it))
        .reduce((s, it) => s + (it.quantity || 0), 0);

      return {
        quotationItemId: line.quotationItemId,
        productDefinitionId: line.productDefinitionId,
        productName: line.productName,
        trackingMethod: def?.trackingMethod || "quantity",
        unit: def?.unit || null,
        rate: line.unitPrice || 0,
        gstRate: gstRateByLine.get(key) || 0,
        receivedQuantity: line.receivedQuantity || 0,
        focQuantity: line.focQuantity || 0,
        fields,
        // What the note being edited already holds, so the form opens filled in.
        selectedUnitIds: mine.units,
        selectedQuantity: mine.quantity,
        units: isIndividual
          ? lineItems.map((it) => ({
              _id: it._id,
              isFoc: !!it.isFoc,
              fieldValues: it.fieldValues || {},
              blockReason: blockReason(it),
            }))
          : [],
        // Group: how much of this line is still debitable, after what OTHER
        // notes have claimed. This note's own quantity is added back in.
        debitableQuantity: isIndividual
          ? lineItems.filter((it) => !blockReason(it)).length
          : Math.max(0, round2(freeQty + mine.quantity - (claimedQtyByLine.get(key) || 0))),
      };
    });

    return { invoiceNumber: invoice.invoiceNumber, invoiceDate: invoice.invoiceDate, lines };
  }

  /*
    Turns what was picked into priced, validated lines.

    Every amount is recomputed here. The client sends what was PICKED, never
    what it adds up to — a total taken on trust is a total that can be edited
    in the browser.
  */
  static async _resolveDebitLines(invoiceId, lines, dataAccess, moduleKey, excludeAdjustmentId) {
    const debitable = await StockInvoicePaymentService.getDebitNoteItems(
      invoiceId, dataAccess, moduleKey, excludeAdjustmentId
    );
    const byLine = new Map(debitable.lines.map((l) => [String(l.quotationItemId), l]));

    return (lines || [])
      .map((sent) => {
        const src = byLine.get(String(sent.quotationItemId));
        if (!src) throw new Error("A selected product does not belong to this invoice");

        if (src.trackingMethod === TRACKING_METHODS.INDIVIDUAL) {
          const wanted = [...new Set((sent.inventoryItemIds || []).map(String))];
          if (!wanted.length) return null;
          const allowed = new Set(src.units.filter((u) => !u.blockReason).map((u) => String(u._id)));
          const bad = wanted.filter((id) => !allowed.has(id));
          if (bad.length) {
            throw new Error(
              src.productName + ": " + bad.length + " selected unit" +
                (bad.length > 1 ? "s are" : " is") + " no longer available to debit"
            );
          }
          return debitLine(src, wanted.length, wanted);
        }

        const qty = Math.max(0, Number(sent.quantity) || 0);
        if (!qty) return null;
        if (qty > src.debitableQuantity) {
          throw new Error(
            src.productName + ": only " + src.debitableQuantity + " " +
              (src.unit || "unit") + " can still be debited"
          );
        }
        return debitLine(src, qty, []);
      })
      .filter(Boolean);
  }

  // Free rows, cleaned and totalled. They carry no GST: an ad-hoc discount or
  // claim is not a supply, so no slab belongs to it.
  static _resolveExtras(extras) {
    const rows = (extras || [])
      .filter((e) => Number(e?.amount) > 0)
      .map((e) => ({ note: String(e.note || "").trim(), amount: round2(Number(e.amount)) }));
    return { rows, total: round2(rows.reduce((s, e) => s + e.amount, 0)) };
  }

  /*
    Raise an adjustment. Created by accounts, in force immediately.

    Frozen while an approval is pending or granted: by then the payable has
    been quoted to the approval team, and changing it underneath them is
    exactly what this blocks. A REJECTED invoice is open again — a rejection
    usually means "the debit note is wrong, fix it".
  */
  static async createAdjustment(invoiceId, payload, actor, session, dataAccess, opts = {}) {
    const { moduleKey = SCOPE_MODULE_KEY } = opts;
    const { type, lines = [], extras = [], reason } = payload || {};

    const invoice = await StockInvoicePaymentService._loadScopedInvoice(
      invoiceId, dataAccess, moduleKey, session
    );
    StockInvoicePaymentService._assertAdjustable(invoice);

    // Debit notes have their own chain now — raised from the Invoice List.
    if (type === ADJUSTMENT_TYPE.DEBIT_NOTE) {
      throw new Error("Debit notes are raised from the Invoice List and go through review and approval");
    }
    // Misc lives on the invoice itself now (its extra charges).
    if (type === ADJUSTMENT_TYPE.MISC) {
      throw new Error("Misc is the invoice's extra charges — edit it with Misc on the Payments screen");
    }
    const isDebitNote = false;
    const direction = ADJUSTMENT_DIRECTION.ADD;

    const { rows: extraRows, total: extrasAmount } = StockInvoicePaymentService._resolveExtras(extras);
    const resolvedLines = isDebitNote
      ? await StockInvoicePaymentService._resolveDebitLines(invoiceId, lines, dataAccess, moduleKey, null)
      : [];

    const itemsBasicAmount = round2(resolvedLines.reduce((s, l) => s + l.basicAmount, 0));
    const itemsGstAmount = round2(resolvedLines.reduce((s, l) => s + l.gstAmount, 0));
    const itemsAmount = round2(itemsBasicAmount + itemsGstAmount);
    const amount = round2(itemsAmount + extrasAmount);
    if (amount <= 0) throw new Error("An adjustment needs at least one item or one amount row");

    if (direction === ADJUSTMENT_DIRECTION.DEDUCT) {
      await StockInvoicePaymentService._assertWithinPayable(invoice, amount, session, null);
    }

    const now = new Date();
    const [adjustment] = await StockInvoiceAdjustmentModel.create(
      [
        {
          invoiceId: invoice._id,
          invoiceNumber: invoice.invoiceNumber,
          vendorId: invoice.vendorId,
          vendorName: invoice.vendorName,
          branchId: invoice.branchId,
          type,
          direction,
          lines: resolvedLines,
          extras: extraRows,
          itemsBasicAmount,
          itemsGstAmount,
          itemsAmount,
          extrasAmount,
          amount,
          reason: String(reason || "").trim(),
          createdByName: actor?.name || "",
          createdOn: now,
        },
      ],
      { session }
    );

    // The stock side happens NOW, in this same transaction — never as a second
    // step somebody could miss.
    if (isDebitNote) {
      await StockInvoicePaymentService._applyDebitNoteToStock(adjustment, session);
    }

    log.info(`${type} of ${amount} raised on invoice ${invoice.invoiceNumber}`);
    await StockAuditLogService.recordAudit({
      entityType: ADJUSTMENT_ENTITY_TYPE, entityId: adjustment._id, action: "CREATE",
      actor, before: null, after: adjustment.toObject(),
      reason: String(reason || "").trim(),
    });
    return adjustment;
  }

  /*
    Edit an adjustment — REVERSE the old one, then APPLY the new one, in one
    transaction.

    Not a diff. Working out "which units were added, which removed, which group
    quantity moved which way" is seven separate branches, and the one that gets
    forgotten leaves stock quietly wrong for months. Undo-then-reapply needs
    only two operations, and APPLY is the very same code a brand-new note runs
    — so editing is exercised by every create, and a bug in one is a bug in
    both, fixed in one place.

    Because both halves are inside one transaction, the half-undone state
    between them is never visible, and a failure in APPLY rolls the UNDO back
    with it.
  */
  static async updateAdjustment(adjustmentId, payload, actor, session, dataAccess, moduleKey) {
    const { lines = [], extras = [], reason, editReason } = payload || {};

    const adjustment = await StockInvoiceAdjustmentModel.findOne({
      _id: adjustmentId,
      isActive: true,
    }).session(session);
    if (!adjustment) throw new Error("Adjustment not found");

    const invoice = await StockInvoicePaymentService._loadScopedInvoice(
      adjustment.invoiceId, dataAccess, moduleKey, session
    );
    StockInvoicePaymentService._assertAdjustable(invoice);

    if (adjustment.type === ADJUSTMENT_TYPE.DEBIT_NOTE) {
      throw new Error("A debit note is changed by whoever raised it, from the Invoice List");
    }
    const before = adjustment.toObject();
    const fromAmount = adjustment.amount;
    const isDebitNote = false;

    // 1 ── UNDO. Refuses if the stock has moved on since, because putting a
    //      scrapped unit back on the shelf would be a lie.
    if (isDebitNote) {
      await StockInvoicePaymentService._reverseDebitNoteFromStock(adjustment, session);
    }

    // 2 ── Re-price from what was picked. Excluding this note's own claims is
    //      what lets it keep the units it already had.
    const { rows: extraRows, total: extrasAmount } = StockInvoicePaymentService._resolveExtras(extras);
    const resolvedLines = isDebitNote
      ? await StockInvoicePaymentService._resolveDebitLines(
          adjustment.invoiceId, lines, dataAccess, moduleKey, adjustment._id
        )
      : [];

    const itemsBasicAmount = round2(resolvedLines.reduce((s, l) => s + l.basicAmount, 0));
    const itemsGstAmount = round2(resolvedLines.reduce((s, l) => s + l.gstAmount, 0));
    const itemsAmount = round2(itemsBasicAmount + itemsGstAmount);
    const amount = round2(itemsAmount + extrasAmount);
    if (amount <= 0) throw new Error("An adjustment needs at least one item or one amount row");

    if (adjustment.direction === ADJUSTMENT_DIRECTION.DEDUCT) {
      await StockInvoicePaymentService._assertWithinPayable(invoice, amount, session, adjustment._id);
    }

    adjustment.lines = resolvedLines;
    adjustment.extras = extraRows;
    adjustment.itemsBasicAmount = itemsBasicAmount;
    adjustment.itemsGstAmount = itemsGstAmount;
    adjustment.itemsAmount = itemsAmount;
    adjustment.extrasAmount = extrasAmount;
    adjustment.amount = amount;
    if (reason !== undefined) adjustment.reason = String(reason || "").trim();
    adjustment.edits.push({
      fromAmount,
      toAmount: amount,
      reason: String(editReason || "").trim(),
      by: actor?.id || actor?._id || null,
      byName: actor?.name || "",
      at: new Date(),
    });
    await adjustment.save({ session });

    // 3 ── APPLY, exactly as a new note would.
    if (isDebitNote) {
      await StockInvoicePaymentService._applyDebitNoteToStock(adjustment, session);
    }

    log.info(`Adjustment ${adjustment._id} edited: ${fromAmount} -> ${amount}`);
    await StockAuditLogService.recordAudit({
      entityType: ADJUSTMENT_ENTITY_TYPE, entityId: adjustment._id, action: "UPDATE",
      actor, before, after: adjustment.toObject(),
      reason: String(editReason || "").trim(),
    });
    return adjustment;
  }

  /*
    Withdraw an adjustment.

    Deleting IS the undo, on its own — which is the other reason undo-then-
    reapply was worth building: this method is short because the hard part
    already exists.
  */
  static async deleteAdjustment(adjustmentId, payload, actor, session, dataAccess, moduleKey) {
    const adjustment = await StockInvoiceAdjustmentModel.findOne({
      _id: adjustmentId,
      isActive: true,
    }).session(session);
    if (!adjustment) throw new Error("Adjustment not found");

    const invoice = await StockInvoicePaymentService._loadScopedInvoice(
      adjustment.invoiceId, dataAccess, moduleKey, session
    );
    StockInvoicePaymentService._assertAdjustable(invoice);

    if (adjustment.type === ADJUSTMENT_TYPE.DEBIT_NOTE) {
      throw new Error("A debit note is withdrawn by whoever raised it, from the Invoice List");
    }
    const before = adjustment.toObject();

    // Soft, like everything else here: what was debited and then withdrawn is
    // a question somebody will ask.
    adjustment.isActive = false;
    adjustment.deletedAt = new Date();
    adjustment.deletedByName = actor?.name || "";
    adjustment.deletedReason = String(payload?.reason || "").trim();
    await adjustment.save({ session });

    log.info(`Adjustment ${adjustment._id} withdrawn from invoice ${invoice.invoiceNumber}`);
    await StockAuditLogService.recordAudit({
      entityType: ADJUSTMENT_ENTITY_TYPE, entityId: adjustment._id, action: "DELETE",
      actor, before, after: adjustment.toObject(),
      reason: String(payload?.reason || "").trim(),
    });
    return adjustment;
  }

  // Adjustments are frozen while an approval is open or granted. Stated once
  // so create, update and delete cannot drift apart on it.
  static _assertAdjustable(invoice) {
    const s = invoice.paymentApprovalStatus;
    if (s === PAYMENT_APPROVAL_STATUS.PENDING) {
      throw new Error("This invoice is waiting on payment approval — adjustments cannot be changed until it is decided");
    }
    if (s === PAYMENT_APPROVAL_STATUS.APPROVED) {
      throw new Error("This invoice has already been approved for payment — adjustments can no longer be changed");
    }
  }

  /*
    A deduction may not exceed what is left payable.

    Allowing it would mean a negative payable — the vendor owing US — and
    recovering money from a vendor is a separate process that does not exist
    here. Re-checked on every write, not only on create, because other
    adjustments may have landed in between.
  */
  static async _assertWithinPayable(invoice, amount, session, excludeAdjustmentId) {
    const { payable } = await StockInvoicePaymentService._payableNow(invoice, session, excludeAdjustmentId);
    if (amount > payable) {
      throw new Error(
        "A debit note cannot exceed the payable amount (" + payable + "). Reduce the claim or split it."
      );
    }
  }

  /*
    The stock half of a debit note.

    Individual units named on the note become DEBITED. A group line has no
    per-unit identity, so the quantity comes off its batch documents instead,
    oldest first — and exactly which batch gave how much is RECORDED on the
    line, because undoing later has to put it back where it came from.

    A batch reduced to nothing is kept and marked DEBITED rather than deleted:
    deleting it would erase the fact that those units were ever received.
  */
  static async _applyDebitNoteToStock(adjustment, session) {
    for (const line of adjustment.lines || []) {
      if ((line.inventoryItemIds || []).length) {
        // A unit held by a pending Lost Items entry is not this note's to take.
        const locked = await StockInventoryItemModel.findOne({ _id: { $in: line.inventoryItemIds }, lock: { $ne: null } }).select("lock").session(session).lean();
        if (locked) throw new Error(`Invalid: a unit on this debit note is on pending Lost entry ${locked.lock.refNumber} — decide that entry first`);
        await StockInventoryItemModel.updateMany(
          { _id: { $in: line.inventoryItemIds } },
          { $set: { status: ITEM_STATUS.DEBITED } },
          { session }
        );
        continue;
      }

      let remaining = line.quantity || 0;
      if (remaining <= 0) continue;

      const batches = await StockInventoryItemModel.find({
        invoiceId: adjustment.invoiceId,
        productDefinitionId: line.productDefinitionId,
        status: ITEM_STATUS.AVAILABLE,
        isActive: true,
      })
        .sort({ receivedAt: 1, createdAt: 1 })
        .session(session);

      const draws = [];
      for (const batch of batches) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, batch.quantity || 0);
        if (take <= 0) continue;
        batch.quantity = round2((batch.quantity || 0) - take);
        const zeroedOut = batch.quantity === 0;
        if (zeroedOut) batch.status = ITEM_STATUS.DEBITED;
        await batch.save({ session });
        draws.push({ inventoryItemId: batch._id, quantity: take, zeroedOut });
        remaining = round2(remaining - take);
      }

      // Stock moved between the form being filled and this running. Throwing
      // aborts the transaction, so nothing is half-applied.
      if (remaining > 0) {
        throw new Error(
          line.productName + ": only part of the debited quantity is still in stock — refresh and raise it again"
        );
      }
      line.batchDraws = draws;
    }

    // The draws are part of the record, not a working note — without them the
    // next edit could not undo this one honestly.
    await adjustment.save({ session });
  }

  /*
    Undo the stock half of a debit note.

    The mirror of _applyDebitNoteToStock, and the reason an edit does not need
    to work out a diff.

    It refuses rather than guesses. A unit this note marked DEBITED that is now
    SCRAPPED was thrown away by somebody: putting it back as AVAILABLE would
    invent stock that does not exist. Better to stop and say so than to leave a
    warehouse count that can never be reconciled.
  */
  static async _reverseDebitNoteFromStock(adjustment, session) {
    for (const line of adjustment.lines || []) {
      const unitIds = line.inventoryItemIds || [];
      if (unitIds.length) {
        const units = await StockInventoryItemModel.find({ _id: { $in: unitIds } }).session(session);
        const moved = units.filter((u) => u.status !== ITEM_STATUS.DEBITED);
        if (moved.length) {
          throw new Error(
            line.productName + ": " + moved.length + " debited unit" +
              (moved.length > 1 ? "s have" : " has") +
              " since been changed to " + [...new Set(moved.map((u) => u.status))].join(", ") +
              " — this debit note can no longer be edited. Withdraw it and raise a new one."
          );
        }
        await StockInventoryItemModel.updateMany(
          { _id: { $in: unitIds } },
          { $set: { status: ITEM_STATUS.AVAILABLE } },
          { session }
        );
        continue;
      }

      for (const draw of line.batchDraws || []) {
        const batch = await StockInventoryItemModel.findOne({ _id: draw.inventoryItemId }).session(session);
        if (!batch) {
          throw new Error(
            line.productName + ": the batch this debit note drew from no longer exists — withdraw it and raise a new one."
          );
        }
        batch.quantity = round2((batch.quantity || 0) + (draw.quantity || 0));
        // Only a batch THIS note emptied goes back to available; one that was
        // already debited by another note stays as it is.
        if (draw.zeroedOut && batch.status === ITEM_STATUS.DEBITED) {
          batch.status = ITEM_STATUS.AVAILABLE;
        }
        await batch.save({ session });
      }
      line.batchDraws = [];
    }
  }

  // Everything live on one invoice, newest first.
  static async listAdjustments(invoiceId, dataAccess, moduleKey = SCOPE_MODULE_KEY) {
    await StockInvoicePaymentService._loadScopedInvoice(invoiceId, dataAccess, moduleKey);
    return StockInvoicePaymentService._adjustmentsFor(invoiceId);
  }

  /* -------------------------------------------------------------------- */
  /* Debit note chain                                                      */
  /*   raised (Invoice List) → reviewed (Payments) → decided (Approvals)    */
  /* -------------------------------------------------------------------- */

  // One step of a debit note's life, appended to its history.
  static _dnStep(adjustment, actor, action, note = "", fromAmount = null, toAmount = null) {
    adjustment.history.push({
      at: new Date(),
      by: actor?.id || actor?._id || null,
      byName: actor?.name || "",
      action,
      note: String(note || "").trim(),
      fromAmount,
      toAmount,
    });
  }

  // The debit note still moving on this invoice, if any. Only one at a time.
  static async _liveDebitNote(invoiceId, session) {
    return StockInvoiceAdjustmentModel.findOne({
      invoiceId,
      type: ADJUSTMENT_TYPE.DEBIT_NOTE,
      isActive: true,
      status: { $in: DEBIT_NOTE_LIVE_STATUSES },
    }).session(session ?? null);
  }

  static async _loadDebitNote(dnId, session) {
    const dn = await StockInvoiceAdjustmentModel.findOne({
      _id: dnId,
      type: ADJUSTMENT_TYPE.DEBIT_NOTE,
      isActive: true,
    }).session(session ?? null);
    if (!dn) throw new Error("Debit note not found");
    return dn;
  }

  /*
    Picked units/quantities and free rows → priced lines and totals. The client
    sends what was PICKED; every amount is worked out here.
  */
  static async _priceDebitNote(invoiceId, payload, dataAccess, moduleKey, excludeId) {
    const { rows: extraRows, total: extrasAmount } = StockInvoicePaymentService._resolveExtras(payload?.extras);
    const lines = await StockInvoicePaymentService._resolveDebitLines(
      invoiceId, payload?.lines || [], dataAccess, moduleKey, excludeId
    );
    const itemsBasicAmount = round2(lines.reduce((s, l) => s + l.basicAmount, 0));
    const itemsGstAmount = round2(lines.reduce((s, l) => s + l.gstAmount, 0));
    const itemsAmount = round2(itemsBasicAmount + itemsGstAmount);
    const amount = round2(itemsAmount + extrasAmount);
    if (amount <= 0) throw new Error("A debit note needs at least one item or one amount row");
    return { lines, extras: extraRows, itemsBasicAmount, itemsGstAmount, itemsAmount, extrasAmount, amount };
  }

  /*
    A waiting payment request is pulled back when a new debit note lands, so
    nobody approves a number that is about to move. Status goes back to "not
    requested", with the reason kept for the Payments screen.
  */
  static async _pullBackPaymentRequest(invoice, note, actor, session) {
    if (invoice.paymentApprovalStatus !== PAYMENT_APPROVAL_STATUS.PENDING) return;
    const before = invoice.toObject();
    invoice.paymentApprovalStatus = null;
    invoice.paymentApproval = {
      ...(invoice.paymentApproval?.toObject?.() || invoice.paymentApproval || {}),
      pulledBackAt: new Date(),
      pulledBackNote: note,
    };
    await invoice.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: invoice._id, action: "PULL_BACK_PAYMENT_APPROVAL",
      actor, before, after: invoice.toObject(), reason: note,
    });
  }

  // Raised by the stock side from the Invoice List → Review Pending.
  static async raiseDebitNote(invoiceId, payload, actor, session, dataAccess, moduleKey) {
    const invoice = await StockInvoicePaymentService._loadScopedInvoice(invoiceId, dataAccess, moduleKey, session);
    if (invoice.paymentApprovalStatus === PAYMENT_APPROVAL_STATUS.APPROVED) {
      throw new Error("This invoice is already approved for payment — a debit note can no longer be raised");
    }
    const live = await StockInvoicePaymentService._liveDebitNote(invoice._id, session);
    if (live) {
      throw new Error(`DN-${live.dnNumber} on this invoice is still in progress — one debit note at a time`);
    }

    const priced = await StockInvoicePaymentService._priceDebitNote(invoiceId, payload, dataAccess, moduleKey, null);
    await StockInvoicePaymentService._assertWithinPayable(invoice, priced.amount, session, null);

    const last = await StockInvoiceAdjustmentModel.findOne({ invoiceId: invoice._id, type: ADJUSTMENT_TYPE.DEBIT_NOTE })
      .sort({ dnNumber: -1 })
      .select("dnNumber")
      .session(session)
      .lean();
    const dnNumber = (last?.dnNumber || 0) + 1;

    const now = new Date();
    const [dn] = await StockInvoiceAdjustmentModel.create(
      [
        {
          invoiceId: invoice._id,
          invoiceNumber: invoice.invoiceNumber,
          vendorId: invoice.vendorId,
          vendorName: invoice.vendorName,
          branchId: invoice.branchId,
          type: ADJUSTMENT_TYPE.DEBIT_NOTE,
          direction: ADJUSTMENT_DIRECTION.DEDUCT,
          ...priced,
          reason: String(payload?.reason || "").trim(),
          status: DEBIT_NOTE_STATUS.REVIEW_PENDING,
          dnNumber,
          createdByName: actor?.name || "",
          createdOn: now,
        },
      ],
      { session }
    );
    StockInvoicePaymentService._dnStep(dn, actor, "RAISED", payload?.reason, null, priced.amount);
    await dn.save({ session });

    // The units are held now (out of stock), so nobody can move them while the
    // note is decided; a rejection or withdrawal puts them back.
    await StockInvoicePaymentService._applyDebitNoteToStock(dn, session);
    await StockInvoicePaymentService._pullBackPaymentRequest(
      invoice, `DN-${dnNumber} was raised while payment approval was pending`, actor, session
    );

    log.info(`DN-${dnNumber} (${priced.amount}) raised on invoice ${invoice.invoiceNumber}`);
    await StockAuditLogService.recordAudit({
      entityType: ADJUSTMENT_ENTITY_TYPE, entityId: dn._id, action: "RAISE_DEBIT_NOTE",
      actor, before: null, after: dn.toObject(), reason: String(payload?.reason || "").trim(),
    });
    return dn;
  }

  // Review Rejected → edited by the raiser → Review Pending again.
  static async resubmitDebitNote(dnId, payload, actor, session, dataAccess, moduleKey) {
    const dn = await StockInvoicePaymentService._loadDebitNote(dnId, session);
    if (dn.status !== DEBIT_NOTE_STATUS.REVIEW_REJECTED) {
      throw new Error("Only a debit note sent back in review can be edited and resubmitted");
    }
    const invoice = await StockInvoicePaymentService._loadScopedInvoice(dn.invoiceId, dataAccess, moduleKey, session);
    const before = dn.toObject();
    const fromAmount = dn.amount;

    // Undo the old hold, then price and hold again — the same path a new note
    // takes, so an edit can never leave stock half-moved.
    await StockInvoicePaymentService._reverseDebitNoteFromStock(dn, session);
    const priced = await StockInvoicePaymentService._priceDebitNote(dn.invoiceId, payload, dataAccess, moduleKey, dn._id);
    await StockInvoicePaymentService._assertWithinPayable(invoice, priced.amount, session, dn._id);

    Object.assign(dn, priced);
    if (payload?.reason !== undefined) dn.reason = String(payload.reason || "").trim();
    dn.status = DEBIT_NOTE_STATUS.REVIEW_PENDING;
    StockInvoicePaymentService._dnStep(dn, actor, "RESUBMITTED", payload?.editNote, fromAmount, priced.amount);
    await dn.save({ session });
    await StockInvoicePaymentService._applyDebitNoteToStock(dn, session);

    log.info(`DN-${dn.dnNumber} resubmitted on invoice ${invoice.invoiceNumber}: ${fromAmount} -> ${priced.amount}`);
    await StockAuditLogService.recordAudit({
      entityType: ADJUSTMENT_ENTITY_TYPE, entityId: dn._id, action: "RESUBMIT_DEBIT_NOTE",
      actor, before, after: dn.toObject(), reason: String(payload?.editNote || "").trim(),
    });
    return dn;
  }

  // The raiser drops it — only while it is still with review.
  static async withdrawDebitNote(dnId, payload, actor, session, dataAccess, moduleKey) {
    const dn = await StockInvoicePaymentService._loadDebitNote(dnId, session);
    if (![DEBIT_NOTE_STATUS.REVIEW_PENDING, DEBIT_NOTE_STATUS.REVIEW_REJECTED].includes(dn.status)) {
      throw new Error("A debit note can be withdrawn only while it is in review");
    }
    await StockInvoicePaymentService._loadScopedInvoice(dn.invoiceId, dataAccess, moduleKey, session);
    const before = dn.toObject();
    await StockInvoicePaymentService._reverseDebitNoteFromStock(dn, session);
    dn.status = DEBIT_NOTE_STATUS.WITHDRAWN;
    StockInvoicePaymentService._dnStep(dn, actor, "WITHDRAWN", payload?.reason);
    await dn.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ADJUSTMENT_ENTITY_TYPE, entityId: dn._id, action: "WITHDRAW_DEBIT_NOTE",
      actor, before, after: dn.toObject(), reason: String(payload?.reason || "").trim(),
    });
    return dn;
  }

  // Review (Payments): send on for approval, or reject back to the raiser.
  static async reviewDebitNote(dnId, payload, actor, session, dataAccess, moduleKey) {
    const { decision, reason } = payload || {};
    const dn = await StockInvoicePaymentService._loadDebitNote(dnId, session);
    if (dn.status !== DEBIT_NOTE_STATUS.REVIEW_PENDING) {
      throw new Error("This debit note is not waiting on review");
    }
    await StockInvoicePaymentService._loadScopedInvoice(dn.invoiceId, dataAccess, moduleKey, session);
    const sending = decision === "SEND";
    if (!sending && !String(reason || "").trim()) throw new Error("A reason is required to reject in review");

    const before = dn.toObject();
    dn.status = sending ? DEBIT_NOTE_STATUS.APPROVAL_PENDING : DEBIT_NOTE_STATUS.REVIEW_REJECTED;
    StockInvoicePaymentService._dnStep(dn, actor, sending ? "SENT_FOR_APPROVAL" : "REVIEW_REJECTED", reason);
    await dn.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ADJUSTMENT_ENTITY_TYPE, entityId: dn._id,
      action: sending ? "SEND_DEBIT_NOTE_FOR_APPROVAL" : "REJECT_DEBIT_NOTE_REVIEW",
      actor, before, after: dn.toObject(), reason: String(reason || "").trim(),
    });
    return dn;
  }

  /*
    Approval: Approved (now counts in Net Payable, units become faulty for
    good) or Approval Rejected (final — units go back to stock, nothing more
    happens; a new debit note is raised if one is still wanted).
  */
  static async decideDebitNote(dnId, payload, actor, session, dataAccess, moduleKey) {
    const { decision, reason } = payload || {};
    const dn = await StockInvoicePaymentService._loadDebitNote(dnId, session);
    if (dn.status !== DEBIT_NOTE_STATUS.APPROVAL_PENDING) {
      throw new Error("This debit note is not waiting on approval");
    }
    const invoice = await StockInvoicePaymentService._loadScopedInvoice(dn.invoiceId, dataAccess, moduleKey, session);
    const approving = decision === DEBIT_NOTE_STATUS.APPROVED;
    if (!approving && !String(reason || "").trim()) throw new Error("A reason is required to reject a debit note");

    const before = dn.toObject();
    if (approving) {
      // Other money may have moved since it was raised — never let it push the
      // payable below zero.
      await StockInvoicePaymentService._assertWithinPayable(invoice, dn.amount, session, dn._id);
      dn.status = DEBIT_NOTE_STATUS.APPROVED;
    } else {
      await StockInvoicePaymentService._reverseDebitNoteFromStock(dn, session);
      dn.status = DEBIT_NOTE_STATUS.APPROVAL_REJECTED;
    }
    StockInvoicePaymentService._dnStep(dn, actor, approving ? "APPROVED" : "APPROVAL_REJECTED", reason);
    await dn.save({ session });

    log.info(`DN-${dn.dnNumber} on ${invoice.invoiceNumber}: ${dn.status}`);
    await StockAuditLogService.recordAudit({
      entityType: ADJUSTMENT_ENTITY_TYPE, entityId: dn._id,
      action: approving ? "APPROVE_DEBIT_NOTE" : "REJECT_DEBIT_NOTE",
      actor, before, after: dn.toObject(), reason: String(reason || "").trim(),
    });
    return dn;
  }

  // Every debit note on one invoice, newest first, with full history.
  static async listDebitNotes(invoiceId, dataAccess, moduleKey) {
    await StockInvoicePaymentService._loadScopedInvoice(invoiceId, dataAccess, moduleKey);
    const rows = await StockInvoiceAdjustmentModel.find({
      invoiceId, type: ADJUSTMENT_TYPE.DEBIT_NOTE, isActive: true,
    })
      .sort({ dnNumber: -1, createdAt: -1 })
      .lean();
    return rows.map((r) => ({ ...r, status: r.status || DEBIT_NOTE_STATUS.APPROVED }));
  }

  /*
    The review queue (Payments) and the approval queue (Approvals): debit notes
    at the given statuses, on invoices the caller's module may see. Counts per
    status come back too, for the tabs.
  */
  static async getDebitNoteQueue(query = {}, dataAccess, moduleKey, statuses) {
    const { skip, limit, page } = paginate(query);
    const { search, status } = query;
    const wanted = status && statuses.includes(status) ? [status] : statuses;

    const invoices = await StockInvoiceModel.find(
      applyDataScope(
        { isActive: true, $or: [{ status: INVOICE_STATUS.APPROVED }, { inLedger: true }] },
        dataAccess,
        moduleKey
      )
    )
      .select("invoiceNumber invoiceDate vendorName poId branchId paymentApprovalStatus")
      .lean();
    const invById = new Map(invoices.map((i) => [String(i._id), i]));

    const all = await StockInvoiceAdjustmentModel.find({
      invoiceId: { $in: invoices.map((i) => i._id) },
      type: ADJUSTMENT_TYPE.DEBIT_NOTE,
      isActive: true,
      status: { $in: statuses },
    })
      .sort({ updatedAt: -1 })
      .lean();

    const poIds = [...new Set(invoices.map((i) => String(i.poId || "")).filter(Boolean))];
    const pos = await StockPurchaseOrderModel.find({ _id: { $in: poIds } }).select("poNumber").lean();
    const poNo = new Map(pos.map((p) => [String(p._id), p.poNumber]));

    const text = String(search || "").trim().toLowerCase();
    const matched = all.filter((d) => {
      if (!text) return true;
      const inv = invById.get(String(d.invoiceId)) || {};
      return [inv.invoiceNumber, inv.vendorName, poNo.get(String(inv.poId))]
        .some((v) => String(v || "").toLowerCase().includes(text));
    });

    const counts = Object.fromEntries(statuses.map((s) => [s, 0]));
    matched.forEach((d) => { counts[d.status] = (counts[d.status] || 0) + 1; });

    const rows = matched
      .filter((d) => wanted.includes(d.status))
      .map((d) => {
        const inv = invById.get(String(d.invoiceId)) || {};
        return {
          ...d,
          invoiceNumber: inv.invoiceNumber || d.invoiceNumber,
          invoiceDate: inv.invoiceDate || null,
          vendorName: inv.vendorName || d.vendorName,
          poNumber: poNo.get(String(inv.poId)) || "",
        };
      });

    return { data: { rows: rows.slice(skip, skip + limit), counts }, total: rows.length, page, limit };
  }

  /*
    Accounts change an invoice's Misc (its extra charges) — prefilled with what
    was entered with the invoice. No approval, every change recorded, frozen
    once payment has been asked for.
  */
  static async updateMisc(invoiceId, payload, actor, session, dataAccess, moduleKey) {
    const reason = String(payload?.reason || "").trim();
    if (!reason) throw new Error("A reason is required to change misc");
    const charges = (payload?.charges || [])
      .map((c) => ({
        note: String(c?.note || "").trim(),
        amount: round2(Number(c?.amount) || 0),
        includeInBilling: c?.includeInBilling !== false,
      }))
      .filter((c) => c.amount > 0);
    if (charges.some((c) => !Number.isFinite(c.amount) || c.amount < 0)) throw new Error("Misc amounts must be positive numbers");

    const invoice = await StockInvoicePaymentService._loadScopedInvoice(invoiceId, dataAccess, moduleKey, session);
    StockInvoicePaymentService._assertAdjustable(invoice);
    const before = invoice.toObject();

    const billed = (list) => round2((list || []).filter((c) => c.includeInBilling !== false).reduce((t, c) => t + (c.amount || 0), 0));
    const fromTotal = billed(invoice.extraCharges);
    const toTotal = billed(charges);

    invoice.extraCharges = charges;
    invoice.amount = StockInvoiceService._computeAmount(invoice.lines, invoice.extraCharges);
    invoice.miscEdits.push({ fromTotal, toTotal, reason, by: actor?.id || actor?._id || null, byName: actor?.name || "", at: new Date() });
    await invoice.save({ session });

    log.info(`Misc on ${invoice.invoiceNumber}: ${fromTotal} -> ${toTotal}`);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: invoice._id, action: "UPDATE_MISC",
      actor, before, after: invoice.toObject(), reason,
    });
    return invoice;
  }

  /*
    Accounts change an invoice's TDS rate by hand — a lower-deduction
    certificate, a wrong slab. No approval, but every change is recorded, and
    it is frozen once payment has been asked for, like misc charges.
  */
  static async updateTds(invoiceId, payload, actor, session, dataAccess, moduleKey) {
    const rate = Number(payload?.rate);
    const reason = String(payload?.reason || "").trim();
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error("TDS rate must be between 0 and 100");
    if (!reason) throw new Error("A reason is required to change TDS");

    const invoice = await StockInvoicePaymentService._loadScopedInvoice(invoiceId, dataAccess, moduleKey, session);
    StockInvoicePaymentService._assertAdjustable(invoice);
    const before = invoice.toObject();

    const current = invoice.tds?.toObject?.() || invoice.tds || null;
    const fromRate = current?.rate || 0;
    if (fromRate === rate) throw new Error("TDS is already " + rate + "%");

    invoice.tds = {
      rate,
      entityAlias: current?.entityAlias || invoice.entityAlias || "",
      note: current?.note || "",
      appliedAt: current?.appliedAt || new Date(),
      edits: [
        ...(current?.edits || []),
        { fromRate, toRate: rate, reason, by: actor?.id || actor?._id || null, byName: actor?.name || "", at: new Date() },
      ],
    };
    await invoice.save({ session });

    log.info(`TDS on ${invoice.invoiceNumber}: ${fromRate}% -> ${rate}%`);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: invoice._id, action: "UPDATE_TDS",
      actor, before, after: invoice.toObject(), reason,
    });
    return invoice;
  }

  /* -------------------------------------------------------------------- */
  /* Payment approval chain                                                */
  /* -------------------------------------------------------------------- */

  /*
    Accounts ask the approval team to clear a payment.

    Two conditions, both re-checked here and not merely hidden in the UI: the
    term must have run out, and the invoice must not already be in the flow.
    The payable is snapshotted onto the request, because the approval team is
    agreeing to a NUMBER and that number has to stay readable afterwards.
  */
  static async sendForPaymentApproval(id, payload, actor, session, dataAccess, moduleKey) {
    const invoice = await StockInvoicePaymentService._loadScopedInvoice(id, dataAccess, moduleKey, session);

    // A partial-submit invoice is in the ledger from its first approved
    // entry, but is paid only once every entry is approved.
    if (invoice.status !== INVOICE_STATUS.APPROVED) {
      throw new Error("Payment can be asked for only once every item on this invoice is approved");
    }

    const s = invoice.paymentApprovalStatus;
    if (s === PAYMENT_APPROVAL_STATUS.PENDING) {
      throw new Error("This invoice is already waiting on payment approval");
    }
    if (s === PAYMENT_APPROVAL_STATUS.APPROVED) {
      throw new Error("This invoice has already been approved for payment");
    }

    const derived = await StockInvoicePaymentService._payableNow(invoice, session);
    if (derived.debitNoteLive) {
      throw new Error("A debit note on this invoice is still in review or approval — settle it before asking for payment");
    }
    if (derived.daysLeft > 0) {
      throw new Error(
        "This invoice is not due yet — payment approval can be requested from " +
          derived.dueDate.toDateString()
      );
    }
    if (derived.payable <= 0) {
      throw new Error("There is nothing left payable on this invoice");
    }

    // A resend after a rejection must say what was done about it.
    const note = String(payload?.reason || "").trim();
    const wasRejected = s === PAYMENT_APPROVAL_STATUS.REJECTED;
    if (wasRejected && !note) {
      throw new Error("Write a note for the approver — what was fixed since it was sent back");
    }
    const prev = invoice.paymentApproval?.toObject?.() || invoice.paymentApproval || {};

    const before = invoice.toObject();

    invoice.paymentApprovalStatus = PAYMENT_APPROVAL_STATUS.PENDING;
    invoice.paymentApproval = {
      sentNote: note,
      previousRejectedReason: wasRejected ? prev.rejectedReason || "" : "",
      previousRejectedByName: wasRejected ? prev.reviewedByName || "" : "",
      sentBy: actor?.id || actor?._id || null,
      sentByName: actor?.name || "",
      sentAt: new Date(),
      payableAtRequest: derived.payable,
      reviewedBy: null,
      reviewedByName: "",
      reviewedAt: null,
      // Cleared so a fresh request does not carry the last rejection's words.
      rejectedReason: "",
    };
    await invoice.save({ session });

    log.info("Payment approval requested for invoice " + invoice.invoiceNumber + " (" + derived.payable + ")");
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: invoice._id, action: "REQUEST_PAYMENT_APPROVAL",
      actor, before, after: invoice.toObject(),
      reason: String(payload?.reason || "").trim(),
    });
    return invoice;
  }

  /*
    The approval team's decision.

    A rejection needs a reason; an approval does not. That asymmetry is the
    point: rejecting means "something on this is wrong", and the person who has
    to fix it cannot act on silence. Approving needs no explanation.
  */
  static async decidePaymentApproval(id, payload, actor, session, dataAccess, moduleKey) {
    const { decision, reason } = payload || {};
    const invoice = await StockInvoicePaymentService._loadScopedInvoice(id, dataAccess, moduleKey, session);

    if (invoice.paymentApprovalStatus !== PAYMENT_APPROVAL_STATUS.PENDING) {
      throw new Error("This invoice has no payment approval awaiting a decision");
    }

    const approving = decision === PAYMENT_APPROVAL_STATUS.APPROVED;
    if (!approving && !String(reason || "").trim()) {
      throw new Error("A reason is required to reject a payment approval");
    }

    const before = invoice.toObject();

    invoice.paymentApprovalStatus = approving
      ? PAYMENT_APPROVAL_STATUS.APPROVED
      : PAYMENT_APPROVAL_STATUS.REJECTED;
    invoice.paymentApproval = {
      ...(invoice.paymentApproval?.toObject?.() || invoice.paymentApproval || {}),
      reviewedBy: actor?.id || actor?._id || null,
      reviewedByName: actor?.name || "",
      reviewedAt: new Date(),
      rejectedReason: approving ? "" : String(reason || "").trim(),
    };
    await invoice.save({ session });

    log.info("Payment approval " + invoice.paymentApprovalStatus + " for invoice " + invoice.invoiceNumber);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: invoice._id,
      action: approving ? "APPROVE_PAYMENT" : "REJECT_PAYMENT",
      actor, before, after: invoice.toObject(),
      reason: String(reason || "").trim(),
    });
    return invoice;
  }

  /*
    Record money that actually left, in however many pieces it left in.

    One settlement can arrive down several routes — 30,000 by NEFT and 15,000
    by UPI on the same day — so `splits` is a list, and each one becomes its
    own payments row with its own reference and its own proof. They are two
    bank entries; pretending they are one would make the rows impossible to
    tick off against a statement.

    The approval status is NOT touched: "was this approved" and "how much is
    paid" are two questions, and paying part of an invoice must not erase the
    answer to the first.

    Uploaded proofs are deleted by the controller if anything here fails —
    multer has already written them to disk by the time this runs.
  */
  static async recordPayment(id, payload, actor, session, dataAccess, moduleKey) {
    const { paidOn, remarks, splits = [], stateOverride, overrideReason } = payload || {};
    const invoice = await StockInvoicePaymentService._loadScopedInvoice(id, dataAccess, moduleKey, session);

    if (invoice.paymentApprovalStatus !== PAYMENT_APPROVAL_STATUS.APPROVED) {
      throw new Error("A payment can only be recorded once the payment approval has been approved");
    }

    const derived = await StockInvoicePaymentService._payableNow(invoice, session);
    if (derived.paymentClosed) {
      throw new Error("This invoice is already settled — no further payment can be recorded against it");
    }

    const rows = (splits || [])
      .map((s) => ({
        amount: round2(Number(s?.amount) || 0),
        mode: s?.mode,
        refNo: String(s?.refNo || "").trim(),
        proofs: Array.isArray(s?.proofs) ? s.proofs : [],
      }))
      .filter((s) => s.amount > 0);

    if (!rows.length) throw new Error("At least one payment split with an amount is required");

    const total = round2(rows.reduce((s, r) => s + r.amount, 0));
    if (total > derived.balance) {
      throw new Error(
        "That is more than the outstanding balance (" + derived.balance + ") — enter the balance or less"
      );
    }

    const before = invoice.toObject();
    const when = new Date(paidOn);
    const now = new Date();

    rows.forEach((r) => {
      invoice.payments.push({
        amount: r.amount,
        mode: r.mode,
        paidOn: when,
        refNo: r.refNo,
        remarks: String(remarks || "").trim(),
        proofs: r.proofs,
        by: actor?.id || actor?._id || null,
        byName: actor?.name || "",
        at: now,
      });
    });

    /*
      What the amounts now say, and whether somebody is overriding it.

      An override that agrees with the arithmetic is not an override at all, so
      it is cleared rather than stored — otherwise every fully-paid invoice
      would carry a pointless "set by hand" mark. One that disagrees must say
      why: closing an invoice 1,000 short is a decision somebody has to own.
    */
    const paidTotal = round2(invoice.payments.reduce((s, p) => s + (p.amount || 0), 0));
    const newBalance = round2(derived.payable - paidTotal);
    const autoState =
      paidTotal <= 0 ? PAYMENT_STATE.UNPAID : newBalance > 0 ? PAYMENT_STATE.PARTIAL : PAYMENT_STATE.PAID;

    if (stateOverride && stateOverride !== autoState) {
      if (!PAYMENT_STATE_OVERRIDE_ARRAY.includes(stateOverride)) {
        throw new Error("A payment state can only be forced to Paid or Partial");
      }
      if (!String(overrideReason || "").trim()) {
        throw new Error(
          stateOverride === PAYMENT_STATE.PAID
            ? "Closing this invoice short of its payable needs a reason"
            : "Keeping this invoice open when it is fully paid needs a reason"
        );
      }
      invoice.paymentStateOverride = stateOverride;
      invoice.paymentOverrideReason = String(overrideReason).trim();
      invoice.paymentOverrideByName = actor?.name || "";
      invoice.paymentOverrideAt = now;
    } else {
      invoice.paymentStateOverride = null;
      invoice.paymentOverrideReason = "";
      invoice.paymentOverrideByName = "";
      invoice.paymentOverrideAt = null;
    }

    await invoice.save({ session });

    const finalState = invoice.paymentStateOverride || autoState;
    log.info(
      "Payment of " + total + " in " + rows.length + " split(s) recorded on invoice " +
        invoice.invoiceNumber + " (" + paidTotal + " of " + derived.payable + ", " + finalState + ")"
    );
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: invoice._id, action: "RECORD_PAYMENT",
      actor, before, after: invoice.toObject(),
      reason: invoice.paymentStateOverride
        ? finalState + " set by hand: " + invoice.paymentOverrideReason
        : String(remarks || "").trim(),
    });
    return invoice;
  }
}
