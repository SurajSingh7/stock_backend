import StockQuotationModel from "../models/stock.quotation.model.js";
import StockPurchaseOrderModel from "../models/stock.purchase.order.model.js";
import StockInvoiceModel from "../models/stock.invoice.model.js";
import StockInvoiceAdjustmentModel from "../models/stock.invoice.adjustment.model.js";
import { poPdfAbsolutePath } from "../helpers/stock.po.pdf.helper.js";
import {
  QUOTATION_STATUS,
  PO_STATUS,
  INVOICE_STATUS,
  PAYMENT_APPROVAL_STATUS,
  DEBIT_NOTE_STATUS,
  ADJUSTMENT_TYPE,
  MAIL_REACHED_VENDOR,
  TRANSFER_REQUEST_STATUS,
  TRANSFER_REQUEST_CLOSED,
  TRANSFER_EVENT,
} from "../constants/stock.enums.js";
import StockTrackingOrderModel from "../models/stock.tracking.order.model.js";
import StockLowStockNoticeModel from "../models/stock.low.stock.notice.model.js";
import StockTransferRequestModel from "../models/stock.transfer.request.model.js";

/*
  Alerts & Escalations — the event catalog.

  The ONE place that knows the business: which events exist, what a message
  about each can say ({{variables}}), where its link points, and — most
  important — what "still pending" means. Admins pick events, recipients,
  hours and wording on screen; they never define "pending", because a wrong
  answer there would either spam people about finished work or go silent on
  stuck work.

  Adding an event = one entry here + one emitAlertEvent() call where it
  happens. Nothing else changes.

  Entry shape:
    key, label, group, description
    recordType        shown in the log ("Quotation", "Purchase Order", …)
    kind              "AUTOMATIC" (rules fire) | "MANUAL" (fills a dialog)
    pendingLabel      what the escalation waits for, in words; null = this
                      event has no "pending" and allows no reminder steps
    variables         [{ key, label, sample }] — sample feeds Preview / Test
    load(id)          → the record (lean) or null
    build(doc)        → { ref, link, vars, amount, branchId, vendorIds,
                          owner, vendorId, document }
    isPending(doc)    → true while the work is not done (escalation goes on)
    noVendor          (optional) the record has no vendor to send to
    branchAccessModule (optional) module whose branch scope decides who the
                      "people with access to the branch" recipient reaches
*/

const APP_URL = () => (process.env.APP_PUBLIC_URL || "http://localhost:3000").trim().replace(/\/+$/, "");
const link = (route, search) => `${APP_URL()}${route}${search ? `?search=${encodeURIComponent(search)}` : ""}`;

const inr = (n) =>
  `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const date = (d) =>
  d ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : "";
const uniq = (arr) => [...new Set(arr.filter(Boolean).map(String))];

// Who a CREATOR recipient means for this record.
const ownerOf = (actor) =>
  actor
    ? { userId: actor.userId || null, name: actor.name || "", phone: actor.phone || "", email: actor.email || "" }
    : null;

const COMMON_VARS = [
  { key: "recordRef", label: "Record number", sample: "QT-2026-0042" },
  { key: "link", label: "Open link", sample: "http://localhost:3000/stock/quotations" },
  { key: "createdBy", label: "Created by", sample: "Ramesh Kumar" },
  { key: "createdAt", label: "Created at", sample: "22 Oct 2026, 11:30 am" },
  { key: "pendingSince", label: "Pending since", sample: "22 Oct 2026, 11:30 am" },
  { key: "pendingFor", label: "Pending for (hours)", sample: "24" },
];
const withCommon = (vars) => [...COMMON_VARS, ...vars];

// ─── Quotation ──────────────────────────────────────────────────────────────
const loadQuotation = (id) => StockQuotationModel.findOne({ _id: id, isActive: true }).lean();
const buildQuotation = (q) => {
  const items = q.items || [];
  const amount = items.reduce((s, it) => s + Number(it.lineTotal || 0), 0);
  const vendors = uniq(items.map((it) => it.vendorName));
  const rejected = (q.categoryApprovals || []).filter((c) => c.status === "REJECTED");
  return {
    ref: q.quotationNumber || "",
    // Pending → straight to the approval screen; decided → the list.
    link: link(q.status === QUOTATION_STATUS.PENDING ? "/stock/approval/quotations" : "/stock/purchase/quotations", q.quotationNumber),
    amount,
    branchId: null,
    vendorIds: uniq(items.map((it) => it.vendorId)),
    owner: ownerOf(q.createdBy),
    vars: {
      quotationNo: q.quotationNumber || "",
      vendorNames: vendors.join(", "),
      vendorCount: String(vendors.length),
      categoryCount: String((q.categoryIds || []).length),
      amount: inr(amount),
      status: q.status || "",
      rejectedCategories: rejected.map((c) => c.categoryName).join(", "),
      rejectedRemarks: rejected.map((c) => c.remarks).filter(Boolean).join("; "),
      createdBy: q.createdBy?.name || "",
      createdAt: date(q.createdAt),
    },
  };
};
const QUOTATION_VARS = [
  { key: "quotationNo", label: "Quotation number", sample: "QT-2026-0042" },
  { key: "vendorNames", label: "Vendors", sample: "ABC Traders, XYZ Infra" },
  { key: "vendorCount", label: "Vendor count", sample: "2" },
  { key: "categoryCount", label: "Category count", sample: "3" },
  { key: "amount", label: "Total amount", sample: "₹1,24,500" },
];

// ─── Purchase order ─────────────────────────────────────────────────────────
const loadPo = (id) => StockPurchaseOrderModel.findOne({ _id: id, isActive: true }).lean();
const buildPo = (po) => ({
  ref: po.poNumber || "",
  link: link("/stock/accounts/po-approval", po.poNumber),
  amount: Number(po.grandTotal || 0),
  branchId: null,
  vendorIds: uniq([po.vendorId]),
  vendorId: po.vendorId || null,
  owner: ownerOf(po.createdBy),
  document: po.pdfPath ? { fileName: `${po.poNumber}.pdf`, path: poPdfAbsolutePath(po.pdfPath) } : null,
  vars: {
    poNumber: po.poNumber || "",
    vendorName: po.vendorName || "",
    entity: po.buyerEntity?.alias || po.buyerEntity?.name || "",
    amount: inr(po.grandTotal),
    rejectedReason: po.rejectedReason || "",
    reviewedBy: po.reviewedByName || "",
    createdBy: po.createdBy?.name || "",
    createdAt: date(po.createdAt),
  },
});
const PO_VARS = [
  { key: "poNumber", label: "PO number", sample: "PO-2026-0117" },
  { key: "vendorName", label: "Vendor", sample: "ABC Traders" },
  { key: "entity", label: "Buyer entity", sample: "GTEL" },
  { key: "amount", label: "PO amount", sample: "₹86,400" },
];

// ─── Invoice ────────────────────────────────────────────────────────────────
const loadInvoice = (id) => StockInvoiceModel.findOne({ _id: id, isActive: { $ne: false } }).lean();
const buildInvoice = (inv) => {
  return {
    ref: inv.invoiceNumber || "",
    link: link("/stock/accounts/invoice-approval", inv.invoiceNumber),
    amount: Number(inv.invoiceAmount || inv.amount || 0),
    branchId: inv.branchId || null,
    vendorIds: uniq([inv.vendorId]),
    vendorId: inv.vendorId || null,
    owner: ownerOf(inv.createdBy),
    vars: {
      invoiceNumber: inv.invoiceNumber || "",
      vendorName: inv.vendorName || "",
      entity: inv.entityAlias || "",
      amount: inr(inv.invoiceAmount || inv.amount),
      invoiceDate: inv.invoiceDate ? new Date(inv.invoiceDate).toLocaleDateString("en-IN") : "",
      rejectedReason: inv.rejectedReason || "",
      createdBy: inv.createdBy?.name || inv.receivedByName || "",
      createdAt: date(inv.createdAt),
    },
  };
};
const INVOICE_VARS = [
  { key: "invoiceNumber", label: "Invoice number", sample: "INV/2026/889" },
  { key: "vendorName", label: "Vendor", sample: "ABC Traders" },
  { key: "entity", label: "Entity", sample: "GTEL" },
  { key: "amount", label: "Invoice amount", sample: "₹86,400" },
  { key: "invoiceDate", label: "Invoice date", sample: "20/10/2026" },
];
const invoiceAwaitingApproval = (inv) => inv.status === INVOICE_STATUS.PENDING;

// ─── Payment approval (lives on the invoice) ────────────────────────────────
const buildPayment = (inv) => {
  const base = buildInvoice(inv);
  const pa = inv.paymentApproval || {};
  return {
    ...base,
    link: link(
      inv.paymentApprovalStatus === PAYMENT_APPROVAL_STATUS.PENDING ? "/stock/approval/payments" : "/stock/accounts/payments",
      inv.invoiceNumber
    ),
    amount: Number(pa.payableAtRequest || base.amount),
    owner: pa.sentBy ? { userId: pa.sentBy, name: pa.sentByName || "", phone: "", email: "" } : base.owner,
    vars: {
      ...base.vars,
      payable: inr(pa.payableAtRequest),
      sentBy: pa.sentByName || "",
      sentNote: pa.sentNote || "",
      rejectedReason: pa.rejectedReason || "",
      reviewedBy: pa.reviewedByName || "",
    },
  };
};
const PAYMENT_VARS = [
  ...INVOICE_VARS,
  { key: "payable", label: "Payable sent for approval", sample: "₹82,150" },
  { key: "sentBy", label: "Sent by", sample: "Priya (Accounts)" },
  { key: "sentNote", label: "Note from accounts", sample: "TDS deducted" },
];

// ─── Debit note ─────────────────────────────────────────────────────────────
const loadDebitNote = (id) =>
  StockInvoiceAdjustmentModel.findOne({ _id: id, type: ADJUSTMENT_TYPE.DEBIT_NOTE, isActive: true }).lean();
const buildDebitNote = (dn) => {
  const last = [...(dn.history || [])].reverse().find((h) => /reject/i.test(h.action || ""));
  const ref = dn.dnNumber ? `DN-${dn.dnNumber}` : `DN · ${dn.invoiceNumber || ""}`;
  return {
    ref,
    link: link(dn.status === DEBIT_NOTE_STATUS.APPROVAL_PENDING ? "/stock/approval/payments" : "/stock/accounts/payments", dn.invoiceNumber),
    amount: Number(dn.amount || 0),
    branchId: dn.branchId || null,
    vendorIds: uniq([dn.vendorId]),
    vendorId: dn.vendorId || null,
    owner: ownerOf(dn.createdBy),
    vars: {
      debitNoteNo: ref,
      invoiceNumber: dn.invoiceNumber || "",
      vendorName: dn.vendorName || "",
      amount: inr(dn.amount),
      reason: dn.reason || "",
      rejectedReason: last?.note || "",
      createdBy: dn.createdBy?.name || dn.createdByName || "",
      createdAt: date(dn.createdAt),
    },
  };
};
const DEBIT_NOTE_VARS = [
  { key: "debitNoteNo", label: "Debit note number", sample: "DN-14" },
  { key: "invoiceNumber", label: "Invoice number", sample: "INV/2026/889" },
  { key: "vendorName", label: "Vendor", sample: "ABC Traders" },
  { key: "amount", label: "Debit amount", sample: "₹4,250" },
  { key: "reason", label: "Reason", sample: "2 units dead on arrival" },
];

const REJECTED_VAR = { key: "rejectedReason", label: "Rejection reason", sample: "Rate higher than last purchase" };

// ─── Low stock ──────────────────────────────────────────────────────────────
const LIST_MAX = 15; // a WhatsApp listing 200 products helps nobody — the page has them all
const qty = (n, unit) => `${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}${unit === "meter" ? " m" : ""}`;
export const lowStockLine = (it) =>
  it.level === "OUT"
    ? `🔴 ${it.productName} — OUT of stock (min ${qty(it.threshold, it.unit)})`
    : `🟡 ${it.productName} — ${qty(it.available, it.unit)} left (min ${qty(it.threshold, it.unit)})`;

const loadLowStockNotice = (id) => StockLowStockNoticeModel.findById(id).lean();
const buildLowStockNotice = (n) => {
  const items = n.items || [];
  // OUT first: that is the one to act on.
  const sorted = [...items].sort((a, b) => (a.level === b.level ? a.productName.localeCompare(b.productName) : a.level === "OUT" ? -1 : 1));
  const lines = sorted.slice(0, LIST_MAX).map(lowStockLine);
  if (sorted.length > LIST_MAX) lines.push(`…and ${sorted.length - LIST_MAX} more`);
  const outCount = items.filter((i) => i.level === "OUT").length;
  return {
    ref: `Low stock · ${n.branchName || "branch"}`,
    link: `${APP_URL()}/stock/inventory/products?branchId=${n.branchId}`,
    amount: 0,
    branchId: n.branchId,
    vendorIds: [],
    owner: null,
    vars: {
      branchName: n.branchName || "",
      itemCount: String(items.length),
      lowCount: String(items.length - outCount),
      outCount: String(outCount),
      itemsList: lines.join("\n"),
      createdAt: date(n.createdAt),
    },
  };
};
const LOW_STOCK_VARS = [
  { key: "branchName", label: "Branch", sample: "Noida" },
  { key: "itemCount", label: "Products in this alert", sample: "3" },
  { key: "lowCount", label: "Products low", sample: "2" },
  { key: "outCount", label: "Products out of stock", sample: "1" },
  {
    key: "itemsList",
    label: "Product list (one per line)",
    sample: "🔴 Cat6 Cable Box — OUT of stock (min 2)\n🟡 HP 680 Cartridge — 3 left (min 5)\n🟡 TP-Link Router — 2 left (min 4)",
  },
];

// ─── Stock Transfer ────────────────────────────────────────────────────────
// Every event is raised on the request and goes to the OTHER branch — the one
// that has to act or wants to know — through "People with access to the
// branch" (branchId below). The link opens that branch's page on the request.
const TRANSFER_ROUTE = "/stock/inventory/transfers";
const TRANSFER_PAGE = { requesting: "my-requests", source: "requests-to-us" };
const qtyText = (n, unit) => `${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}${unit === "meter" ? " m" : ""}`;
const linesList = (lines, name, pick) => lines.map((l) => `• ${name(l)} — ${qtyText(pick(l), l.unit)}`).join("\n");

const loadStockRequest = (id) =>
  StockTransferRequestModel.findOne({ _id: id, isActive: true })
    .populate({ path: "requestingBranchId", select: "name" })
    .populate({ path: "sourceBranchId", select: "name" })
    .populate({ path: "transferId", select: "lines.productName lines.sentQty lines.unit note sentByName receivedByName history" })
    .lean();
// branch: "requesting" (the branch that asked) | "source" (the branch asked).
const buildStockRequest = (r, branch) => {
  const t = r.transferId || {};
  const problem = [...(t.history || [])].reverse().find((h) => h.type === TRANSFER_EVENT.PROBLEM_REPORTED);
  const page = TRANSFER_REQUEST_CLOSED.includes(r.status) ? "history" : TRANSFER_PAGE[branch];
  return {
    ref: r.requestNumber || "",
    link: link(`${TRANSFER_ROUTE}/${page}`, r.requestNumber),
    amount: 0,
    branchId: branch === "source" ? r.sourceBranchId?._id : r.requestingBranchId?._id,
    vendorIds: [],
    owner: r.requestedBy ? { userId: r.requestedBy, name: r.requestedByName || "", phone: "", email: "" } : null,
    vars: {
      requestNo: r.requestNumber || "",
      requestingBranch: r.requestingBranchId?.name || "",
      sendingBranch: r.sourceBranchId?.name || "",
      itemsList: linesList(r.lines || [], (l) => l.categoryPath, (l) => l.requestedQty),
      remarks: r.remarks || "",
      reason: r.reason || "",
      declinedBy: r.processedByName || "",
      sentList: linesList(t.lines || [], (l) => l.productName, (l) => l.sentQty),
      sentBy: t.sentByName || "",
      note: t.note || "",
      problemNote: problem?.note || "",
      problemBy: problem?.byName || "",
      receivedBy: t.receivedByName || "",
      createdBy: r.requestedByName || "",
      createdAt: date(r.requestedAt || r.createdAt),
    },
  };
};
const STOCK_REQUEST_VARS = [
  { key: "requestNo", label: "Request number", sample: "SR-2026-0045" },
  { key: "requestingBranch", label: "Branch that asked", sample: "Zirakpur" },
  { key: "sendingBranch", label: "Branch asked (sends)", sample: "Azadpur" },
  { key: "itemsList", label: "Categories asked for (one per line)", sample: "• Router / Dual Band — 50\n• Cable / Cat6 — 50 m" },
  { key: "remarks", label: "Remarks", sample: "Needed for new connections" },
];
const STOCK_SENT_VARS = [
  ...STOCK_REQUEST_VARS,
  { key: "sentList", label: "Products on the way (one per line)", sample: "• TP-Link Router — 40\n• Cat6 Cable — 40 m" },
  { key: "sentBy", label: "Sent by", sample: "Ramesh Kumar" },
  { key: "note", label: "Sender's note", sample: "Sent by courier" },
];

// ─── The catalog ────────────────────────────────────────────────────────────
const EVENTS = [
  // Tier 1 — somebody has to approve
  {
    key: "QUOTATION_CREATED",
    label: "Quotation created — approval pending",
    group: "Quotation",
    recordType: "Quotation",
    kind: "AUTOMATIC",
    pendingLabel: "until every category is approved or rejected",
    variables: withCommon(QUOTATION_VARS),
    load: loadQuotation,
    build: buildQuotation,
    isPending: (q) => q.status === QUOTATION_STATUS.PENDING,
  },
  {
    key: "PO_GENERATED",
    label: "PO generated — review pending",
    group: "Purchase Order",
    recordType: "Purchase Order",
    kind: "AUTOMATIC",
    pendingLabel: "until the PO is approved or rejected",
    variables: withCommon(PO_VARS),
    load: loadPo,
    build: buildPo,
    isPending: (po) => po.status === PO_STATUS.GENERATED,
  },
  {
    key: "INVOICE_SUBMITTED",
    label: "Invoice submitted — approval pending",
    group: "Invoice",
    recordType: "Invoice",
    kind: "AUTOMATIC",
    pendingLabel: "until the submitted items are approved or rejected",
    variables: withCommon(INVOICE_VARS),
    load: loadInvoice,
    build: buildInvoice,
    isPending: invoiceAwaitingApproval,
  },
  {
    key: "PAYMENT_APPROVAL_REQUESTED",
    label: "Payment sent for approval",
    group: "Payment",
    recordType: "Payment",
    kind: "AUTOMATIC",
    pendingLabel: "until the payment is approved or rejected",
    variables: withCommon(PAYMENT_VARS),
    load: loadInvoice,
    build: buildPayment,
    isPending: (inv) => inv.paymentApprovalStatus === PAYMENT_APPROVAL_STATUS.PENDING,
  },
  {
    key: "DEBIT_NOTE_RAISED",
    label: "Debit note raised — review pending",
    group: "Debit Note",
    recordType: "Debit Note",
    kind: "AUTOMATIC",
    pendingLabel: "until Payments reviews it",
    variables: withCommon(DEBIT_NOTE_VARS),
    load: loadDebitNote,
    build: buildDebitNote,
    isPending: (dn) => dn.status === DEBIT_NOTE_STATUS.REVIEW_PENDING,
  },
  {
    key: "DEBIT_NOTE_SENT_FOR_APPROVAL",
    label: "Debit note sent for approval",
    group: "Debit Note",
    recordType: "Debit Note",
    kind: "AUTOMATIC",
    pendingLabel: "until it is approved or rejected",
    variables: withCommon(DEBIT_NOTE_VARS),
    load: loadDebitNote,
    build: buildDebitNote,
    isPending: (dn) => dn.status === DEBIT_NOTE_STATUS.APPROVAL_PENDING,
  },

  // Tier 2 — sent back to whoever made it
  {
    key: "QUOTATION_REJECTED",
    label: "Quotation rejected / partly approved",
    group: "Quotation",
    recordType: "Quotation",
    kind: "AUTOMATIC",
    // A rejected quotation is entered again as a new one — nothing to wait on.
    pendingLabel: null,
    variables: withCommon([
      ...QUOTATION_VARS,
      { key: "status", label: "Result", sample: "PARTIALLY_APPROVED" },
      { key: "rejectedCategories", label: "Rejected categories", sample: "Routers, ONT" },
      { key: "rejectedRemarks", label: "Rejection remarks", sample: "Rate too high" },
    ]),
    load: loadQuotation,
    build: buildQuotation,
    isPending: null,
  },
  {
    key: "PO_REJECTED",
    label: "PO rejected",
    group: "Purchase Order",
    recordType: "Purchase Order",
    kind: "AUTOMATIC",
    pendingLabel: "until the PO is edited and regenerated",
    variables: withCommon([...PO_VARS, REJECTED_VAR, { key: "reviewedBy", label: "Rejected by", sample: "Suresh (Head)" }]),
    load: loadPo,
    build: buildPo,
    isPending: (po) => po.status === PO_STATUS.REJECTED,
  },
  {
    key: "INVOICE_REJECTED",
    label: "Invoice rejected",
    group: "Invoice",
    recordType: "Invoice",
    kind: "AUTOMATIC",
    pendingLabel: "until it is corrected and submitted again",
    variables: withCommon([...INVOICE_VARS, REJECTED_VAR]),
    load: loadInvoice,
    build: buildInvoice,
    isPending: (inv) => inv.status === INVOICE_STATUS.REJECTED,
  },
  {
    key: "PAYMENT_APPROVAL_REJECTED",
    label: "Payment approval rejected",
    group: "Payment",
    recordType: "Payment",
    kind: "AUTOMATIC",
    pendingLabel: "until it is sent for approval again",
    variables: withCommon([...PAYMENT_VARS, REJECTED_VAR, { key: "reviewedBy", label: "Rejected by", sample: "Director" }]),
    load: loadInvoice,
    build: buildPayment,
    isPending: (inv) => inv.paymentApprovalStatus === PAYMENT_APPROVAL_STATUS.REJECTED,
  },
  {
    key: "DEBIT_NOTE_REVIEW_REJECTED",
    label: "Debit note sent back by Payments",
    group: "Debit Note",
    recordType: "Debit Note",
    kind: "AUTOMATIC",
    pendingLabel: "until it is edited and resubmitted (or withdrawn)",
    variables: withCommon([...DEBIT_NOTE_VARS, REJECTED_VAR]),
    load: loadDebitNote,
    build: buildDebitNote,
    isPending: (dn) => dn.status === DEBIT_NOTE_STATUS.REVIEW_REJECTED,
  },

  // Stock — raised by the low-stock check (stock.low.stock.service.js), one
  // record per branch per check, listing what went LOW or OUT in it.
  {
    key: "LOW_STOCK",
    label: "Stock low / out in a branch",
    group: "Stock",
    recordType: "Low Stock",
    kind: "AUTOMATIC",
    // Nothing to wait on: the morning summary lists what is still low.
    pendingLabel: null,
    noVendor: true,
    // Whoever sees a branch's stock against its thresholds (Available Product).
    branchAccessModule: "available-products",
    variables: withCommon(LOW_STOCK_VARS),
    load: loadLowStockNotice,
    build: buildLowStockNotice,
    isPending: null,
  },

  // Stock Transfer — all raised on the request (SR-…)
  {
    key: "STOCK_REQUESTED",
    label: "Stock requested by another branch",
    group: "Stock Transfer",
    recordType: "Stock Request",
    kind: "AUTOMATIC",
    pendingLabel: "until the stock is sent or the request is declined",
    noVendor: true,
    branchAccessModule: "stock-requests-to-us",
    variables: withCommon(STOCK_REQUEST_VARS),
    load: loadStockRequest,
    build: (r) => buildStockRequest(r, "source"),
    isPending: (r) => r.status === TRANSFER_REQUEST_STATUS.PENDING,
  },
  {
    key: "STOCK_REQUEST_DECLINED",
    label: "Stock request declined",
    group: "Stock Transfer",
    recordType: "Stock Request",
    kind: "AUTOMATIC",
    // A declined request is asked again as a new one — nothing to wait on.
    pendingLabel: null,
    noVendor: true,
    branchAccessModule: "my-stock-requests",
    variables: withCommon([
      ...STOCK_REQUEST_VARS,
      { key: "reason", label: "Reason", sample: "Out of stock" },
      { key: "declinedBy", label: "Declined by", sample: "Suresh (Azadpur)" },
    ]),
    load: loadStockRequest,
    build: (r) => buildStockRequest(r, "requesting"),
    isPending: null,
  },
  {
    key: "STOCK_SENT",
    label: "Stock on the way — check and receive",
    group: "Stock Transfer",
    recordType: "Stock Request",
    kind: "AUTOMATIC",
    // Raised again after every Correct & Resend.
    pendingLabel: "until the branch that asked says All Received or reports a problem",
    noVendor: true,
    branchAccessModule: "my-stock-requests",
    variables: withCommon(STOCK_SENT_VARS),
    load: loadStockRequest,
    build: (r) => buildStockRequest(r, "requesting"),
    isPending: (r) => r.status === TRANSFER_REQUEST_STATUS.ON_THE_WAY,
  },
  {
    key: "STOCK_PROBLEM_REPORTED",
    label: "Problem reported — correct and resend",
    group: "Stock Transfer",
    recordType: "Stock Request",
    kind: "AUTOMATIC",
    pendingLabel: "until the sending branch corrects and resends it",
    noVendor: true,
    branchAccessModule: "stock-requests-to-us",
    variables: withCommon([
      ...STOCK_SENT_VARS,
      { key: "problemNote", label: "What is wrong", sample: "Only 30 routers arrived, 10 missing" },
      { key: "problemBy", label: "Reported by", sample: "Anil (Zirakpur)" },
    ]),
    load: loadStockRequest,
    build: (r) => buildStockRequest(r, "source"),
    isPending: (r) => r.status === TRANSFER_REQUEST_STATUS.MISMATCH,
  },
  {
    key: "STOCK_RECEIVED",
    label: "Stock received by the branch that asked",
    group: "Stock Transfer",
    recordType: "Stock Request",
    kind: "AUTOMATIC",
    pendingLabel: null,
    noVendor: true,
    branchAccessModule: "stock-requests-to-us",
    variables: withCommon([...STOCK_SENT_VARS, { key: "receivedBy", label: "Received by", sample: "Anil (Zirakpur)" }]),
    load: loadStockRequest,
    build: (r) => buildStockRequest(r, "source"),
    isPending: null,
  },

  // Manual — a person sends it from the PO screen (phase 4)
  {
    key: "PO_SEND_TO_VENDOR",
    label: "Send PO to vendor (from the PO screen)",
    group: "Purchase Order",
    recordType: "Purchase Order",
    kind: "MANUAL",
    pendingLabel: null,
    hasDocument: true,
    // Who may open the send dialog — the same permission as the Send action.
    permission: ["purchase-orders", "SEND_MAIL"],
    variables: withCommon(PO_VARS),
    load: loadPo,
    build: buildPo,
    isPending: null,
  },
];

// PO_APPROVED's "mail still pending" check reads the tracking order — kept
// here so a later Tier 3 event can use it without re-deriving it.
export const poMailPending = async (poId) => {
  const t = await StockTrackingOrderModel.findOne({ poId, isActive: true }).select("mailResult").lean();
  return !MAIL_REACHED_VENDOR.includes(t?.mailResult?.mode);
};

const BY_KEY = new Map(EVENTS.map((e) => [e.key, e]));

export const getAlertEvent = (key) => BY_KEY.get(key) || null;

// A quotation spans many vendors; a stock notice has none.
export const eventAllowsVendor = (ev) => ev.recordType !== "Quotation" && !ev.noVendor;

/** What the admin screens show — no functions. */
export const listAlertEvents = () =>
  EVENTS.map((ev) => ({
    key: ev.key,
    label: ev.label,
    group: ev.group,
    recordType: ev.recordType,
    kind: ev.kind,
    pendingLabel: ev.pendingLabel,
    supportsEscalation: !!ev.pendingLabel,
    hasDocument: !!ev.hasDocument,
    allowsVendor: eventAllowsVendor(ev),
    allowsBranchUsers: !!ev.branchAccessModule,
    variables: ev.variables,
  }));

/** Sample values for Preview / Send Test. */
export const sampleVarsFor = (key) => {
  const ev = getAlertEvent(key);
  return Object.fromEntries((ev?.variables || COMMON_VARS).map((v) => [v.key, v.sample]));
};
