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
import StockVendorModel from "../models/stock.vendor.model.js";
import StockQuotationModel from "../models/stock.quotation.model.js";
import StockItemIdentityService from "./stock.item.identity.service.js";
import StockItemMovementService from "./stock.item.movement.service.js";
import StockInvoiceScanService from "./stock.invoice.scan.service.js";
import { warrantyEndDate } from "../helpers/stock.warranty.helper.js";
import { buildInvoiceSerialTemplate, readInvoiceSerialSheet } from "../helpers/stock.invoice.serial.excel.helper.js";

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
  ITEM_APPROVAL_STATUS,
  TRACKING_STATUS,
  TRACKING_METHODS,
  ITEM_SOURCE,
  ITEM_CONDITION,
  ITEM_MOVEMENT_REF,
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
  TRACKING_STATUS.AWAITING_DELIVERY,
  TRACKING_STATUS.PARTLY_RECEIVED,
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
      const entered = prev?.receivedQuantity ?? 0;
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
    }

    // A product dropped from the invoice must have nothing entered.
    for (const [key, prev] of prevByKey) {
      const held = prev.receivedQuantity ?? 0;
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
  /*
    What every unit on this invoice is stamped with besides its fields: where
    it came from, what it cost, and its own warranty.

    Warranty months come from the quotation line the PO was raised on — the
    warranty the vendor actually quoted, vendor override included — falling
    back to the product's default for a line that has none. The clock starts on
    the invoice date.
  */
  static async _purchaseStamp(invoice, session) {
    const tracking = await StockTrackingOrderModel.findOne({ _id: invoice.trackingOrderId })
      .select("sourceQuotationId")
      .session(session)
      .lean();
    const quotation = tracking?.sourceQuotationId
      ? await StockQuotationModel.findOne({ _id: tracking.sourceQuotationId }).select("items._id items.warrantyMonths").session(session).lean()
      : null;
    const quotedMonths = new Map((quotation?.items || []).map((i) => [String(i._id), i.warrantyMonths ?? null]));
    const unitPriceByKey = new Map(invoice.lines.map((l) => [String(l.quotationItemId), l.unitPrice || 0]));

    return (line, productDef, isFoc) => {
      const months = quotedMonths.get(String(line.quotationItemId)) ?? productDef.warrantyMonths ?? null;
      return {
        source: { type: ITEM_SOURCE.PURCHASE, refId: invoice._id, refNumber: invoice.invoiceNumber },
        condition: ITEM_CONDITION.NEW,
        purchaseDate: invoice.invoiceDate,
        purchaseCost: isFoc ? 0 : unitPriceByKey.get(String(line.quotationItemId)) ?? 0,
        warranty: { startDate: invoice.invoiceDate, months, endDate: warrantyEndDate(invoice.invoiceDate, months) },
      };
    };
  }

  static async _createPendingInventoryItems(invoice, vendorId, branchId, receivedBy, session) {
    const stamp = await StockInvoiceService._purchaseStamp(invoice, session);
    const lines = invoice.lines;

    // Serial/MAC rules across the whole submission before anything is written,
    // so a clash names the row instead of failing halfway through the invoice.
    const keyedRows = [];
    const resolvedLines = [];
    for (const line of lines) {
      const productDef = await StockProductDefinitionModel.findOne({ _id: line.productDefinitionId, isActive: true })
        .session(session)
        .lean();
      if (!productDef) throw new Error(`${line.productName}: product definition not found`);
      const uniqueFields = await StockItemIdentityService.uniqueFieldsFor(productDef, session);
      resolvedLines.push({ productDef, uniqueFields });
      if (productDef.trackingMethod !== TRACKING_METHODS.INDIVIDUAL) continue;
      (line.rows || []).forEach((row, i) => {
        const where = `${line.productName} row ${i + 1}`;
        StockItemIdentityService.assertHasIdentifier(row.fieldValues, uniqueFields, `${where}: `);
        keyedRows.push({ where, keys: StockItemIdentityService.identifiersOf(row.fieldValues, uniqueFields) });
      });
    }
    const labelByCode = await StockItemIdentityService.labelByCode(session);
    StockItemIdentityService.assertNoDuplicatesWithin(keyedRows, labelByCode);
    await StockItemIdentityService.assertIdentifiersFree(keyedRows.flatMap((r) => r.keys), { session, labelByCode });

    for (const [lineIndex, line] of [...lines].entries()) {
      const { productDef, uniqueFields } = resolvedLines[lineIndex];
      const createdIds = [];

      if (productDef.trackingMethod === TRACKING_METHODS.INDIVIDUAL) {
        const docs = [];
        for (const row of line.rows) {
          await StockInventoryItemService._validateFieldValues(productDef, row.fieldValues || {});
          const keys = StockItemIdentityService.identifiersOf(row.fieldValues, uniqueFields);
          docs.push({
            productDefinitionId: line.productDefinitionId,
            vendorId,
            branchId,
            invoiceId: invoice._id,
            approvalStatus: ITEM_APPROVAL_STATUS.PENDING,
            isFoc: !!row.isFoc,
            fieldValues: row.fieldValues || {},
            identifiers: keys.length ? keys : undefined,
            quantity: null,
            receivedAt: invoice.invoiceDate,
            receivedBy: receivedBy ?? null,
            ...stamp(line, productDef, !!row.isFoc),
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
                approvalStatus: ITEM_APPROVAL_STATUS.PENDING,
                isFoc: qd.isFoc,
                fieldValues: qd.fieldValues,
                quantity: qd.quantity,
                receivedAt: invoice.invoiceDate,
                receivedBy: receivedBy ?? null,
                ...stamp(line, productDef, qd.isFoc),
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

  // Approval is when units become stock, so it is when their timeline starts.
  static async _recordReceived(invoice, itemFilter, session) {
    const items = await StockInventoryItemModel.find({ ...itemFilter, approvalStatus: ITEM_APPROVAL_STATUS.APPROVED })
      .select("productDefinitionId branchId quantity status")
      .session(session)
      .lean();
    await StockItemMovementService.recordReceived(
      items,
      { type: ITEM_MOVEMENT_REF.INVOICE, refId: invoice._id, refNumber: invoice.invoiceNumber },
      session
    );
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


  // Basic/CGST/SGST/IGST/misc/grandTotal for one invoice — shared by
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
    /*
      Misc — the invoice's extra charges (freight, handling…). Only the BILLED
      ones count; note-only charges are reported on their own so a screen can
      still show them. Misc sits OUTSIDE Billing:

        Billing     = Basic + GST                       (the goods and their tax)
        Net Payable = Billing + Misc − TDS (− debit notes)

      extraChargesTotal is the same figure under its old name, kept so nothing
      that still reads it breaks.
    */
    const miscTotal = StockInvoiceService._sumCharges(inv.extraCharges, true);
    const nonBilledChargesTotal = StockInvoiceService._sumCharges(inv.extraCharges, false);

    const grandTotal = round2(basicAmount + gstAmount);
    // TDS: on the BASIC only — not GST, not misc — at the rate the invoice
    // snapshotted when it entered the ledger (0 when it has none).
    const tdsRate = inv.tds?.rate || 0;
    const tdsAmount = round2((basicAmount * tdsRate) / 100);

    return {
      taxType, basicAmount: round2(basicAmount),
      cgstAmount: round2(cgstAmount), sgstAmount: round2(sgstAmount), igstAmount: round2(igstAmount),
      gstAmount,
      miscTotal, extraChargesTotal: miscTotal, nonBilledChargesTotal,
      // Billing: Basic + GST.
      grandTotal,
      // What the vendor's invoice says in total (Billing + Misc) — the figure
      // the "amount on invoice" is checked against.
      invoiceTotal: round2(grandTotal + miscTotal),
      tdsRate, tdsAmount,
      // Owed on the invoice itself, before any debit note.
      netTotal: round2(grandTotal + miscTotal - tdsAmount),
    };
  }

  /*
    Snapshot the VENDOR's TDS % onto the invoice — once, the first time it
    enters the ledger. Never re-read: changing the vendor's rate later must not
    move an invoice already approved. No rate on the vendor → 0%.
  */
  static async _applyTds(invoice, session) {
    if (invoice.tds?.appliedAt) return;
    let vendorId = invoice.vendorId;
    if (!vendorId && invoice.poId) {
      const po = await StockPurchaseOrderModel.findOne({ _id: invoice.poId }).select("vendorId").session(session ?? null).lean();
      vendorId = po?.vendorId || null;
    }
    const vendor = vendorId
      ? await StockVendorModel.findOne({ _id: vendorId }).select("tdsRate").session(session ?? null).lean()
      : null;
    invoice.tds = {
      rate: vendor?.tdsRate || 0,
      note: vendor?.tdsRate ? "From the vendor's TDS %" : "",
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
    What the uploaded invoice says — read by Claude (stock.invoice.scan.service.js)
    against this PO's products and what is still uninvoiced on each. The
    screen treats the result as a suggestion to check and correct.
  */
  static async readInvoiceFile(trackingOrderId, file, user, dataAccess) {
    if (!file?.buffer?.length) throw new Error("Invoice file is required");
    const tracking = await StockTrackingOrderModel.findOne({ _id: trackingOrderId, isActive: true }).lean();
    if (!tracking || !isWithinDataScope(tracking, dataAccess, "tracking-orders")) {
      throw new Error("Tracking order not found");
    }
    const po = await StockPurchaseOrderModel.findOne({ _id: tracking.poId, isActive: true }).lean();
    if (!po) throw new Error("Purchase order not found for this tracking order");

    const [invoiced, vendor] = await Promise.all([
      StockInvoiceService._invoicedQtyByLine(trackingOrderId, null),
      po.vendorId ? StockVendorModel.findById(po.vendorId).select("name gst.gstNumber").lean() : null,
    ]);
    const poItems = (po.items || []).map((it) => ({
      quotationItemId: it.quotationItemId,
      productName: it.productName,
      unit: it.unit || "",
      remaining: Math.max(0, (it.quantity || 0) - (invoiced.get(String(it.quotationItemId)) || 0)),
      unitPrice: it.unitPrice || 0,
      gstRate: it.gstRate || 0,
    }));
    return StockInvoiceScanService.scan(
      file,
      poItems,
      { name: vendor?.name || po.vendorName || "", gstin: vendor?.gst?.gstNumber || "" },
      { trackingOrderId, user }
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Add Invoice — upload, check the details, save (status UPLOADED)         */
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
          status: INVOICE_STATUS.UPLOADED,
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
    const editable = [INVOICE_STATUS.UPLOADED, INVOICE_STATUS.DRAFT, INVOICE_STATUS.REJECTED];
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
    } else if (invoice.status === INVOICE_STATUS.UPLOADED) {
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
      const nextLines = StockInvoiceService._resolveInvoiceLines(po, body.lines, invoiced, prevLines);
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
    if (invoice.status === INVOICE_STATUS.APPROVED) {
      throw new Error("An approved invoice can't be deleted");
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
  /* Approve / Reject                                                        */
  /* ---------------------------------------------------------------------- */

  static async approveInvoice(id, user, session, dataAccess) {
    const invoice = await StockInvoiceModel.findOne({ _id: id, isActive: true }).session(session);
    if (!invoice) throw new Error("Invoice not found");
    assertDataScope(invoice, dataAccess);
    if (invoice.status !== INVOICE_STATUS.PENDING) {
      throw new Error("Only a pending invoice can be approved");
    }
    const before = invoice.toObject();

    const tracking = await StockTrackingOrderModel.findOne({ _id: invoice.trackingOrderId }).session(
      session
    );

    invoice.status = INVOICE_STATUS.APPROVED;
    await StockInvoiceService._applyTds(invoice, session);
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
    await StockInvoiceService._recordReceived(invoice, { invoiceId: invoice._id }, session);

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

    // A rejected receipt was never stock: its serials go back to being free,
    // so the corrected resubmission can carry them.
    await StockInventoryItemModel.updateMany(
      { invoiceId: invoice._id },
      { $set: { approvalStatus: ITEM_APPROVAL_STATUS.REJECTED }, $unset: { identifiers: 1 } },
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

  /* ---------------------------------------------------------------------- */
  /* Add Serial / Qty → Excel (individual-tracked products only)             */
  /* ---------------------------------------------------------------------- */

  // The invoice, its line for this product, and the product's tracked fields.
  static async _serialContext(invoiceId, productId, dataAccess) {
    const invoice = await StockInvoiceModel.findOne({ _id: invoiceId, isActive: true }).lean();
    if (!invoice) throw new Error("Invoice not found");
    assertDataScope(invoice, dataAccess);

    const line = (invoice.lines || []).find((l) => String(l.productDefinitionId) === String(productId));
    if (!line) throw new Error("Invalid product: it is not on this invoice");

    const def = await StockProductDefinitionModel.findOne({ _id: productId, isActive: true })
      .populate({ path: "selectedFields.fieldDefId", select: "code label isUnique isActive" })
      .lean();
    if (!def) throw new Error("Product definition not found");
    if (def.trackingMethod !== TRACKING_METHODS.INDIVIDUAL) {
      throw new Error("Invalid product: Excel upload is only for products tracked one unit at a time");
    }
    const fields = [...(def.selectedFields || [])]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .filter((sf) => sf.fieldDefId && sf.fieldDefId.isActive !== false)
      .map((sf) => ({
        code: sf.fieldDefId.code,
        label: sf.fieldDefId.label,
        required: !!sf.isRequired,
        isUnique: !!sf.fieldDefId.isUnique,
      }));
    if (!fields.length) throw new Error("Invalid product: it has no tracked fields to fill from Excel");

    const left = Math.max(0, (line.invoiceQuantity || 0) - (line.receivedQuantity || 0));
    return { invoice, line, def, fields, left };
  }

  static async buildSerialTemplate(invoiceId, productId, dataAccess) {
    const { invoice, def, fields, left } = await StockInvoiceService._serialContext(invoiceId, productId, dataAccess);
    const buffer = await buildInvoiceSerialTemplate({ invoice, product: def, fields, left });
    const safe = def.name.replace(/[^\w.-]+/g, "_").slice(0, 60);
    return { buffer, filename: `${safe}_serials.xlsx` };
  }

  /*
    Reads a filled serial template WITHOUT saving anything. Every row comes
    back with its problems (required field empty, no unique value, repeated in
    the file, already in stock); the screen previews them, drops what clashes
    with rows already typed in, caps at what is left, and adds the good ones.
  */
  static async parseSerialUpload(invoiceId, productId, file, dataAccess) {
    if (!file?.buffer) throw new Error("Upload the filled serial template");
    const sheet = await readInvoiceSerialSheet(file.buffer);
    const { fields, left } = await StockInvoiceService._serialContext(invoiceId, productId, dataAccess);
    if (sheet.invoiceId !== String(invoiceId)) throw new Error("Invalid file: this template was downloaded for a different invoice");
    if (sheet.productId !== String(productId)) throw new Error("Invalid file: this template is for a different product");
    if (!sheet.rows.length) throw new Error("Invalid file: it has no filled rows");

    const uniqueFields = fields.filter((f) => f.isUnique);
    const labelByCode = new Map(fields.map((f) => [f.code, f.label]));
    const firstRowOf = new Map();
    const rows = sheet.rows.map(({ rowNumber, values }) => {
      const fieldValues = {};
      fields.forEach((f) => {
        if (values[f.code] !== null && values[f.code] !== undefined) fieldValues[f.code] = values[f.code];
      });
      const errors = fields.filter((f) => f.required && !fieldValues[f.code]).map((f) => `${f.label} is required`);
      const keys = StockItemIdentityService.identifiersOf(fieldValues, uniqueFields);
      if (uniqueFields.length && !keys.length) errors.push(`${uniqueFields.map((f) => f.label).join(" or ")} is required`);
      keys.forEach((k) => {
        const code = k.slice(0, k.indexOf(":"));
        const value = k.slice(k.indexOf(":") + 1);
        if (firstRowOf.has(k)) errors.push(`${labelByCode.get(code) || code} "${value}" repeats row ${firstRowOf.get(k)}`);
        else firstRowOf.set(k, rowNumber);
      });
      return { rowNumber, fieldValues, keys, errors };
    });

    const allKeys = [...firstRowOf.keys()];
    if (allKeys.length) {
      const clashes = await StockInventoryItemModel.find({ identifiers: { $in: allKeys } })
        .select("identifiers branchId")
        .populate({ path: "branchId", select: "name" })
        .lean();
      const whereByKey = new Map();
      clashes.forEach((it) => (it.identifiers || []).forEach((k) => whereByKey.set(k, it.branchId?.name || "")));
      rows.forEach((r) =>
        r.keys.forEach((k) => {
          if (!whereByKey.has(k)) return;
          const code = k.slice(0, k.indexOf(":"));
          const at = whereByKey.get(k);
          r.errors.push(`${labelByCode.get(code) || code} "${k.slice(k.indexOf(":") + 1)}" already exists in stock${at ? ` (${at})` : ""}`);
        })
      );
    }

    return {
      fields,
      left,
      rows: rows.map(({ rowNumber, fieldValues, errors }) => ({ rowNumber, fieldValues, errors })),
    };
  }

  // Enriched with read-only, non-snapshotted display data (PO number/tax
  // type/pdf, per-line GST rate, product tracking method) for the Invoice
  // Approval "Review" full page — same "resolve at read-time, no schema
  // change" posture as getBoard's poNumber/orderedQty.
  static async getInvoiceById(id, dataAccess) {
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

    // The OTHER approved invoices of this order, oldest first, so the reviewer
    // sees PO qty / each earlier invoice / this invoice side by side.
    const otherApproved = await StockInvoiceModel.find({
      trackingOrderId: invoice.trackingOrderId,
      _id: { $ne: invoice._id },
      status: INVOICE_STATUS.APPROVED,
      isActive: true,
    })
      .sort({ invoiceDate: 1, createdAt: 1 })
      .select("invoiceNumber invoiceDate lines.quotationItemId lines.receivedQuantity lines.focQuantity")
      .lean();
    const earlierInvoices = otherApproved.map((inv) => ({
      _id: inv._id,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
    }));
    // quotationItemId → [{ invoiceId, quantity, focQuantity }] in the same order.
    const earlierByKey = new Map();
    otherApproved.forEach((inv) =>
      (inv.lines || []).forEach((l) => {
        const k = String(l.quotationItemId);
        if (!(l.receivedQuantity || l.focQuantity)) return;
        earlierByKey.set(k, [
          ...(earlierByKey.get(k) || []),
          { invoiceId: inv._id, quantity: l.receivedQuantity || 0, focQuantity: l.focQuantity || 0 },
        ]);
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
        earlierInvoices: earlierByKey.get(String(l.quotationItemId)) || [],
        gstRate: poLine?.gstRate || 0,
        trackingMethod: productDef?.trackingMethod || "quantity",
        unit: productDef?.unit || null,
      };
    });

    return {
      ...invoice,
      poNumber: po?.poNumber || "",
      poPdfPath: po?.pdfPath || "",
      earlierInvoices,
      lines,
      ...totals,
    };
  }

  // Serves both the Tracking Order card's invoice table (pass trackingOrderId,
  // no status tab) and the Invoice Approval page (status tab + filters).
  static async getBoard(query = {}, dataAccess) {
    const { trackingOrderId, status, search, vendorId, categoryId, productId, dateFrom, dateTo, branchId, entityAlias } = query;

    const filter = { isActive: true };
    if (trackingOrderId) filter.trackingOrderId = trackingOrderId;
    if (vendorId) filter.vendorId = vendorId;
    if (categoryId) filter["lines.categoryId"] = categoryId;
    if (productId) filter["lines.productDefinitionId"] = productId;
    // The receiving branch, and the buying entity (alias — every state of it).
    if (branchId) filter.branchId = branchId;
    if (entityAlias) filter.entityAlias = String(entityAlias).toUpperCase();

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
      The Invoice Approval page (view=approval) lists only invoices with a
      decision to make or made — Pending, Approved, Rejected. Uploaded and
      Draft invoices are still being entered. The Tracking card lists them all.
    */
    const decidable = [INVOICE_STATUS.PENDING, INVOICE_STATUS.APPROVED, INVOICE_STATUS.REJECTED];
    const allRows = query.view === "approval" ? loaded.filter((inv) => decidable.includes(inv.status)) : loaded;

    // Counted off the rows already loaded: an aggregate $match would not cast
    // the id filters (trackingOrderId, vendorId …) and silently count 0.
    const countMap = { ALL: 0, UPLOADED: 0, DRAFT: 0, PENDING: 0, APPROVED: 0, REJECTED: 0 };
    allRows.forEach((r) => {
      if (countMap[r.status] !== undefined) countMap[r.status] += 1;
      countMap.ALL += 1;
    });

    const filteredRows = status ? allRows.filter((r) => r.status === status) : allRows;

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
      const qtyReceived = lines.reduce((s, l) => s + (l.receivedQuantity || 0), 0);
      return {
        ...inv,
        lines,
        poNumber: po?.poNumber || "",
        orderedQty: (po?.items || []).reduce((s, it) => s + (it.quantity || 0), 0),
        itemsSummary: lines.map((l) => l.productName).join(", "),
        qtyInvoiced: lines.reduce((s, l) => s + (l.invoiceQuantity || 0), 0),
        qtyReceived,
        qtyApproved: inv.status === INVOICE_STATUS.APPROVED ? qtyReceived : 0,
        focQtyReceived: lines.reduce((s, l) => s + (l.focQuantity || 0), 0),
        // Priced on the invoice's quantities (what the vendor billed) …
        ...StockInvoiceService._computeInvoiceTotals(inv, po),
        // … and on what has been entered so far, for the ⓘ breakup.
        atEntered: StockInvoiceService._computeInvoiceTotals(inv, po, (l) => l.receivedQuantity || 0),
      };
    });

    return {
      data: { rows: paged, counts: countMap },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }
}
