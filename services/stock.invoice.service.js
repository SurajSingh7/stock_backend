import StockInvoiceModel from "../models/stock.invoice.model.js";
import StockTrackingOrderModel from "../models/stock.tracking.order.model.js";
import StockPurchaseOrderModel from "../models/stock.purchase.order.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import StockVendorReviewModel from "../models/stock.vendor.review.model.js";
import StockVendorPurchaseHistoryModel from "../models/stock.vendor.purchase.history.model.js";
import StockInventoryItemService from "./stock.inventory.item.service.js";
import StockTrackingOrderService from "./stock.tracking.order.service.js";

import { paginate } from "../helpers/pagination.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import {
  INVOICE_STATUS,
  ITEM_APPROVAL_STATUS,
  TRACKING_STATUS,
  TRACKING_METHODS,
} from "../constants/stock.enums.js";

const log = getLogger(import.meta.url);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const RECEIVABLE_TRACKING_STATUSES = new Set([
  TRACKING_STATUS.PO_SENT,
  TRACKING_STATUS.IN_PROGRESS,
  TRACKING_STATUS.PARTIAL,
]);

export default class StockInvoiceService {
  /* ---------------------------------------------------------------------- */
  /* Over-receipt guard — sums receivedQuantity across all non-REJECTED      */
  /* invoices for this tracking order, per PO line (quotationItemId).        */
  /* REJECTED invoices never count, so a resubmit re-validates against       */
  /* only the still-live invoices.                                          */
  /* ---------------------------------------------------------------------- */

  static async _sumNonRejectedQtyByLine(trackingOrderId, session, excludeInvoiceId = null) {
    const filter = {
      trackingOrderId,
      isActive: true,
      status: { $ne: INVOICE_STATUS.REJECTED },
    };
    if (excludeInvoiceId) filter._id = { $ne: excludeInvoiceId };

    const invoices = await StockInvoiceModel.find(filter).session(session).lean();
    const map = new Map();
    invoices.forEach((inv) =>
      (inv.lines || []).forEach((l) => {
        const key = String(l.quotationItemId);
        map.set(key, (map.get(key) || 0) + (l.receivedQuantity || 0));
      })
    );
    return map;
  }

  // Validates each requested line against the PO line's ordered quantity and
  // returns the resolved (snapshotted) line data ready to persist. Throws on
  // any over-receipt or unknown quotationItemId.
  static async _resolveLines(po, bodyLines, existingQtyByLine) {
    const poLineByKey = new Map((po.items || []).map((it) => [String(it.quotationItemId), it]));

    return bodyLines.map((bl) => {
      const key = String(bl.quotationItemId);
      const poLine = poLineByKey.get(key);
      if (!poLine) throw new Error("A received line does not belong to this purchase order");

      const already = existingQtyByLine.get(key) || 0;
      const requested = Number(bl.receivedQuantity) || 0;
      if (already + requested > poLine.quantity) {
        throw new Error(
          `${poLine.productName}: received quantity (${already + requested}) exceeds ordered quantity (${poLine.quantity})`
        );
      }

      return {
        quotationItemId: poLine.quotationItemId,
        categoryId: poLine.categoryId,
        categoryName: poLine.categoryName,
        productDefinitionId: poLine.productDefinitionId,
        productName: poLine.productName,
        unitPrice: poLine.unitPrice,
        receivedQuantity: requested,
        // Free-of-cost — never validated against poLine.quantity above.
        focQuantity: Math.max(0, Number(bl.focQuantity) || 0),
        rows: Array.isArray(bl.rows)
          ? bl.rows.map((r) => ({ fieldValues: r.fieldValues || {}, isFoc: !!r.isFoc }))
          : [],
        rating:
          bl.rating && (bl.rating.rating !== undefined || bl.rating.notes !== undefined)
            ? { rating: bl.rating.rating ?? null, notes: bl.rating.notes || "" }
            : null,
        createdInventoryItemIds: [],
      };
    });
  }

  // Creates inventory_items (PENDING approval) for every line — one row per
  // generated Serial/MAC entry for individual-tracked products, one
  // aggregated doc for quantity-tracked products. Mutates each line in place
  // to record the created ids.
  static async _createPendingInventoryItems(invoice, vendorId, warehouseId, receivedBy, session) {
    for (const line of invoice.lines) {
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
            warehouseId,
            invoiceId: invoice._id,
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
        const qtyDocs = [];
        if (line.receivedQuantity > 0) {
          qtyDocs.push({ quantity: line.receivedQuantity, isFoc: false });
        }
        if (line.focQuantity > 0) {
          qtyDocs.push({ quantity: line.focQuantity, isFoc: true });
        }
        for (const qd of qtyDocs) {
          const [created] = await StockInventoryItemModel.create(
            [
              {
                productDefinitionId: line.productDefinitionId,
                vendorId,
                warehouseId,
                invoiceId: invoice._id,
                approvalStatus: ITEM_APPROVAL_STATUS.PENDING,
                isFoc: qd.isFoc,
                fieldValues: {},
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
              createdBy: user?.id || user?._id || null,
              createdByName: user?.name || "",
            },
          ],
          { session }
        );
      }
    }
  }

  // Basic/CGST/SGST/IGST/extraCharges/grandTotal for one invoice — shared by
  // getBoard (list rows) and getInvoiceById (Review page's Invoice Details).
  // `po` may be null (invoice without a linked PO); taxType then defaults to
  // CGST_SGST so the split still renders something sane.
  static _computeInvoiceTotals(inv, po) {
    const poLineByKey = new Map((po?.items || []).map((it) => [String(it.quotationItemId), it]));
    const taxType = po?.taxType || "CGST_SGST";

    let basicAmount = 0, cgstAmount = 0, sgstAmount = 0, igstAmount = 0;
    (inv.lines || []).forEach((l) => {
      const lineBasic = (l.receivedQuantity || 0) * (l.unitPrice || 0);
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
    const extraChargesTotal = round2((inv.extraCharges || []).reduce((s, c) => s + (c.amount || 0), 0));

    return {
      taxType, basicAmount: round2(basicAmount),
      cgstAmount: round2(cgstAmount), sgstAmount: round2(sgstAmount), igstAmount: round2(igstAmount),
      gstAmount, extraChargesTotal, grandTotal: round2((inv.amount || 0) + gstAmount),
    };
  }

  static _computeAmount(lines, extraCharges) {
    const linesTotal = round2(
      lines.reduce((s, l) => s + (l.receivedQuantity || 0) * (l.unitPrice || 0), 0)
    );
    const chargesTotal = round2((extraCharges || []).reduce((s, c) => s + (c.amount || 0), 0));
    return round2(linesTotal + chargesTotal);
  }

  /* ---------------------------------------------------------------------- */
  /* Create — "Add Items" submit                                             */
  /* ---------------------------------------------------------------------- */

  static async createInvoice(trackingOrderId, body, user, session) {
    const tracking = await StockTrackingOrderModel.findOne({
      _id: trackingOrderId,
      isActive: true,
    }).session(session);
    if (!tracking) throw new Error("Tracking order not found");
    if (!RECEIVABLE_TRACKING_STATUSES.has(tracking.status)) {
      throw new Error("Items can only be added while this order is PO Sent, In Progress or Partial");
    }

    const po = await StockPurchaseOrderModel.findOne({ _id: tracking.poId, isActive: true })
      .session(session)
      .lean();
    if (!po) throw new Error("Purchase order not found for this tracking order");

    const existingQtyByLine = await StockInvoiceService._sumNonRejectedQtyByLine(
      trackingOrderId,
      session
    );
    const lines = await StockInvoiceService._resolveLines(po, body.lines, existingQtyByLine);

    const [invoice] = await StockInvoiceModel.create(
      [
        {
          trackingOrderId,
          poId: po._id,
          vendorId: po.vendorId,
          vendorName: po.vendorName || "",
          invoiceNumber: String(body.invoiceNumber).trim(),
          invoiceDate: body.invoiceDate,
          invoiceFile: body.invoiceFile || "",
          warehouseId: body.warehouseId || null,
          receivedByName: body.receivedByName || user?.name || "",
          extraCharges: body.extraCharges || [],
          lines,
          amount: StockInvoiceService._computeAmount(lines, body.extraCharges),
          status: INVOICE_STATUS.PENDING,
          createdBy: user?.id || user?._id || null,
          createdByName: user?.name || "",
        },
      ],
      { session }
    );

    await StockInvoiceService._createPendingInventoryItems(
      invoice,
      po.vendorId,
      body.warehouseId || null,
      user?.id || user?._id || null,
      session
    );
    await StockInvoiceService._writeRatings(invoice, po.vendorId, user, session);
    await invoice.save({ session });

    await StockTrackingOrderService.recalculateStatus(trackingOrderId, session);

    log.info(`Invoice created: ${invoice.invoiceNumber} for tracking order ${trackingOrderId}`);
    return invoice;
  }

  /* ---------------------------------------------------------------------- */
  /* Edit + resubmit — REJECTED only                                         */
  /* ---------------------------------------------------------------------- */

  static async updateInvoice(id, body, user, session) {
    const invoice = await StockInvoiceModel.findOne({ _id: id, isActive: true }).session(session);
    if (!invoice) throw new Error("Invoice not found");
    if (invoice.status !== INVOICE_STATUS.REJECTED) {
      throw new Error("Only a rejected invoice can be edited");
    }

    const po = await StockPurchaseOrderModel.findOne({ _id: invoice.poId, isActive: true })
      .session(session)
      .lean();
    if (!po) throw new Error("Purchase order not found for this invoice");

    // The old (rejected) inventory_items were never real stock — safe to
    // hard-delete and recreate from the edited rows.
    const oldItemIds = invoice.lines.flatMap((l) => l.createdInventoryItemIds || []);
    if (oldItemIds.length) {
      await StockInventoryItemModel.deleteMany({ _id: { $in: oldItemIds } }, { session });
    }

    const existingQtyByLine = await StockInvoiceService._sumNonRejectedQtyByLine(
      invoice.trackingOrderId,
      session,
      invoice._id
    );
    const lines = await StockInvoiceService._resolveLines(po, body.lines, existingQtyByLine);

    if (body.invoiceNumber !== undefined) invoice.invoiceNumber = String(body.invoiceNumber).trim();
    if (body.invoiceDate !== undefined) invoice.invoiceDate = body.invoiceDate;
    if (body.invoiceFile) invoice.invoiceFile = body.invoiceFile;
    if (body.warehouseId !== undefined) invoice.warehouseId = body.warehouseId;
    if (body.receivedByName !== undefined) invoice.receivedByName = body.receivedByName;
    if (body.extraCharges !== undefined) invoice.extraCharges = body.extraCharges;

    invoice.lines = lines;
    invoice.amount = StockInvoiceService._computeAmount(lines, invoice.extraCharges);
    invoice.status = INVOICE_STATUS.PENDING;
    invoice.rejectedReason = "";
    invoice.reviewedBy = null;
    invoice.reviewedByName = "";
    invoice.reviewedAt = null;

    await StockInvoiceService._createPendingInventoryItems(
      invoice,
      po.vendorId,
      invoice.warehouseId,
      user?.id || user?._id || null,
      session
    );
    await StockInvoiceService._writeRatings(invoice, po.vendorId, user, session);
    await invoice.save({ session });

    await StockTrackingOrderService.recalculateStatus(invoice.trackingOrderId, session);

    log.info(`Invoice resubmitted: ${invoice.invoiceNumber}`);
    return invoice;
  }

  /* ---------------------------------------------------------------------- */
  /* Approve / Reject                                                        */
  /* ---------------------------------------------------------------------- */

  static async approveInvoice(id, user, session) {
    const invoice = await StockInvoiceModel.findOne({ _id: id, isActive: true }).session(session);
    if (!invoice) throw new Error("Invoice not found");
    if (invoice.status !== INVOICE_STATUS.PENDING) {
      throw new Error("Only a pending invoice can be approved");
    }

    const tracking = await StockTrackingOrderModel.findOne({ _id: invoice.trackingOrderId }).session(
      session
    );

    invoice.status = INVOICE_STATUS.APPROVED;
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
            createdBy: user?.id || user?._id || null,
            createdByName: user?.name || "",
          },
        ],
        { session }
      );
    }

    await StockTrackingOrderService.recalculateStatus(invoice.trackingOrderId, session);

    log.info(`Invoice approved: ${invoice.invoiceNumber}`);
    return invoice;
  }

  static async rejectInvoice(id, reason, user, session) {
    const invoice = await StockInvoiceModel.findOne({ _id: id, isActive: true }).session(session);
    if (!invoice) throw new Error("Invoice not found");
    if (invoice.status !== INVOICE_STATUS.PENDING) {
      throw new Error("Only a pending invoice can be rejected");
    }

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
    return invoice;
  }

  /* ---------------------------------------------------------------------- */
  /* Read                                                                    */
  /* ---------------------------------------------------------------------- */

  // Enriched with read-only, non-snapshotted display data (PO number/tax
  // type/pdf, per-line GST rate, product tracking method) for the Invoice
  // Approval "Review" full page — same "resolve at read-time, no schema
  // change" posture as getBoard's poNumber/orderedQty.
  static async getInvoiceById(id) {
    const invoice = await StockInvoiceModel.findOne({ _id: id, isActive: true }).lean();
    if (!invoice) throw new Error("Invoice not found");

    const po = invoice.poId
      ? await StockPurchaseOrderModel.findOne({ _id: invoice.poId })
          .select("poNumber taxType pdfPath items.quotationItemId items.gstRate")
          .lean()
      : null;
    const poLineByKey = new Map((po?.items || []).map((it) => [String(it.quotationItemId), it]));
    const totals = StockInvoiceService._computeInvoiceTotals(invoice, po);

    const productDefIds = [...new Set((invoice.lines || []).map((l) => String(l.productDefinitionId)))];
    const productDefs = await StockProductDefinitionModel.find({ _id: { $in: productDefIds } })
      .select("trackingMethod")
      .lean();
    const productDefById = new Map(productDefs.map((p) => [String(p._id), p]));

    const lines = (invoice.lines || []).map((l) => {
      const poLine = poLineByKey.get(String(l.quotationItemId));
      const productDef = productDefById.get(String(l.productDefinitionId));
      return {
        ...l,
        gstRate: poLine?.gstRate || 0,
        trackingMethod: productDef?.trackingMethod || "quantity",
      };
    });

    return {
      ...invoice,
      poNumber: po?.poNumber || "",
      poPdfPath: po?.pdfPath || "",
      lines,
      ...totals,
    };
  }

  // Serves both the Tracking Order card's invoice table (pass trackingOrderId,
  // no status tab) and the Invoice Approval page (status tab + filters).
  static async getBoard(query = {}) {
    const { trackingOrderId, status, search, vendorId, categoryId, productId, dateFrom, dateTo } = query;

    const filter = { isActive: true };
    if (trackingOrderId) filter.trackingOrderId = trackingOrderId;
    if (vendorId) filter.vendorId = vendorId;
    if (categoryId) filter["lines.categoryId"] = categoryId;
    if (productId) filter["lines.productDefinitionId"] = productId;
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

    const [allRows, counts] = await Promise.all([
      StockInvoiceModel.find(filter).sort({ createdAt: -1 }).lean(),
      StockInvoiceModel.aggregate([{ $match: filter }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    ]);

    const countMap = { ALL: 0, PENDING: 0, APPROVED: 0, REJECTED: 0 };
    counts.forEach((c) => {
      if (countMap[c._id] !== undefined) countMap[c._id] = c.count;
      countMap.ALL += c.count;
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

    const paged = pageSlice.map((inv) => {
      const po = poById.get(String(inv.poId));
      return {
        ...inv,
        poNumber: po?.poNumber || "",
        orderedQty: (po?.items || []).reduce((s, it) => s + (it.quantity || 0), 0),
        itemsSummary: (inv.lines || []).map((l) => l.productName).join(", "),
        qtyReceived: (inv.lines || []).reduce((s, l) => s + (l.receivedQuantity || 0), 0),
        focQtyReceived: (inv.lines || []).reduce((s, l) => s + (l.focQuantity || 0), 0),
        ...StockInvoiceService._computeInvoiceTotals(inv, po),
      };
    });

    return {
      data: { rows: paged, counts: countMap },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }
}
