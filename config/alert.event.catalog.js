import StockQuotationModel from "../models/stock.quotation.model.js";
import StockPurchaseOrderModel from "../models/stock.purchase.order.model.js";
import StockInvoiceModel from "../models/stock.invoice.model.js";
import StockInvoiceAdjustmentModel from "../models/stock.invoice.adjustment.model.js";
import { poPdfAbsolutePath } from "../helpers/stock.po.pdf.helper.js";
import {
  QUOTATION_STATUS,
  PO_STATUS,
  INVOICE_STATUS,
  INVOICE_ENTRY_STATUS,
  PAYMENT_APPROVAL_STATUS,
  DEBIT_NOTE_STATUS,
  ADJUSTMENT_TYPE,
  MAIL_REACHED_VENDOR,
} from "../constants/stock.enums.js";
import StockTrackingOrderModel from "../models/stock.tracking.order.model.js";

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
    link: link("/stock/quotations", q.quotationNumber),
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
  link: link("/stock/purchase-orders", po.poNumber),
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
  const rejectedEntry = [...(inv.entries || [])].reverse().find((e) => e.status === INVOICE_ENTRY_STATUS.REJECTED);
  return {
    ref: inv.invoiceNumber || "",
    link: link("/stock/invoice-approval", inv.invoiceNumber),
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
      rejectedReason: inv.rejectedReason || rejectedEntry?.rejectedReason || "",
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
const invoiceAwaitingApproval = (inv) =>
  inv.status === INVOICE_STATUS.PENDING ||
  (inv.entries || []).some((e) => e.status === INVOICE_ENTRY_STATUS.PENDING);

// ─── Payment approval (lives on the invoice) ────────────────────────────────
const buildPayment = (inv) => {
  const base = buildInvoice(inv);
  const pa = inv.paymentApproval || {};
  return {
    ...base,
    link: link(
      inv.paymentApprovalStatus === PAYMENT_APPROVAL_STATUS.PENDING ? "/stock/payment-approval" : "/stock/payments",
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
    link: link(dn.status === DEBIT_NOTE_STATUS.APPROVAL_PENDING ? "/stock/payment-approval" : "/stock/payments", dn.invoiceNumber),
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
    isPending: (inv) =>
      inv.status === INVOICE_STATUS.REJECTED ||
      (inv.entries || []).some((e) => e.status === INVOICE_ENTRY_STATUS.REJECTED),
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

/** What the admin screens show — no functions. */
export const listAlertEvents = () =>
  EVENTS.map(({ key, label, group, recordType, kind, pendingLabel, variables, hasDocument }) => ({
    key,
    label,
    group,
    recordType,
    kind,
    pendingLabel,
    supportsEscalation: !!pendingLabel,
    hasDocument: !!hasDocument,
    variables,
  }));

/** Sample values for Preview / Send Test. */
export const sampleVarsFor = (key) => {
  const ev = getAlertEvent(key);
  return Object.fromEntries((ev?.variables || COMMON_VARS).map((v) => [v.key, v.sample]));
};
