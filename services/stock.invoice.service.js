import StockInvoiceModel from "../models/stock.invoice.model.js";
import StockTrackingOrderModel from "../models/stock.tracking.order.model.js";
import StockPurchaseOrderModel from "../models/stock.purchase.order.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import StockVendorReviewModel from "../models/stock.vendor.review.model.js";
import StockVendorPurchaseHistoryModel from "../models/stock.vendor.purchase.history.model.js";
import StockInventoryItemService from "./stock.inventory.item.service.js";
import StockTrackingOrderService from "./stock.tracking.order.service.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import StockBranchService from "./stock.branch.service.js";
import StockCategoryModel from "../models/stock.category.model.js";
import StockCategoryService from "./stock.category.service.js";
import StockTdsRateService from "./stock.tds.rate.service.js";

import { applyDataScope, isWithinDataScope } from "../helpers/data.scope.helper.js";

const SCOPE_MODULE_KEY = "invoices";

// Guard for every by-id read AND every mutation. Throws the resource's normal
// "not found" rather than a 403 — a 403 would confirm that an invoice outside
// the caller's scope exists, which is exactly what the scope is meant to hide.
// Which dimensions actually get checked (branch + entity + ownership here)
// comes from the registry, so this can never drift from the model.
const assertDataScope = (invoice, dataAccess) => {
  if (!isWithinDataScope(invoice, dataAccess, SCOPE_MODULE_KEY)) {
    throw new Error("Invoice not found");
  }
};

import { paginate } from "../helpers/pagination.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import {
  INVOICE_STATUS,
  INVOICE_ENTRY_STATUS,
  ITEM_APPROVAL_STATUS,
  TRACKING_STATUS,
  TRACKING_METHODS,
} from "../constants/stock.enums.js";

const log = getLogger(import.meta.url);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
// An invoice is priced on what the INVOICE says (invoiceQuantity) — the
// vendor's bill, whether or not every unit is entered yet. Lines from before
// invoiceQuantity existed fall back to what was received.
const pricedQty = (l) => ((l.invoiceQuantity || 0) > 0 ? l.invoiceQuantity : l.receivedQuantity || 0);
const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const chargesText = (charges) =>
  (charges || [])
    .map((c) => `${c.note || "Charge"} ${c.amount}${c.includeInBilling === false ? " (note only)" : ""}`)
    .join(", ");
// Indian financial year, April–March: 12 Oct 2026 -> "2026-27". Read in UTC
// because invoice dates arrive as "YYYY-MM-DD" (UTC midnight).
const financialYearOf = (date) => {
  const d = new Date(date);
  const start = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
};
// "inv-01", "INV 01" and " Inv-01 " are the same invoice.
const invoiceNumberKey = (n) => String(n || "").toUpperCase().replace(/\s+/g, "");
const ENTITY_TYPE = "invoices";

const RECEIVABLE_TRACKING_STATUSES = new Set([
  TRACKING_STATUS.PO_APPROVED,
  TRACKING_STATUS.IN_PROGRESS,
  TRACKING_STATUS.PARTIAL,
]);

export default class StockInvoiceService {
  /* ---------------------------------------------------------------------- */
  /* Caps + duplicate guard                                                  */
  /* ---------------------------------------------------------------------- */

  // Invoiced quantity per PO line across every OTHER live invoice of the
  // order — the PO cap must count invoices the caller cannot see, so this is
  // never scoped. A rejected invoice still counts: it is a real bill that
  // will be corrected and resubmitted, not withdrawn.
  static async _invoicedQtyByLine(trackingOrderId, session, excludeInvoiceId = null) {
    const filter = { trackingOrderId, isActive: true };
    if (excludeInvoiceId) filter._id = { $ne: excludeInvoiceId };

    const invoices = await StockInvoiceModel.find(filter).session(session).lean();
    const map = new Map();
    invoices.forEach((inv) =>
      (inv.lines || []).forEach((l) => {
        const key = String(l.quotationItemId);
        map.set(key, (map.get(key) || 0) + (l.invoiceQuantity || 0));
      })
    );
    return map;
  }

  static async _assertUniqueNumber(vendorId, key, fy, excludeInvoiceId, session, shownNumber) {
    const filter = { vendorId, invoiceNumberKey: key, financialYear: fy, isActive: true };
    if (excludeInvoiceId) filter._id = { $ne: excludeInvoiceId };
    const clash = await StockInvoiceModel.findOne(filter).select("_id").session(session).lean();
    if (clash) {
      throw new Error(`Invoice ${shownNumber} from this vendor is already added for financial year ${fy}`);
    }
  }

  /*
    The invoice's lines — which products, how many the invoice says — priced
    from the PO and capped by it. `previousLines` carries an edited invoice's
    entered items, price snapshot and rating forward, and no product may drop
    below what is already entered for it.
  */
  static _resolveInvoiceLines(po, bodyLines, invoicedElsewhere, previousLines = []) {
    const poLineByKey = new Map((po.items || []).map((it) => [String(it.quotationItemId), it]));
    const prevByKey = new Map(previousLines.map((l) => [String(l.quotationItemId), l]));
    const seen = new Set();
    const lines = [];

    for (const bl of bodyLines || []) {
      const key = String(bl.quotationItemId);
      const poLine = poLineByKey.get(key);
      if (!poLine) throw new Error("A product on the invoice does not belong to this purchase order");
      if (seen.has(key)) throw new Error(`${poLine.productName}: listed twice on the invoice`);
      seen.add(key);

      const qty = Number(bl.invoiceQuantity) || 0;
      const prev = prevByKey.get(key);
      const entered = prev?.floor ?? prev?.receivedQuantity ?? 0;
      if (qty < entered) {
        throw new Error(`${poLine.productName}: ${entered} already entered — invoice quantity can't be less than that`);
      }
      if (qty <= 0) continue;

      const elsewhere = invoicedElsewhere.get(key) || 0;
      if (elsewhere + qty > poLine.quantity) {
        throw new Error(
          elsewhere
            ? `${poLine.productName}: ${qty} here + ${elsewhere} on other invoices exceeds the ordered ${poLine.quantity}`
            : `${poLine.productName}: invoice quantity (${qty}) exceeds the ordered ${poLine.quantity}`
        );
      }

      lines.push({
        ...(prev?._id ? { _id: prev._id } : {}),
        quotationItemId: poLine.quotationItemId,
        categoryId: poLine.categoryId,
        categoryName: poLine.categoryName,
        productDefinitionId: poLine.productDefinitionId,
        productName: poLine.productName,
        unitPrice: prev ? prev.unitPrice : poLine.unitPrice,
        invoiceQuantity: qty,
        receivedQuantity: entered,
        focQuantity: prev?.focQuantity || 0,
        rows: prev?.rows || [],
        createdInventoryItemIds: prev?.createdInventoryItemIds || [],
        rating: prev?.rating || null,
      });
      delete lines[lines.length - 1].floor;
    }

    // A product dropped from the invoice must have nothing entered.
    for (const [key, prev] of prevByKey) {
      const held = prev.floor ?? prev.receivedQuantity ?? 0;
      if (!seen.has(key) && held > 0) {
        throw new Error(`${prev.productName}: ${held} already entered — it can't be removed from the invoice`);
      }
    }
    return lines;
  }


  // Creates inventory_items (PENDING approval) for every line — one row per
  // generated Serial/MAC entry for individual-tracked products, one
  // aggregated doc for quantity-tracked products. Mutates each line in place
  // to record the created ids.
  static async _createPendingInventoryItems(invoice, vendorId, branchId, receivedBy, session, entry = null) {
    for (const line of entry ? entry.lines : invoice.lines) {
      const productDef = await StockProductDefinitionModel.findOne({
        _id: line.productDefinitionId,
        isActive: true,
      })
        .session(session)
        .lean();
      if (!productDef) throw new Error(`${line.productName}: product definition not found`);

      const createdIds = [];

      if (productDef.trackingMethod === TRACKING_METHODS.INDIVIDUAL) {
        const docs = [];
        for (const row of line.rows) {
          await StockInventoryItemService._validateFieldValues(productDef, row.fieldValues || {});
          docs.push({
            productDefinitionId: line.productDefinitionId,
            vendorId,
            branchId,
            invoiceId: invoice._id,
            invoiceEntryId: entry?._id || null,
            approvalStatus: ITEM_APPROVAL_STATUS.PENDING,
            isFoc: !!row.isFoc,
            fieldValues: row.fieldValues || {},
            quantity: null,
            receivedAt: invoice.invoiceDate,
            receivedBy: receivedBy ?? null,
          });
        }
        if (docs.length) {
          const created = await StockInventoryItemModel.insertMany(docs, { session });
          created.forEach((d) => createdIds.push(d._id));
        }
      } else {
        // Quantity ("Group") tracking captures its fields once for the whole
        // receipt, not per unit: 10 meters delivered together share one set of
        // values. Paid and FOC still become SEPARATE inventory docs because
        // they are costed differently, but they are one physical lot — 20
        // meters of which 3 are free carry the same unique number — so both
        // docs get the same values. The receive form sends that single row;
        // a line with no row at all falls back to {}, which the required-field
        // check then rejects if the product needs one.
        const batchFieldValues =
          (line.rows || []).find((r) => !r.isFoc)?.fieldValues ||
          (line.rows || [])[0]?.fieldValues ||
          {};
        await StockInventoryItemService._validateFieldValues(productDef, batchFieldValues);

        const qtyDocs = [];
        if (line.receivedQuantity > 0) {
          qtyDocs.push({ quantity: line.receivedQuantity, isFoc: false, fieldValues: batchFieldValues });
        }
        if (line.focQuantity > 0) {
          qtyDocs.push({ quantity: line.focQuantity, isFoc: true, fieldValues: batchFieldValues });
        }
        for (const qd of qtyDocs) {
          const [created] = await StockInventoryItemModel.create(
            [
              {
                productDefinitionId: line.productDefinitionId,
                vendorId,
                branchId,
                invoiceId: invoice._id,
                invoiceEntryId: entry?._id || null,
                approvalStatus: ITEM_APPROVAL_STATUS.PENDING,
                isFoc: qd.isFoc,
                fieldValues: qd.fieldValues,
                quantity: qd.quantity,
                receivedAt: invoice.invoiceDate,
                receivedBy: receivedBy ?? null,
              },
            ],
            { session }
          );
          createdIds.push(created._id);
        }
      }

      line.createdInventoryItemIds = createdIds;
    }
  }

  static async _writeRatings(invoice, vendorId, user, session) {
    for (const line of invoice.lines) {
      if (line.rating && line.rating.rating !== null && line.rating.rating !== undefined) {
        await StockVendorReviewModel.create(
          [
            {
              vendorId,
              productDefinitionId: line.productDefinitionId,
              rating: line.rating.rating,
              comment: line.rating.notes || "",
            },
          ],
          { session }
        );
      }
    }
  }

  /*
    Writes what was entered onto the invoice lines and returns the change per
    product (+20, +30 …) for the entry log. Never more than the invoice says.
  */
  static _applyEntries(invoice, bodyLines) {
    const byKey = new Map((bodyLines || []).map((bl) => [String(bl.quotationItemId), bl]));
    const delta = [];
    for (const line of invoice.lines) {
      const bl = byKey.get(String(line.quotationItemId));
      if (!bl) continue;
      const qty = Math.max(0, Number(bl.receivedQuantity) || 0);
      const foc = Math.max(0, Number(bl.focQuantity) || 0);
      if (qty > line.invoiceQuantity) {
        throw new Error(`${line.productName}: ${qty} entered but the invoice says ${line.invoiceQuantity}`);
      }
      const dq = qty - (line.receivedQuantity || 0);
      const df = foc - (line.focQuantity || 0);
      if (dq || df) delta.push({ productName: line.productName, quantity: dq, focQuantity: df });

      line.receivedQuantity = qty;
      line.focQuantity = foc;
      line.rows = Array.isArray(bl.rows)
        ? bl.rows.map((r) => ({ fieldValues: r.fieldValues || {}, isFoc: !!r.isFoc }))
        : [];
      if (bl.rating !== undefined) {
        line.rating =
          bl.rating && (bl.rating.rating !== undefined || bl.rating.notes !== undefined)
            ? { rating: bl.rating.rating ?? null, notes: bl.rating.notes || "" }
            : null;
      }
    }
    for (const key of byKey.keys()) {
      if (!invoice.lines.some((l) => String(l.quotationItemId) === key)) {
        throw new Error("An entered product is not on this invoice");
      }
    }
    return delta;
  }

  // Payment has begun once approval was asked for (and not sent back), any
  // money is recorded, or the state was forced. The invoice is frozen then.
  static _paymentStarted(invoice) {
    return (
      ["PENDING", "APPROVED"].includes(invoice.paymentApprovalStatus) ||
      (invoice.payments || []).length > 0 ||
      !!invoice.paymentStateOverride
    );
  }


  // Basic/CGST/SGST/IGST/extraCharges/grandTotal for one invoice — shared by
  // getBoard (list rows) and getInvoiceById (Review page's Invoice Details).
  // `po` may be null (invoice without a linked PO); taxType then defaults to
  // CGST_SGST so the split still renders something sane.
  static _computeInvoiceTotals(inv, po, qtyOf = pricedQty) {
    const poLineByKey = new Map((po?.items || []).map((it) => [String(it.quotationItemId), it]));
    const taxType = po?.taxType || "CGST_SGST";

    let basicAmount = 0, cgstAmount = 0, sgstAmount = 0, igstAmount = 0;
    (inv.lines || []).forEach((l) => {
      const lineBasic = qtyOf(l) * (l.unitPrice || 0);
      const gstRate = poLineByKey.get(String(l.quotationItemId))?.gstRate || 0;
      basicAmount += lineBasic;
      if (taxType === "IGST") {
        igstAmount += round2((lineBasic * gstRate) / 100);
      } else {
        const half = round2((lineBasic * gstRate) / 200);
        cgstAmount += half;
        sgstAmount += half;
      }
    });
    const gstAmount = round2(cgstAmount + sgstAmount + igstAmount);
    // extraChargesTotal is the BILLED charges only — every report and ledger
    // that reads it is summing what the vendor is owed. Note-only charges are
    // reported on their own so a screen can still show them.
    const extraChargesTotal = StockInvoiceService._sumCharges(inv.extraCharges, true);
    const nonBilledChargesTotal = StockInvoiceService._sumCharges(inv.extraCharges, false);

    const grandTotal = round2(StockInvoiceService._computeAmount(inv.lines || [], inv.extraCharges, qtyOf) + gstAmount);
    // TDS: on the BASIC only — not GST, not extra charges — at the rate the
    // invoice snapshotted when it entered the ledger (0 when it has none).
    const tdsRate = inv.tds?.rate || 0;
    const tdsAmount = round2((basicAmount * tdsRate) / 100);

    return {
      taxType, basicAmount: round2(basicAmount),
      cgstAmount: round2(cgstAmount), sgstAmount: round2(sgstAmount), igstAmount: round2(igstAmount),
      gstAmount, extraChargesTotal, nonBilledChargesTotal,
      // grandTotal stays the bill as the vendor wrote it; netTotal is what is
      // owed once TDS is held back.
      grandTotal,
      tdsRate, tdsAmount,
      netTotal: round2(grandTotal - tdsAmount),
    };
  }

  /*
    Snapshot the buyer entity's TDS rate onto the invoice — once, the first
    time it enters the ledger. Never re-read: a later change in Master > TDS
    Rates must not move an invoice already approved. No rate set → 0%.
  */
  static async _applyTds(invoice, session) {
    if (invoice.tds?.appliedAt) return;
    const row = await StockTdsRateService.getActiveRateFor(invoice.entityAlias, session);
    invoice.tds = {
      rate: row?.rate || 0,
      entityAlias: invoice.entityAlias || "",
      note: row?.note || "",
      appliedAt: new Date(),
    };
  }

  // A charge without the flag predates it and was always billed.
  static _sumCharges(extraCharges, billed) {
    return round2(
      (extraCharges || [])
        .filter((c) => (c.includeInBilling !== false) === billed)
        .reduce((s, c) => s + (c.amount || 0), 0)
    );
  }

  static _normalizeCharges(extraCharges) {
    return (extraCharges || []).map((c) => ({
      amount: c.amount,
      note: c.note || "",
      includeInBilling: c.includeInBilling !== false,
    }));
  }

  static _computeAmount(lines, extraCharges, qtyOf = pricedQty) {
    const linesTotal = round2(
      lines.reduce((s, l) => s + qtyOf(l) * (l.unitPrice || 0), 0)
    );
    return round2(linesTotal + StockInvoiceService._sumCharges(extraCharges, true));
  }

  /* ---------------------------------------------------------------------- */
  /* Read the uploaded invoice                                               */
  /* ---------------------------------------------------------------------- */

  /*
    What the uploaded invoice says. For now DUMMY values worked out from the
    PO — every product at its still-uninvoiced quantity, priced at the PO
    rate with GST. The Claude API reading the actual file replaces this body
    later; the screen already treats the result as a suggestion to correct.
  */
  static async readInvoiceFile(trackingOrderId, dataAccess) {
    const tracking = await StockTrackingOrderModel.findOne({ _id: trackingOrderId, isActive: true }).lean();
    if (!tracking || !isWithinDataScope(tracking, dataAccess, "tracking-orders")) {
      throw new Error("Tracking order not found");
    }
    const po = await StockPurchaseOrderModel.findOne({ _id: tracking.poId, isActive: true }).lean();
    if (!po) throw new Error("Purchase order not found for this tracking order");

    const invoiced = await StockInvoiceService._invoicedQtyByLine(trackingOrderId, null);
    const lines = (po.items || []).map((it) => ({
      quotationItemId: it.quotationItemId,
      productName: it.productName,
      invoiceQuantity: Math.max(0, (it.quantity || 0) - (invoiced.get(String(it.quotationItemId)) || 0)),
    }));
    const invoiceAmount = round2(
      (po.items || []).reduce((s, it) => {
        const qty = lines.find((l) => String(l.quotationItemId) === String(it.quotationItemId)).invoiceQuantity;
        return s + qty * (it.unitPrice || 0) * (1 + (it.gstRate || 0) / 100);
      }, 0)
    );
    const today = new Date();
    const p = (x) => String(x).padStart(2, "0");
    const ymdCompact = `${today.getFullYear()}${p(today.getMonth() + 1)}${p(today.getDate())}`;
    return {
      source: "DUMMY",
      invoiceNumber: `DUMMY-${ymdCompact}`,
      invoiceDate: `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`,
      invoiceAmount,
      lines,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Add Invoice — upload, check the details, save (status ADDED)            */
  /* ---------------------------------------------------------------------- */

  static async createInvoice(trackingOrderId, body, user, session, dataAccess) {
    const tracking = await StockTrackingOrderModel.findOne({
      _id: trackingOrderId,
      isActive: true,
    }).session(session);
    if (!tracking) throw new Error("Tracking order not found");
    // Scoped off the tracking order's entity — the invoice inherits it below.
    if (!isWithinDataScope(tracking, dataAccess, "tracking-orders")) {
      throw new Error("Tracking order not found");
    }
    if (!RECEIVABLE_TRACKING_STATUSES.has(tracking.status)) {
      throw new Error("An invoice can only be added while this order is PO Sent, In Progress or Partial");
    }

    const po = await StockPurchaseOrderModel.findOne({ _id: tracking.poId, isActive: true })
      .session(session)
      .lean();
    if (!po) throw new Error("Purchase order not found for this tracking order");

    // The receiving branch is this invoice's branch: every read and every
    // inventory item is branch-scoped on it. Pinning it to the receiver's own
    // scope keeps the invoice visible to the person who added it.
    const branchId = await StockBranchService.assertBranchInScope(body.branchId, dataAccess, session);

    const invoiced = await StockInvoiceService._invoicedQtyByLine(trackingOrderId, session);
    const lines = StockInvoiceService._resolveInvoiceLines(po, body.lines, invoiced);
    if (!lines.length) throw new Error("Enter the invoice quantity for at least one product");

    const invoiceNumber = String(body.invoiceNumber).trim();
    const key = invoiceNumberKey(invoiceNumber);
    const fy = financialYearOf(body.invoiceDate);
    await StockInvoiceService._assertUniqueNumber(po.vendorId, key, fy, null, session, invoiceNumber);

    const extraCharges = StockInvoiceService._normalizeCharges(body.extraCharges);

    const [invoice] = await StockInvoiceModel.create(
      [
        {
          trackingOrderId,
          poId: po._id,
          // Denormalized so the invoice board can be entity-scoped without a join.
          entityAlias: tracking.buyerEntity?.alias || "",
          vendorId: po.vendorId,
          vendorName: po.vendorName || "",
          invoiceNumber,
          invoiceNumberKey: key,
          financialYear: fy,
          invoiceDate: body.invoiceDate,
          invoiceFile: body.invoiceFile || "",
          invoiceAmount: Number(body.invoiceAmount) || 0,
          branchId,
          receivedByName: body.receivedByName || user?.name || "",
          notes: String(body.notes || "").trim(),
          extraCharges,
          lines,
          amount: StockInvoiceService._computeAmount(lines, extraCharges),
          status: INVOICE_STATUS.ADDED,
        },
      ],
      { session }
    );

    await StockTrackingOrderService.recalculateStatus(trackingOrderId, session);

    log.info(`Invoice added: ${invoice.invoiceNumber} for tracking order ${trackingOrderId}`);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: invoice._id, action: "CREATE", actor: user, before: null, after: invoice.toObject(),
    });
    return invoice;
  }

  /* ---------------------------------------------------------------------- */
  /* Add Items — Save as Draft / Submit                                      */
  /* ---------------------------------------------------------------------- */

  /*
    Anyone receiving can carry the invoice forward — draft by draft — and the
    entry log records who entered what. Submit only goes through once every
    product has exactly what the invoice says. A rejected invoice comes back
    here to be corrected and submitted again.
  */
  static async saveItems(id, body, user, session, dataAccess, { submit = false } = {}) {
    const invoice = await StockInvoiceModel.findOne({ _id: id, isActive: true }).session(session);
    if (!invoice) throw new Error("Invoice not found");
    assertDataScope(invoice, dataAccess);
    if (invoice.partialSubmit) {
      return StockInvoiceService._saveEntry(invoice, body, user, session, { submit });
    }
    const editable = [INVOICE_STATUS.ADDED, INVOICE_STATUS.DRAFT, INVOICE_STATUS.REJECTED];
    if (!editable.includes(invoice.status)) {
      throw new Error("Items can't be changed now — this invoice is already submitted");
    }
    const before = invoice.toObject();

    const delta = StockInvoiceService._applyEntries(invoice, body.lines);

    if (submit) {
      const short = invoice.lines.filter((l) => (l.receivedQuantity || 0) !== l.invoiceQuantity);
      if (short.length) {
        throw new Error(
          "Enter every item on the invoice before submitting — " +
            short.map((l) => `${l.productName} ${l.receivedQuantity || 0}/${l.invoiceQuantity}`).join(", ")
        );
      }

      const po = await StockPurchaseOrderModel.findOne({ _id: invoice.poId, isActive: true }).session(session).lean();
      if (!po) throw new Error("Purchase order not found for this invoice");

      // Items from an earlier, rejected submission were never stock.
      const oldItemIds = invoice.lines.flatMap((l) => l.createdInventoryItemIds || []);
      if (oldItemIds.length) {
        await StockInventoryItemModel.deleteMany({ _id: { $in: oldItemIds } }, { session });
      }
      await StockInvoiceService._createPendingInventoryItems(
        invoice, invoice.vendorId, invoice.branchId, user?.id || user?._id || null, session
      );
      await StockInvoiceService._writeRatings(invoice, invoice.vendorId, user, session);

      invoice.status = INVOICE_STATUS.PENDING;
      invoice.rejectedReason = "";
      invoice.reviewedBy = null;
      invoice.reviewedByName = "";
      invoice.reviewedAt = null;
    } else if (invoice.status === INVOICE_STATUS.ADDED) {
      invoice.status = INVOICE_STATUS.DRAFT;
    }

    invoice.amount = StockInvoiceService._computeAmount(invoice.lines, invoice.extraCharges);
    if (delta.length || submit) {
      invoice.entryLog.push({
        at: new Date(),
        by: user?.id || user?._id || null,
        byName: user?.name || "",
        action: submit ? "SUBMIT" : "DRAFT",
        items: delta,
      });
    }
    await invoice.save({ session });
    await StockTrackingOrderService.recalculateStatus(invoice.trackingOrderId, session);

    log.info(`Invoice ${invoice.invoiceNumber}: items ${submit ? "submitted" : "saved as draft"}`);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: invoice._id, action: submit ? "SUBMIT" : "SAVE_DRAFT", actor: user, before, after: invoice.toObject(),
    });
    return invoice;
  }

  /* ---------------------------------------------------------------------- */
  /* Edit invoice — details as written on the vendor's invoice               */
  /* ---------------------------------------------------------------------- */

  /*
    Held by its own permission (EDIT_INVOICE). Every change goes into
    editHistory. Rules: quantities can't go below what is entered, can't move
    at all once the items are submitted, and nothing changes once payment
    has started.
  */
  static async updateInvoice(id, body, user, session, dataAccess) {
    const invoice = await StockInvoiceModel.findOne({ _id: id, isActive: true }).session(session);
    if (!invoice) throw new Error("Invoice not found");
    assertDataScope(invoice, dataAccess);
    if (StockInvoiceService._paymentStarted(invoice)) {
      throw new Error("Payment has already started on this invoice — correct it with a debit note or misc charge instead");
    }
    const before = invoice.toObject();
    const changes = [];
    const note = (field, from, to) => {
      if (!sameValue(from, to)) changes.push({ field, from, to });
    };

    if (body.invoiceNumber !== undefined) {
      const next = String(body.invoiceNumber).trim();
      note("Invoice number", invoice.invoiceNumber, next);
      invoice.invoiceNumber = next;
    }
    if (body.invoiceDate !== undefined) {
      const next = new Date(body.invoiceDate);
      note("Invoice date", ymd(invoice.invoiceDate), ymd(next));
      invoice.invoiceDate = next;
    }
    if (body.invoiceAmount !== undefined) {
      const next = Number(body.invoiceAmount) || 0;
      note("Invoice amount", invoice.invoiceAmount || 0, next);
      invoice.invoiceAmount = next;
    }
    if (body.invoiceFile) {
      note("Invoice file", invoice.invoiceFile || "", body.invoiceFile);
      invoice.invoiceFile = body.invoiceFile;
    }
    if (body.notes !== undefined) {
      const next = String(body.notes || "").trim();
      note("Notes", invoice.notes || "", next);
      invoice.notes = next;
    }
    if (body.extraCharges !== undefined) {
      const next = StockInvoiceService._normalizeCharges(body.extraCharges);
      note("Extra charges", chargesText(invoice.extraCharges), chargesText(next));
      invoice.extraCharges = next;
    }

    if (body.lines !== undefined) {
      const prevLines = invoice.lines.map((l) => l.toObject());
      const po = await StockPurchaseOrderModel.findOne({ _id: invoice.poId, isActive: true }).session(session).lean();
      if (!po) throw new Error("Purchase order not found for this invoice");
      const invoiced = await StockInvoiceService._invoicedQtyByLine(invoice.trackingOrderId, session, invoice._id);
      // With partial submit the floor is what its entries already hold
      // (approved, pending and the open draft), not just the approved count.
      const floorLines = invoice.partialSubmit
        ? (() => {
            const held = StockInvoiceService._entryQtyByLine(invoice, { withDraft: true });
            return prevLines.map((l) => ({ ...l, floor: held.get(String(l.quotationItemId))?.qty || 0 }));
          })()
        : prevLines;
      const nextLines = StockInvoiceService._resolveInvoiceLines(po, body.lines, invoiced, floorLines);
      if (!nextLines.length) throw new Error("An invoice needs at least one product with a quantity");

      const prevByKey = new Map(prevLines.map((l) => [String(l.quotationItemId), l]));
      const nextByKey = new Map(nextLines.map((l) => [String(l.quotationItemId), l]));
      const qtyChanges = [];
      for (const key of new Set([...prevByKey.keys(), ...nextByKey.keys()])) {
        const p = prevByKey.get(key);
        const n = nextByKey.get(key);
        const from = p?.invoiceQuantity || 0;
        const to = n?.invoiceQuantity || 0;
        if (from !== to) qtyChanges.push({ field: `${(n || p).productName} · quantity`, from, to });
      }
      // Submitted items equal the invoice exactly; moving the quantity now
      // would leave an approved/pending invoice that no longer adds up.
      if (qtyChanges.length && [INVOICE_STATUS.PENDING, INVOICE_STATUS.APPROVED].includes(invoice.status)) {
        throw new Error("Items on this invoice are already submitted — its quantities can't change now");
      }
      changes.push(...qtyChanges);
      invoice.lines = nextLines;
    }

    const key = invoiceNumberKey(invoice.invoiceNumber);
    const fy = financialYearOf(invoice.invoiceDate);
    if (key !== invoice.invoiceNumberKey || fy !== invoice.financialYear) {
      await StockInvoiceService._assertUniqueNumber(invoice.vendorId, key, fy, invoice._id, session, invoice.invoiceNumber);
      invoice.invoiceNumberKey = key;
      invoice.financialYear = fy;
    }
    invoice.amount = StockInvoiceService._computeAmount(invoice.lines, invoice.extraCharges);

    if (changes.length) {
      invoice.editHistory.push({ at: new Date(), by: user?.id || user?._id || null, byName: user?.name || "", changes });
    }
    await invoice.save({ session });

    log.info(`Invoice edited: ${invoice.invoiceNumber} (${changes.length} change(s))`);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: invoice._id, action: "UPDATE", actor: user, before, after: invoice.toObject(),
    });
    return invoice;
  }

  // An invoice added by mistake. Not once approved: its stock is real then.
  static async deleteInvoice(id, user, session, dataAccess) {
    const invoice = await StockInvoiceModel.findOne({ _id: id, isActive: true }).session(session);
    if (!invoice) throw new Error("Invoice not found");
    assertDataScope(invoice, dataAccess);
    if (invoice.status === INVOICE_STATUS.APPROVED || invoice.inLedger) {
      throw new Error("An approved invoice (or one with an approved entry) can't be deleted");
    }
    const before = invoice.toObject();

    await StockInventoryItemModel.deleteMany({ invoiceId: invoice._id }, { session });
    invoice.isActive = false;
    invoice.deletedAt = new Date();
    await invoice.save({ session });
    await StockTrackingOrderService.recalculateStatus(invoice.trackingOrderId, session);

    log.info(`Invoice deleted: ${invoice.invoiceNumber}`);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: invoice._id, action: "DELETE", actor: user, before, after: invoice.toObject(),
    });
    return invoice;
  }

  /* ---------------------------------------------------------------------- */
  /* Partial submit — entries                                                */
  /* ---------------------------------------------------------------------- */

  // Quantity held by entries other than `exceptEntryId` — submitted and
  // approved ones (and the open draft, when `withDraft`), per product.
  static _entryQtyByLine(invoice, { exceptEntryId = null, withDraft = false } = {}) {
    const counted = [INVOICE_ENTRY_STATUS.PENDING, INVOICE_ENTRY_STATUS.APPROVED];
    if (withDraft) counted.push(INVOICE_ENTRY_STATUS.DRAFT);
    const map = new Map();
    (invoice.entries || [])
      .filter((e) => counted.includes(e.status) && String(e._id) !== String(exceptEntryId))
      .forEach((e) =>
        (e.lines || []).forEach((l) => {
          const k = String(l.quotationItemId);
          const c = map.get(k) || { qty: 0, foc: 0 };
          c.qty += l.receivedQuantity || 0;
          c.foc += l.focQuantity || 0;
          map.set(k, c);
        })
      );
    return map;
  }

  // Invoice status from its entries: Added → In progress → Approved.
  static _statusFromEntries(invoice) {
    const approvedAll = invoice.lines.every((l) => (l.receivedQuantity || 0) >= (l.invoiceQuantity || 0));
    if (invoice.lines.length && approvedAll) return INVOICE_STATUS.APPROVED;
    return (invoice.entries || []).length ? INVOICE_STATUS.IN_PROGRESS : INVOICE_STATUS.ADDED;
  }

  /*
    Save the open draft entry (or resubmit a rejected one, `body.entryId`).
    Each product is capped by what is still free on the invoice: its
    quantity minus every other submitted / approved entry. Submit sends the
    entry for approval with however much it holds — at least one unit.
  */
  static async _saveEntry(invoice, body, user, session, { submit }) {
    if (invoice.status === INVOICE_STATUS.APPROVED) throw new Error("Everything on this invoice is already approved");
    const before = invoice.toObject();

    let entry;
    if (body.entryId) {
      entry = invoice.entries.id(body.entryId);
      if (!entry) throw new Error("Entry not found");
      if (entry.status !== INVOICE_ENTRY_STATUS.REJECTED) throw new Error("Only a rejected entry can be edited");
      if (!submit) throw new Error("A rejected entry is corrected and submitted again — it can't go back to draft");
    } else {
      entry = invoice.entries.find((e) => e.status === INVOICE_ENTRY_STATUS.DRAFT);
      if (!entry) {
        invoice.entries.push({ entryNumber: invoice.entries.length + 1, status: INVOICE_ENTRY_STATUS.DRAFT, lines: [] });
        entry = invoice.entries[invoice.entries.length - 1];
      }
    }

    const others = StockInvoiceService._entryQtyByLine(invoice, { exceptEntryId: entry._id });
    const prevByKey = new Map((entry.lines || []).map((l) => [String(l.quotationItemId), l]));
    const lineByKey = new Map(invoice.lines.map((l) => [String(l.quotationItemId), l]));
    const nextLines = [];
    const delta = [];
    for (const bl of body.lines || []) {
      const key = String(bl.quotationItemId);
      const il = lineByKey.get(key);
      if (!il) throw new Error("An entered product is not on this invoice");
      const qty = Math.max(0, Number(bl.receivedQuantity) || 0);
      const foc = Math.max(0, Number(bl.focQuantity) || 0);
      const o = others.get(key) || { qty: 0, foc: 0 };
      if (qty > (il.invoiceQuantity || 0) - o.qty) {
        throw new Error(`${il.productName}: only ${Math.max(0, (il.invoiceQuantity || 0) - o.qty)} left to enter on this invoice`);
      }
      if (bl.rating !== undefined && bl.rating && bl.rating.rating !== undefined) {
        il.rating = { rating: bl.rating.rating ?? null, notes: bl.rating.notes || "" };
      }
      const prev = prevByKey.get(key);
      const dq = qty - (prev?.receivedQuantity || 0);
      const df = foc - (prev?.focQuantity || 0);
      if (dq || df) delta.push({ productName: il.productName, quantity: dq, focQuantity: df });
      if (qty <= 0 && foc <= 0) continue;
      nextLines.push({
        quotationItemId: il.quotationItemId,
        productDefinitionId: il.productDefinitionId,
        productName: il.productName,
        receivedQuantity: qty,
        focQuantity: foc,
        rows: Array.isArray(bl.rows) ? bl.rows.map((r) => ({ fieldValues: r.fieldValues || {}, isFoc: !!r.isFoc })) : [],
        createdInventoryItemIds: prev?.createdInventoryItemIds || [],
      });
    }

    if (submit) {
      if (!nextLines.some((l) => l.receivedQuantity > 0 || l.focQuantity > 0)) {
        throw new Error("Enter at least one item on this entry before submitting");
      }
      // A rejected entry's earlier items were never stock.
      const oldItemIds = (entry.lines || []).flatMap((l) => l.createdInventoryItemIds || []);
      if (oldItemIds.length) await StockInventoryItemModel.deleteMany({ _id: { $in: oldItemIds } }, { session });
      entry.lines = nextLines.map((l) => ({ ...l, createdInventoryItemIds: [] }));
      await StockInvoiceService._createPendingInventoryItems(
        invoice, invoice.vendorId, invoice.branchId, user?.id || user?._id || null, session, entry
      );
      entry.status = INVOICE_ENTRY_STATUS.PENDING;
      entry.submittedAt = new Date();
      entry.submittedByName = user?.name || "";
      entry.rejectedReason = "";
      entry.reviewedBy = null;
      entry.reviewedByName = "";
      entry.reviewedAt = null;
    } else {
      entry.lines = nextLines;
    }
    // A draft emptied back to nothing is no entry at all.
    if (!submit && !nextLines.length) invoice.entries.pull(entry._id);

    invoice.status = StockInvoiceService._statusFromEntries(invoice);
    if (delta.length || submit) {
      invoice.entryLog.push({
        at: new Date(),
        by: user?.id || user?._id || null,
        byName: user?.name || "",
        action: submit ? "SUBMIT" : "DRAFT",
        entryNumber: entry.entryNumber,
        items: delta,
      });
    }
    await invoice.save({ session });
    await StockTrackingOrderService.recalculateStatus(invoice.trackingOrderId, session);

    log.info(`Invoice ${invoice.invoiceNumber}: entry ${entry.entryNumber} ${submit ? "submitted" : "saved as draft"}`);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: invoice._id, action: submit ? "SUBMIT_ENTRY" : "SAVE_DRAFT", actor: user, before, after: invoice.toObject(),
    });
    return invoice;
  }

  /*
    ⋮ → Partial submit ON / OFF (permission PARTIAL_SUBMIT).
    ON  — while nothing is submitted: whatever is entered becomes the draft
          of Entry 1.
    OFF — only while no entry has been submitted: the draft goes back to
          being the invoice's single entry.
  */
  static async setPartialSubmit(id, on, user, session, dataAccess) {
    const invoice = await StockInvoiceModel.findOne({ _id: id, isActive: true }).session(session);
    if (!invoice) throw new Error("Invoice not found");
    assertDataScope(invoice, dataAccess);
    if (!!invoice.partialSubmit === !!on) return invoice;
    const before = invoice.toObject();

    if (on) {
      if (![INVOICE_STATUS.ADDED, INVOICE_STATUS.DRAFT, INVOICE_STATUS.REJECTED].includes(invoice.status)) {
        throw new Error("Items on this invoice are already submitted — partial submit can't be turned on now");
      }
      // Items from a rejected whole-invoice submission were never stock.
      const oldItemIds = invoice.lines.flatMap((l) => l.createdInventoryItemIds || []);
      if (oldItemIds.length) await StockInventoryItemModel.deleteMany({ _id: { $in: oldItemIds } }, { session });
      const draftLines = invoice.lines
        .filter((l) => (l.receivedQuantity || 0) > 0 || (l.focQuantity || 0) > 0)
        .map((l) => ({
          quotationItemId: l.quotationItemId,
          productDefinitionId: l.productDefinitionId,
          productName: l.productName,
          receivedQuantity: l.receivedQuantity || 0,
          focQuantity: l.focQuantity || 0,
          rows: l.rows || [],
          createdInventoryItemIds: [],
        }));
      invoice.entries = draftLines.length ? [{ entryNumber: 1, status: INVOICE_ENTRY_STATUS.DRAFT, lines: draftLines }] : [];
      invoice.lines.forEach((l) => {
        l.receivedQuantity = 0;
        l.focQuantity = 0;
        l.rows = [];
        l.createdInventoryItemIds = [];
      });
      invoice.rejectedReason = "";
      invoice.partialSubmit = true;
    } else {
      if ((invoice.entries || []).some((e) => e.status !== INVOICE_ENTRY_STATUS.DRAFT)) {
        throw new Error("Entries on this invoice are already submitted — partial submit can't be turned off now");
      }
      const draft = (invoice.entries || [])[0];
      const byKey = new Map((draft?.lines || []).map((l) => [String(l.quotationItemId), l]));
      invoice.lines.forEach((l) => {
        const d = byKey.get(String(l.quotationItemId));
        l.receivedQuantity = d?.receivedQuantity || 0;
        l.focQuantity = d?.focQuantity || 0;
        l.rows = d?.rows || [];
      });
      invoice.entries = [];
      invoice.partialSubmit = false;
    }
    invoice.status = on
      ? StockInvoiceService._statusFromEntries(invoice)
      : invoice.lines.some((l) => (l.receivedQuantity || 0) > 0)
        ? INVOICE_STATUS.DRAFT
        : INVOICE_STATUS.ADDED;
    invoice.editHistory.push({
      at: new Date(), by: user?.id || user?._id || null, byName: user?.name || "",
      changes: [{ field: "Partial submit", from: on ? "OFF" : "ON", to: on ? "ON" : "OFF" }],
    });
    await invoice.save({ session });

    log.info(`Invoice ${invoice.invoiceNumber}: partial submit ${on ? "ON" : "OFF"}`);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: invoice._id, action: on ? "PARTIAL_ON" : "PARTIAL_OFF", actor: user, before, after: invoice.toObject(),
    });
    return invoice;
  }

  static async approveEntry(id, entryId, user, session, dataAccess) {
    const invoice = await StockInvoiceModel.findOne({ _id: id, isActive: true }).session(session);
    if (!invoice) throw new Error("Invoice not found");
    assertDataScope(invoice, dataAccess);
    const entry = invoice.entries.id(entryId);
    if (!entry) throw new Error("Entry not found");
    if (entry.status !== INVOICE_ENTRY_STATUS.PENDING) throw new Error("Only a pending entry can be approved");
    const before = invoice.toObject();

    const lineByKey = new Map(invoice.lines.map((l) => [String(l.quotationItemId), l]));
    for (const el of entry.lines) {
      const il = lineByKey.get(String(el.quotationItemId));
      if (!il) throw new Error(`${el.productName} is no longer on this invoice — reject this entry instead`);
      il.receivedQuantity = (il.receivedQuantity || 0) + (el.receivedQuantity || 0);
      il.focQuantity = (il.focQuantity || 0) + (el.focQuantity || 0);
    }
    entry.status = INVOICE_ENTRY_STATUS.APPROVED;
    entry.reviewedBy = user?.id || user?._id || null;
    entry.reviewedByName = user?.name || "";
    entry.reviewedAt = new Date();

    // The whole invoice counts in the ledger from its first approved entry —
    // and its whole TDS is taken then too.
    await StockInvoiceService._applyTds(invoice, session);
    invoice.inLedger = true;
    invoice.status = StockInvoiceService._statusFromEntries(invoice);
    if (invoice.status === INVOICE_STATUS.APPROVED) {
      invoice.reviewedBy = entry.reviewedBy;
      invoice.reviewedByName = entry.reviewedByName;
      invoice.reviewedAt = entry.reviewedAt;
      await StockInvoiceService._writeRatings(invoice, invoice.vendorId, user, session);
    }
    await invoice.save({ session });

    await StockInventoryItemModel.updateMany(
      { invoiceEntryId: entry._id },
      { $set: { approvalStatus: ITEM_APPROVAL_STATUS.APPROVED } },
      { session }
    );
    const tracking = await StockTrackingOrderModel.findOne({ _id: invoice.trackingOrderId }).session(session);
    for (const el of entry.lines) {
      if (!(el.receivedQuantity > 0)) continue;
      await StockVendorPurchaseHistoryModel.create(
        [
          {
            vendorId: invoice.vendorId,
            productDefinitionId: el.productDefinitionId,
            receivedQuantity: el.receivedQuantity,
            purchasePrice: lineByKey.get(String(el.quotationItemId))?.unitPrice || 0,
            purchaseDate: invoice.invoiceDate,
            sourceQuotationId: tracking?.sourceQuotationId || null,
          },
        ],
        { session }
      );
    }
    await StockTrackingOrderService.recalculateStatus(invoice.trackingOrderId, session);

    log.info(`Invoice ${invoice.invoiceNumber}: entry ${entry.entryNumber} approved`);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: invoice._id, action: "APPROVE_ENTRY", actor: user, before, after: invoice.toObject(),
    });
    return invoice;
  }

  static async rejectEntry(id, entryId, reason, user, session, dataAccess) {
    const invoice = await StockInvoiceModel.findOne({ _id: id, isActive: true }).session(session);
    if (!invoice) throw new Error("Invoice not found");
    assertDataScope(invoice, dataAccess);
    const entry = invoice.entries.id(entryId);
    if (!entry) throw new Error("Entry not found");
    if (entry.status !== INVOICE_ENTRY_STATUS.PENDING) throw new Error("Only a pending entry can be rejected");
    const before = invoice.toObject();

    entry.status = INVOICE_ENTRY_STATUS.REJECTED;
    entry.rejectedReason = typeof reason === "string" ? reason : "";
    entry.reviewedBy = user?.id || user?._id || null;
    entry.reviewedByName = user?.name || "";
    entry.reviewedAt = new Date();
    await invoice.save({ session });

    await StockInventoryItemModel.updateMany(
      { invoiceEntryId: entry._id },
      { $set: { approvalStatus: ITEM_APPROVAL_STATUS.REJECTED } },
      { session }
    );
    await StockTrackingOrderService.recalculateStatus(invoice.trackingOrderId, session);

    log.info(`Invoice ${invoice.invoiceNumber}: entry ${entry.entryNumber} rejected`);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: invoice._id, action: "REJECT_ENTRY", actor: user, before, after: invoice.toObject(), reason,
    });
    return invoice;
  }

  /* ---------------------------------------------------------------------- */
  /* Approve / Reject                                                        */
  /* ---------------------------------------------------------------------- */

  static async approveInvoice(id, user, session, dataAccess) {
    const invoice = await StockInvoiceModel.findOne({ _id: id, isActive: true }).session(session);
    if (!invoice) throw new Error("Invoice not found");
    assertDataScope(invoice, dataAccess);
    if (invoice.partialSubmit) throw new Error("This invoice is approved entry by entry");
    if (invoice.status !== INVOICE_STATUS.PENDING) {
      throw new Error("Only a pending invoice can be approved");
    }
    const before = invoice.toObject();

    const tracking = await StockTrackingOrderModel.findOne({ _id: invoice.trackingOrderId }).session(
      session
    );

    invoice.status = INVOICE_STATUS.APPROVED;
    await StockInvoiceService._applyTds(invoice, session);
    invoice.inLedger = true;
    invoice.rejectedReason = "";
    invoice.reviewedBy = user?.id || user?._id || null;
    invoice.reviewedByName = user?.name || "";
    invoice.reviewedAt = new Date();
    await invoice.save({ session });

    await StockInventoryItemModel.updateMany(
      { invoiceId: invoice._id },
      { $set: { approvalStatus: ITEM_APPROVAL_STATUS.APPROVED } },
      { session }
    );

    for (const line of invoice.lines) {
      await StockVendorPurchaseHistoryModel.create(
        [
          {
            vendorId: invoice.vendorId,
            productDefinitionId: line.productDefinitionId,
            receivedQuantity: line.receivedQuantity,
            purchasePrice: line.unitPrice,
            purchaseDate: invoice.invoiceDate,
            sourceQuotationId: tracking?.sourceQuotationId || null,
          },
        ],
        { session }
      );
    }

    await StockTrackingOrderService.recalculateStatus(invoice.trackingOrderId, session);

    log.info(`Invoice approved: ${invoice.invoiceNumber}`);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: invoice._id, action: "APPROVE", actor: user, before, after: invoice.toObject(),
    });
    return invoice;
  }

  static async rejectInvoice(id, reason, user, session, dataAccess) {
    const invoice = await StockInvoiceModel.findOne({ _id: id, isActive: true }).session(session);
    if (!invoice) throw new Error("Invoice not found");
    assertDataScope(invoice, dataAccess);
    if (invoice.partialSubmit) throw new Error("This invoice is approved entry by entry");
    if (invoice.status !== INVOICE_STATUS.PENDING) {
      throw new Error("Only a pending invoice can be rejected");
    }
    const before = invoice.toObject();

    invoice.status = INVOICE_STATUS.REJECTED;
    invoice.rejectedReason = typeof reason === "string" ? reason : "";
    invoice.reviewedBy = user?.id || user?._id || null;
    invoice.reviewedByName = user?.name || "";
    invoice.reviewedAt = new Date();
    await invoice.save({ session });

    await StockInventoryItemModel.updateMany(
      { invoiceId: invoice._id },
      { $set: { approvalStatus: ITEM_APPROVAL_STATUS.REJECTED } },
      { session }
    );

    await StockTrackingOrderService.recalculateStatus(invoice.trackingOrderId, session);

    log.info(`Invoice rejected: ${invoice.invoiceNumber}`);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: invoice._id, action: "REJECT", actor: user, before, after: invoice.toObject(), reason,
    });
    return invoice;
  }

  /* ---------------------------------------------------------------------- */
  /* Read                                                                    */
  /* ---------------------------------------------------------------------- */

  // Enriched with read-only, non-snapshotted display data (PO number/tax
  // type/pdf, per-line GST rate, product tracking method) for the Invoice
  // Approval "Review" full page — same "resolve at read-time, no schema
  // change" posture as getBoard's poNumber/orderedQty.
  static async getInvoiceById(id, dataAccess, { entryId = null } = {}) {
    const invoice = await StockInvoiceModel.findOne({ _id: id, isActive: true }).lean();
    if (!invoice) {
      throw new Error("Invoice not found");
    }
    assertDataScope(invoice, dataAccess);

    const po = invoice.poId
      ? await StockPurchaseOrderModel.findOne({ _id: invoice.poId })
          .select("poNumber taxType pdfPath items.quotationItemId items.gstRate items.quantity")
          .lean()
      : null;
    const poLineByKey = new Map((po?.items || []).map((it) => [String(it.quotationItemId), it]));
    const totals = StockInvoiceService._computeInvoiceTotals(invoice, po);

    const productDefIds = [...new Set((invoice.lines || []).map((l) => String(l.productDefinitionId)))];
    const productDefs = await StockProductDefinitionModel.find({ _id: { $in: productDefIds } })
      .select("trackingMethod unit")
      .lean();
    const productDefById = new Map(productDefs.map((p) => [String(p._id), p]));

    // What OTHER approved invoices of this order already brought in, so the
    // reviewer sees PO qty / earlier received / this invoice side by side.
    // A partial-submit invoice still IN_PROGRESS counts too: its lines carry
    // what its approved entries brought in.
    const otherApproved = await StockInvoiceModel.find({
      trackingOrderId: invoice.trackingOrderId,
      _id: { $ne: invoice._id },
      status: { $in: [INVOICE_STATUS.APPROVED, INVOICE_STATUS.IN_PROGRESS] },
      isActive: true,
    })
      .select("lines.quotationItemId lines.receivedQuantity lines.focQuantity")
      .lean();
    const earlierByKey = new Map();
    const earlierFocByKey = new Map();
    otherApproved.forEach((inv) =>
      (inv.lines || []).forEach((l) => {
        const k = String(l.quotationItemId);
        earlierByKey.set(k, (earlierByKey.get(k) || 0) + (l.receivedQuantity || 0));
        earlierFocByKey.set(k, (earlierFocByKey.get(k) || 0) + (l.focQuantity || 0));
      })
    );

    // Full category breadcrumb per line ("Network / Router / Single") — the
    // line only snapshots the leaf name.
    const categoryIds = [...new Set((invoice.lines || []).map((l) => String(l.categoryId)).filter((x) => x && x !== "null"))];
    const categories = await StockCategoryModel.find({ _id: { $in: categoryIds } }).select("path name").lean();
    const pathById = new Map(
      await Promise.all(
        categories.map(async (c) => [String(c._id), (await StockCategoryService.buildDisplayPath(c.path || "")) || c.name])
      )
    );

    const lines = (invoice.lines || []).map((l) => {
      const poLine = poLineByKey.get(String(l.quotationItemId));
      const productDef = productDefById.get(String(l.productDefinitionId));
      return {
        ...l,
        categoryPath: pathById.get(String(l.categoryId)) || l.categoryName || "",
        orderedQuantity: poLine?.quantity || 0,
        earlierReceivedQuantity: earlierByKey.get(String(l.quotationItemId)) || 0,
        earlierFocQuantity: earlierFocByKey.get(String(l.quotationItemId)) || 0,
        gstRate: poLine?.gstRate || 0,
        trackingMethod: productDef?.trackingMethod || "quantity",
        unit: productDef?.unit || null,
      };
    });

    // A partial invoice viewed whole: its serials live on its entries — gather
    // every APPROVED entry's rows onto the line (its quantities already are
    // the approved totals).
    const approvedRowsByKey = new Map();
    if (invoice.partialSubmit) {
      (invoice.entries || [])
        .filter((e) => e.status === INVOICE_ENTRY_STATUS.APPROVED)
        .sort((x, y) => x.entryNumber - y.entryNumber)
        .forEach((e) => (e.lines || []).forEach((l) => {
          const k = String(l.quotationItemId);
          approvedRowsByKey.set(k, [...(approvedRowsByKey.get(k) || []), ...(l.rows || [])]);
        }));
    }
    const viewLines = invoice.partialSubmit
      ? lines.map((l) => ({ ...l, rows: approvedRowsByKey.get(String(l.quotationItemId)) || [] }))
      : lines;

    const base = {
      ...invoice,
      poNumber: po?.poNumber || "",
      poPdfPath: po?.pdfPath || "",
      lines: viewLines,
      ...totals,
    };
    if (!entryId) return base;

    // One entry under review: its own quantities and rows, set against the
    // whole invoice and the PO.
    const entry = (invoice.entries || []).find((e) => String(e._id) === String(entryId));
    if (!entry) throw new Error("Entry not found");
    const entryByKey = new Map((entry.lines || []).map((l) => [String(l.quotationItemId), l]));
    const earlierHere = new Map();
    const earlierFocHere = new Map();
    (invoice.entries || [])
      .filter((e) => e.status === INVOICE_ENTRY_STATUS.APPROVED && String(e._id) !== String(entryId))
      .forEach((e) => (e.lines || []).forEach((l) => {
        const k = String(l.quotationItemId);
        earlierHere.set(k, (earlierHere.get(k) || 0) + (l.receivedQuantity || 0));
        earlierFocHere.set(k, (earlierFocHere.get(k) || 0) + (l.focQuantity || 0));
      }));
    // The whole bill at a glance, so an entry is never mistaken for a bill.
    const gstByKey = new Map((po?.items || []).map((it) => [String(it.quotationItemId), it.gstRate || 0]));
    const unitByKey = new Map((invoice.lines || []).map((l) => [String(l.quotationItemId), l.unitPrice || 0]));
    const entryValue = (e) =>
      round2((e.lines || []).reduce((t, l) => {
        const k = String(l.quotationItemId);
        return t + (l.receivedQuantity || 0) * (unitByKey.get(k) || 0) * (1 + (gstByKey.get(k) || 0) / 100);
      }, 0));
    const sumQty = (e, f) => (e.lines || []).reduce((t, l) => t + (l[f] || 0), 0);
    const glance = {
      invoiceQty: (invoice.lines || []).reduce((t, l) => t + (l.invoiceQuantity || 0), 0),
      // A partial invoice's lines carry what its approved entries brought in.
      approvedQty: (invoice.lines || []).reduce((t, l) => t + (l.receivedQuantity || 0), 0),
      thisQty: sumQty(entry, "receivedQuantity"),
      thisFoc: sumQty(entry, "focQuantity"),
      thisValue: entryValue(entry),
      // Approving the first entry is what puts the whole bill in the ledger.
      firstApproval: !invoice.inLedger,
      entries: (invoice.entries || [])
        .filter((e) => e.status !== INVOICE_ENTRY_STATUS.DRAFT)
        .sort((a, b) => a.entryNumber - b.entryNumber)
        .map((e) => ({ _id: e._id, entryNumber: e.entryNumber, status: e.status, qty: sumQty(e, "receivedQuantity"), foc: sumQty(e, "focQuantity") })),
    };

    return {
      ...base,
      entry: { ...entry, lines: undefined },
      glance,
      // Every product on the invoice — the review's Invoice Details lists the
      // whole bill, while `lines` below is just this entry.
      invoiceLines: lines,
      status: entry.status,
      rejectedReason: entry.rejectedReason,
      reviewedByName: entry.reviewedByName,
      lines: lines
        .filter((l) => entryByKey.has(String(l.quotationItemId)))
        .map((l) => {
          const el = entryByKey.get(String(l.quotationItemId));
          return {
            ...l,
            // "Earlier" stays OTHER invoices; this invoice's own approved
            // entries are their own figure, so the two never blur.
            approvedEarlierQuantity: earlierHere.get(String(l.quotationItemId)) || 0,
            approvedEarlierFocQuantity: earlierFocHere.get(String(l.quotationItemId)) || 0,
            leftOnInvoiceQuantity: Math.max(
              0,
              (l.invoiceQuantity || 0) - (earlierHere.get(String(l.quotationItemId)) || 0) - (el.receivedQuantity || 0)
            ),
            receivedQuantity: el.receivedQuantity || 0,
            focQuantity: el.focQuantity || 0,
            rows: el.rows || [],
          };
        }),
    };
  }

  // Serves both the Tracking Order card's invoice table (pass trackingOrderId,
  // no status tab) and the Invoice Approval page (status tab + filters).
  static async getBoard(query = {}, dataAccess) {
    const { trackingOrderId, status, search, vendorId, categoryId, productId, dateFrom, dateTo } = query;

    const filter = { isActive: true };
    if (trackingOrderId) filter.trackingOrderId = trackingOrderId;
    if (vendorId) filter.vendorId = vendorId;
    if (categoryId) filter["lines.categoryId"] = categoryId;
    if (productId) filter["lines.productDefinitionId"] = productId;
    
    applyDataScope(filter, dataAccess, SCOPE_MODULE_KEY);
    if (dateFrom || dateTo) {
      filter.invoiceDate = {};
      if (dateFrom) filter.invoiceDate.$gte = new Date(dateFrom);
      if (dateTo) filter.invoiceDate.$lte = new Date(dateTo + "T23:59:59");
    }
    if (search) {
      const t = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(t, "i");
      filter.$or = [{ invoiceNumber: regex }, { vendorName: regex }, { "lines.productName": regex }];
    }

    const loaded = await StockInvoiceModel.find(filter).sort({ createdAt: -1 }).lean();

    /*
      The Invoice Approval page (view=approval) lists one row per INVOICE —
      a partial-submit invoice's entries live inside its row, so one bill is
      never shown as several. Its tab comes from what needs doing:
        PENDING  — the invoice, or any entry of it, awaits a decision
        REJECTED — sent back and not corrected yet
        APPROVED — fully approved, or a partial invoice with approved entries
                   and nothing waiting (shown "In progress · 47%")
      The Tracking card lists invoices as they are.
    */
    const approvalView = query.view === "approval";
    const decidable = [INVOICE_STATUS.PENDING, INVOICE_STATUS.APPROVED, INVOICE_STATUS.REJECTED];
    const approvalTabOf = (inv) => {
      if (!inv.partialSubmit) return decidable.includes(inv.status) ? inv.status : null;
      const seen = new Set((inv.entries || []).map((e) => e.status));
      if (seen.has(INVOICE_ENTRY_STATUS.PENDING)) return INVOICE_STATUS.PENDING;
      if (seen.has(INVOICE_ENTRY_STATUS.REJECTED)) return INVOICE_STATUS.REJECTED;
      if (seen.has(INVOICE_ENTRY_STATUS.APPROVED)) return INVOICE_STATUS.APPROVED;
      return null; // only a draft so far — nothing to decide yet
    };
    const allRows = !approvalView
      ? loaded
      : loaded.map((inv) => ({ ...inv, approvalTab: approvalTabOf(inv) })).filter((inv) => inv.approvalTab);
    const tabOf = (r) => (approvalView ? r.approvalTab : r.status);

    // Counted off the rows already loaded: an aggregate $match would not cast
    // the id filters (trackingOrderId, vendorId …) and silently count 0.
    const countMap = { ALL: 0, ADDED: 0, DRAFT: 0, PENDING: 0, IN_PROGRESS: 0, APPROVED: 0, REJECTED: 0 };
    allRows.forEach((r) => {
      if (countMap[tabOf(r)] !== undefined) countMap[tabOf(r)] += 1;
      countMap.ALL += 1;
    });

    const filteredRows = status ? allRows.filter((r) => tabOf(r) === status) : allRows;

    const { skip, limit, page } = paginate(query);
    const total = filteredRows.length;
    const pageSlice = filteredRows.slice(skip, skip + limit);

    // poNumber/orderedQty/GST aren't snapshotted on the invoice — resolve them
    // for just this page's rows (display-only, read path, no schema change).
    const poIds = [...new Set(pageSlice.map((inv) => String(inv.poId)).filter(Boolean))];
    const pos = await StockPurchaseOrderModel.find({ _id: { $in: poIds } })
      .select("poNumber taxType items.quantity items.quotationItemId items.gstRate")
      .lean();
    const poById = new Map(pos.map((po) => [String(po._id), po]));

    // trackingMethod/unit aren't snapshotted on the invoice line either —
    // resolve them the same way getInvoiceById does, so the board can show
    // the actual saved unit next to every quantity without a schema change.
    const productDefIds = [
      ...new Set(pageSlice.flatMap((inv) => (inv.lines || []).map((l) => String(l.productDefinitionId)))),
    ];
    const productDefs = await StockProductDefinitionModel.find({ _id: { $in: productDefIds } })
      .select("trackingMethod unit")
      .lean();
    const productDefById = new Map(productDefs.map((p) => [String(p._id), p]));

    // Full category breadcrumb per line ("Network / Router / Single") — the
    // invoice line only snapshots the leaf.
    const boardCategoryIds = [
      ...new Set(pageSlice.flatMap((inv) => (inv.lines || []).map((l) => String(l.categoryId))).filter((x) => x && x !== "null")),
    ];
    const boardCategories = await StockCategoryModel.find({ _id: { $in: boardCategoryIds } }).select("path name").lean();
    const boardPathById = new Map(
      await Promise.all(
        boardCategories.map(async (c) => [String(c._id), (await StockCategoryService.buildDisplayPath(c.path || "")) || c.name])
      )
    );

    const paged = pageSlice.map((inv) => {
      const po = poById.get(String(inv.poId));
      const lines = (inv.lines || []).map((l) => {
        const pd = productDefById.get(String(l.productDefinitionId));
        return {
          ...l,
          categoryPath: boardPathById.get(String(l.categoryId)) || l.categoryName || "",
          trackingMethod: pd?.trackingMethod || "quantity",
          unit: pd?.unit || null,
        };
      });
      // Partial submit: how much each product's entries hold, so the card can
      // say what is approved, waiting, in the draft, and still to enter.
      const held = inv.partialSubmit ? StockInvoiceService._entryQtyByLine(inv, { withDraft: true }) : null;
      const pending = inv.partialSubmit
        ? (inv.entries || []).filter((e) => e.status === INVOICE_ENTRY_STATUS.PENDING)
            .reduce((s, e) => s + (e.lines || []).reduce((t, l) => t + (l.receivedQuantity || 0), 0), 0)
        : 0;
      const draft = (inv.entries || []).find((e) => e.status === INVOICE_ENTRY_STATUS.DRAFT);
      // An entry's worth at PO rates (+GST) — its share of the bill.
      const gstByKey = new Map((po?.items || []).map((it) => [String(it.quotationItemId), it.gstRate || 0]));
      const unitByKey = new Map((inv.lines || []).map((l) => [String(l.quotationItemId), l.unitPrice || 0]));
      const entryValue = (e) =>
        round2((e.lines || []).reduce((t, l) => {
          const k = String(l.quotationItemId);
          return t + (l.receivedQuantity || 0) * (unitByKey.get(k) || 0) * (1 + (gstByKey.get(k) || 0) / 100);
        }, 0));
      const firstWith = (st) => (inv.entries || []).filter((e) => e.status === st).sort((x, y) => x.entryNumber - y.entryNumber)[0];
      const pendingEntry = firstWith(INVOICE_ENTRY_STATUS.PENDING);
      const rejectedEntry = firstWith(INVOICE_ENTRY_STATUS.REJECTED);
      const invoicedTotal = (inv.lines || []).reduce((t, l) => t + (l.invoiceQuantity || 0), 0);
      const approvedTotal = (inv.lines || []).reduce(
        (t, l) => t + (inv.partialSubmit || inv.status === INVOICE_STATUS.APPROVED ? l.receivedQuantity || 0 : 0), 0
      );
      return {
        ...inv,
        lines,
        entries: (inv.entries || []).map((e) => ({
          _id: e._id,
          entryNumber: e.entryNumber,
          status: e.status,
          submittedAt: e.submittedAt,
          submittedByName: e.submittedByName,
          updatedAt: e.updatedAt,
          rejectedReason: e.rejectedReason,
          reviewedByName: e.reviewedByName,
          qty: (e.lines || []).reduce((t, l) => t + (l.receivedQuantity || 0), 0),
          focQty: (e.lines || []).reduce((t, l) => t + (l.focQuantity || 0), 0),
          items: (e.lines || []).map((l) => `${l.productName} ${l.receivedQuantity || 0}`).join(", "),
          value: entryValue(e),
          // Per product, for the entry cards.
          lines: (e.lines || []).map((l) => ({
            quotationItemId: l.quotationItemId,
            productName: l.productName,
            receivedQuantity: l.receivedQuantity || 0,
            focQuantity: l.focQuantity || 0,
          })),
        })),
        qtyPendingApproval: pending,
        pendingEntryCount: (inv.entries || []).filter((e) => e.status === INVOICE_ENTRY_STATUS.PENDING).length,
        pendingEntry: pendingEntry ? { _id: pendingEntry._id, entryNumber: pendingEntry.entryNumber } : null,
        rejectedEntry: rejectedEntry ? { _id: rejectedEntry._id, entryNumber: rejectedEntry.entryNumber } : null,
        // Partial invoices: how much of the bill is approved, in percent.
        progressPct: invoicedTotal > 0 ? Math.round((approvedTotal / invoicedTotal) * 100) : 0,
        qtyDraft: draft ? (draft.lines || []).reduce((t, l) => t + (l.receivedQuantity || 0), 0) : 0,
        hasDraftEntry: !!draft,
        // Units still free to enter on this invoice (partial submit).
        qtyLeftToEnter: held
          ? (inv.lines || []).reduce((t, l) => t + Math.max(0, (l.invoiceQuantity || 0) - (held.get(String(l.quotationItemId))?.qty || 0)), 0)
          : null,
        poNumber: po?.poNumber || "",
        orderedQty: (po?.items || []).reduce((s, it) => s + (it.quantity || 0), 0),
        itemsSummary: lines.map((l) => l.productName).join(", "),
        qtyInvoiced: lines.reduce((s, l) => s + (l.invoiceQuantity || 0), 0),
        qtyReceived: inv.partialSubmit
          ? (inv.lines || []).reduce((s, l) => s + (held.get(String(l.quotationItemId))?.qty || 0), 0)
          : lines.reduce((s, l) => s + (l.receivedQuantity || 0), 0),
        qtyApproved: approvedTotal,
        focQtyReceived: lines.reduce((s, l) => s + (l.focQuantity || 0), 0),
        // Priced on the invoice's quantities (what the vendor billed) …
        ...StockInvoiceService._computeInvoiceTotals(inv, po),
        // … and on what has been entered so far, for the ⓘ breakup.
        atEntered: StockInvoiceService._computeInvoiceTotals(inv, po, (l) => {
          if (!inv.partialSubmit) return l.receivedQuantity || 0;
          return held.get(String(l.quotationItemId))?.qty || 0;
        }),
      };
    });

    return {
      data: { rows: paged, counts: countMap },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }
}
