import StockTrackingOrderModel from "../models/stock.tracking.order.model.js";
import StockQuotationModel from "../models/stock.quotation.model.js";
import StockVendorModel from "../models/stock.vendor.model.js";
import StockPurchaseOrderModel from "../models/stock.purchase.order.model.js";
import StockInvoiceModel from "../models/stock.invoice.model.js";

import { paginate } from "../helpers/pagination.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import { QUOTATION_STATUS, TRACKING_STATUS, INVOICE_STATUS } from "../constants/stock.enums.js";
import { isWithinDataScope, resolveDimensionAllowList } from "../helpers/data.scope.helper.js";

const SCOPE_MODULE_KEY = "tracking-orders";

const log = getLogger(import.meta.url);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const ENTITY_TYPE = "tracking-orders";

export default class StockTrackingOrderService {
  /* ---------------------------------------------------------------------- */
  /* Create — one ENTITY_PENDING doc per winning vendor on a reviewed        */
  /* quotation. Called from StockQuotationService.reviewQuotation once the   */
  /* computed doc status is APPROVED / PARTIALLY_APPROVED.                   */
  /* ---------------------------------------------------------------------- */

  static async createForQuotationVendors(quotation, vendorIds, session) {
    for (const vendorId of vendorIds) {
      const exists = await StockTrackingOrderModel.findOne({
        sourceQuotationId: quotation._id,
        vendorId,
      }).session(session);
      if (exists) continue;

      await StockTrackingOrderModel.create(
        [
          {
            sourceQuotationId: quotation._id,
            vendorId,
            status: TRACKING_STATUS.ENTITY_PENDING,
          },
        ],
        { session }
      );
    }
    log.info(`Tracking orders ensured for quotation ${quotation.quotationNumber} (${vendorIds.length} vendors)`);
  }

  /* ---------------------------------------------------------------------- */
  /* Board — one entry per quotation, each with vendor sections (ALL         */
  /* tracking statuses, unlike the PO board which only shows PO_PENDING+)    */
  /* ---------------------------------------------------------------------- */

  static async getBoard(query = {}, dataAccess) {
    const { search, vendorId, status, dateFrom, dateTo } = query;

    const qFilter = {
      isActive: true,
      status: { $in: [QUOTATION_STATUS.APPROVED, QUOTATION_STATUS.PARTIALLY_APPROVED] },
    };
    
    if (query.sourceQuotationId) qFilter._id = query.sourceQuotationId;

    const quotations = await StockQuotationModel.find(qFilter)
      .select("quotationNumber items categoryApprovals updatedAt")
      .lean();

    const vendorIds = new Set();
    quotations.forEach((q) =>
      (q.categoryApprovals || [])
        .filter((c) => c.status === "APPROVED")
        .forEach((ca) => (ca.selections || []).forEach((s) => vendorIds.add(String(s.vendorId))))
    );
    const vendors = await StockVendorModel.find({ _id: { $in: [...vendorIds] } }).lean();
    const vendorMap = new Map(vendors.map((v) => [String(v._id), v]));

    const quotationIds = quotations.map((q) => q._id);
    const trackingOrders = await StockTrackingOrderModel.find({
      sourceQuotationId: { $in: quotationIds },
      isActive: true,
    }).lean();
    const trackingByKey = new Map(trackingOrders.map((t) => [`${t.sourceQuotationId}::${t.vendorId}`, t]));

    const pos = await StockPurchaseOrderModel.find({ sourceQuotationId: { $in: quotationIds }, isActive: true })
      .select("poNumber status grandTotal subTotal vendorId sourceQuotationId items createdAt poDate taxType cgstTotal sgstTotal igstTotal pdfPath")
      .lean();
    const poByKey = new Map(pos.map((po) => [`${po.sourceQuotationId}::${po.vendorId}`, po]));

    // Received qty (approved invoices only) per tracking order — powers the
    // card's Ordered/Received/Pending summary without a separate round-trip.
    const trackingIds = trackingOrders.map((t) => t._id);
    const approvedInvoices = await StockInvoiceModel.find({
      trackingOrderId: { $in: trackingIds },
      status: INVOICE_STATUS.APPROVED,
      isActive: true,
    })
      .select("trackingOrderId lines.receivedQuantity")
      .lean();
    const receivedByTracking = new Map();
    approvedInvoices.forEach((inv) => {
      const sum = (inv.lines || []).reduce((s, l) => s + (l.receivedQuantity || 0), 0);
      const key = String(inv.trackingOrderId);
      receivedByTracking.set(key, (receivedByTracking.get(key) || 0) + sum);
    });

    const fullBoard = [];
    quotations.forEach((q) => {
      const itemById = new Map((q.items || []).map((it) => [String(it._id), it]));

      let approvalDate = null;
      (q.categoryApprovals || []).forEach((ca) => {
        if (ca.decidedAt && (!approvalDate || new Date(ca.decidedAt) > new Date(approvalDate))) approvalDate = ca.decidedAt;
      });

      const byVendor = new Map();
      (q.categoryApprovals || [])
        .filter((c) => c.status === "APPROVED")
        .forEach((ca) =>
          (ca.selections || []).forEach((sel) => {
            const item = itemById.get(String(sel.itemId));
            if (!item) return;
            const vId = String(sel.vendorId);
            if (!byVendor.has(vId)) {
              const v = vendorMap.get(vId) || {};
              const primary = (v.contacts || []).find((c) => c.label === "PRIMARY") || (v.contacts || [])[0] || {};
              byVendor.set(vId, {
                vendorId: vId, vendorName: sel.vendorName || v.name || "",
                phone: primary.phone || "", email: primary.email || "",
                contactName: primary.name || "",
                stateCode: v.gst?.state?.code || v.address?.state?.code || "",
                items: [],
              });
            }
            const row = byVendor.get(vId);
            const qty = sel.quantity, price = sel.unitPrice, gstRate = sel.gstRate;
            const taxable = round2(qty * price);
            const gstAmount = round2((taxable * gstRate) / 100);
            const lineTotal = round2(taxable + gstAmount);
            row.items.push({
              quotationItemId: item._id, categoryId: ca.categoryId, categoryName: ca.categoryName,
              productDefinitionId: sel.productDefinitionId, productName: sel.productName,
              quantity: qty, unitPrice: price, gstRate, taxable, gstAmount, lineTotal,
            });
          })
        );

      const rows = [];
      byVendor.forEach((row, vId) => {
        const tracking = trackingByKey.get(`${q._id}::${vId}`);
        if (!tracking) return; // shouldn't happen — created at review time

        const po = poByKey.get(`${q._id}::${vId}`);
        let items = row.items, totalAmount, totalQuantity;

        if (po) {
          items = (po.items || []).map((it) => ({
            quotationItemId: it.quotationItemId, categoryId: it.categoryId, categoryName: it.categoryName,
            productDefinitionId: it.productDefinitionId, productName: it.productName,
            quantity: it.quantity, unitPrice: it.unitPrice, gstRate: it.gstRate,
            taxable: it.taxable, cgst: it.cgst, sgst: it.sgst, igst: it.igst,
            gstAmount: it.gstAmount, lineTotal: it.lineTotal,
          }));
          totalAmount = po.grandTotal;
          totalQuantity = items.reduce((s, i) => s + (i.quantity || 0), 0);
        } else {
          // Pre-PO (quotation-selection) items have no cgst/sgst split yet —
          // approximate as an even same-state split until a PO/entity exists.
          items = items.map((it) => ({
            ...it,
            cgst: round2((it.gstAmount || 0) / 2),
            sgst: round2((it.gstAmount || 0) / 2),
            igst: 0,
          }));
          totalAmount = round2(items.reduce((s, i) => s + (i.lineTotal || 0), 0));
          totalQuantity = items.reduce((s, i) => s + (i.quantity || 0), 0);
        }

        const receivedQuantity = receivedByTracking.get(String(tracking._id)) || 0;
        const pendingQuantity = Math.max(0, totalQuantity - receivedQuantity);
        const poDate = po?.poDate || po?.createdAt || null;
        const subTotal = po ? po.subTotal : round2(items.reduce((s, i) => s + (i.taxable || 0), 0));
        const cgstTotal = po ? po.cgstTotal : round2(items.reduce((s, i) => s + (i.cgst || 0), 0));
        const sgstTotal = po ? po.sgstTotal : round2(items.reduce((s, i) => s + (i.sgst || 0), 0));
        const igstTotal = po ? po.igstTotal : round2(items.reduce((s, i) => s + (i.igst || 0), 0));

        rows.push({
          trackingOrderId: tracking._id,
          vendorId: vId, vendorName: row.vendorName, phone: row.phone, email: row.email, contactName: row.contactName,
          vendorStateCode: row.stateCode || "",
          poId: po?._id || null, poNumber: po?.poNumber || "", poDate,
          taxType: po?.taxType || "CGST_SGST", subTotal, cgstTotal, sgstTotal,
          igstTotal, poPdfPath: po?.pdfPath || "",
          status: tracking.status,
          entityAlias: tracking.buyerEntity?.alias || "",
          entityState: tracking.buyerEntity?.state || "",
          buyerEntity: tracking.buyerEntity || {},
          items, totalAmount, totalQuantity,
          receivedQuantity, pendingQuantity,
          notRequiredReason: tracking.notRequiredReason || "",
          mailResult: tracking.mailResult || null,
          filterDate: po?.createdAt || approvalDate,
        });
      });

      if (rows.length) {
        fullBoard.push({
          sourceQuotationId: q._id, quotationNumber: q.quotationNumber,
          quotationApprovalDate: approvalDate, vendorCount: rows.length, rows,
        });
      }
    });

    fullBoard.sort((a, b) => {
      const aLatest = a.rows.reduce((m, r) => (r.filterDate && (!m || new Date(r.filterDate) > new Date(m)) ? r.filterDate : m), null);
      const bLatest = b.rows.reduce((m, r) => (r.filterDate && (!m || new Date(r.filterDate) > new Date(m)) ? r.filterDate : m), null);
      return new Date(bLatest || 0) - new Date(aLatest || 0);
    });

    const t = search ? String(search).toLowerCase().trim() : "";
    const from = dateFrom ? new Date(dateFrom) : null;
    const to = dateTo ? new Date(dateTo + "T23:59:59") : null;

    const rowPass = (row, quotationNumber, ignoreStatus) => {
      if (!ignoreStatus && status && row.status !== status) return false;
      if (vendorId && String(row.vendorId) !== String(vendorId)) return false;
      // Rows still at ENTITY_PENDING have no alias and stay visible to
      // everyone — they are precisely the ones waiting to be assigned.
      if (!isWithinDataScope({ buyerEntity: { alias: row.entityAlias } }, dataAccess, SCOPE_MODULE_KEY)) return false;
      if (t) {
        const hit =
          (quotationNumber || "").toLowerCase().includes(t) ||
          (row.poNumber || "").toLowerCase().includes(t) ||
          (row.vendorName || "").toLowerCase().includes(t) ||
          row.items.some((it) => (it.productName || "").toLowerCase().includes(t));
        if (!hit) return false;
      }
      if (from && (!row.filterDate || new Date(row.filterDate) < from)) return false;
      if (to && (!row.filterDate || new Date(row.filterDate) > to)) return false;
      return true;
    };

    // counts: every filter EXCEPT status — so each status option's count
    // reflects the current search/vendor/date filters, same pattern as the
    // PO Approval board's tab counts.
    const counts = {
      ALL: 0,
      ENTITY_PENDING: 0,
      PO_PENDING: 0,
      PO_GENERATED: 0,
      PO_APPROVED: 0,
      IN_PROGRESS: 0,
      PARTIAL: 0,
      COMPLETED: 0,
      REJECTED: 0,
      NOT_REQUIRED: 0,
    };
    fullBoard.forEach((q) =>
      q.rows.forEach((r) => {
        if (rowPass(r, q.quotationNumber, true)) {
          counts.ALL += 1;
          if (counts[r.status] !== undefined) counts[r.status] += 1;
        }
      })
    );

    const filteredBoard = fullBoard
      .map((q) => ({ ...q, rows: q.rows.filter((r) => rowPass(r, q.quotationNumber, false)) }))
      .filter((q) => q.rows.length > 0);

    const { skip, limit, page } = paginate(query);
    const total = filteredBoard.length;
    const board = filteredBoard.slice(skip, skip + limit);

    return {
      data: { board, counts },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* + Add Entity — ENTITY_PENDING → PO_PENDING                              */
  /* ---------------------------------------------------------------------- */

  static async addEntity(id, payload, actor, session, dataAccess) {
    const tracking = await StockTrackingOrderModel.findOne({ _id: id, isActive: true }).session(session);
    if (!tracking) throw new Error("Tracking order not found");
    if (tracking.status !== TRACKING_STATUS.ENTITY_PENDING) {
      throw new Error("Entity has already been assigned for this vendor");
    }

    // The record has no entity yet, so there is nothing to scope it BY — what
    // matters is the entity being assigned. Without this, an entity-restricted
    // user could assign an entity they cannot work on and immediately lose
    // sight of the row they just handled.
    const allowedAliases = resolveDimensionAllowList(dataAccess, "entity");
    const incomingAlias = String(payload.alias || "").toUpperCase();
    if (allowedAliases !== null && !allowedAliases.includes(incomingAlias)) {
      throw new Error("You are not allowed to assign this entity");
    }
    const before = tracking.toObject();

    tracking.buyerEntity = {
      entityId: payload.entityId || null,
      name: payload.name || "",
      alias: payload.alias || "",
      gstNumber: payload.gstNumber || "",
      address: payload.address || "",
      state: payload.state || "",
      stateCode: String(payload.stateCode || ""),
    };
    tracking.status = TRACKING_STATUS.PO_PENDING;
    await tracking.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: tracking._id, action: "ADD_ENTITY", actor, before, after: tracking.toObject(),
    });
    return tracking;
  }

  /* ---------------------------------------------------------------------- */
  /* Not Required                                                            */
  /* ---------------------------------------------------------------------- */

  static async markNotRequired(id, reason, actor, session, dataAccess) {
    const tracking = await StockTrackingOrderModel.findOne({ _id: id, isActive: true }).session(session);
    if (!tracking) throw new Error("Tracking order not found");
    if (!isWithinDataScope(tracking, dataAccess, SCOPE_MODULE_KEY)) {
      throw new Error("Tracking order not found");
    }
    if (![TRACKING_STATUS.ENTITY_PENDING, TRACKING_STATUS.PO_PENDING].includes(tracking.status)) {
      throw new Error("This vendor order can no longer be marked Not Required");
    }
    const before = tracking.toObject();
    tracking.status = TRACKING_STATUS.NOT_REQUIRED;
    tracking.notRequiredReason = String(reason || "").trim();
    tracking.disabledAt = new Date();
    await tracking.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: tracking._id, action: "MARK_NOT_REQUIRED", actor, before, after: tracking.toObject(), reason,
    });
    return tracking;
  }

  /* ---------------------------------------------------------------------- */
  /* Read helpers — used by PO creation/approval flows                       */
  /* ---------------------------------------------------------------------- */

  static async getById(id, session) {
    return StockTrackingOrderModel.findOne({ _id: id, isActive: true }).session(session ?? null);
  }

  /* ---------------------------------------------------------------------- */
  /* Detail — tracking + its PO + vendor, for the "Add Items" screen header  */
  /* (read-only PO Number/Vendor) and product tabs (one per PO line item).   */
  /* ---------------------------------------------------------------------- */

  static async getDetail(id, dataAccess) {
    const tracking = await StockTrackingOrderModel.findOne({ _id: id, isActive: true }).lean();
    if (!tracking) throw new Error("Tracking order not found");
    if (!isWithinDataScope(tracking, dataAccess, SCOPE_MODULE_KEY)) {
      throw new Error("Tracking order not found");
    }

    const [po, vendor] = await Promise.all([
      tracking.poId
        ? StockPurchaseOrderModel.findOne({ _id: tracking.poId, isActive: true }).lean()
        : null,
      StockVendorModel.findOne({ _id: tracking.vendorId }).lean(),
    ]);

    return { tracking, po, vendor };
  }

  /* ---------------------------------------------------------------------- */
  /* Recalculate status from approved-invoice received quantities, per PO    */
  /* line (quotationItemId). Called after invoice create/approve/reject —    */
  /* never set directly by a route. Only touches tracking orders already in  */
  /* the receiving flow (PO_APPROVED/IN_PROGRESS/PARTIAL/COMPLETED).         */
  /* ---------------------------------------------------------------------- */

  static async recalculateStatus(trackingOrderId, session) {
    const tracking = await StockTrackingOrderModel.findOne({
      _id: trackingOrderId,
      isActive: true,
    }).session(session);
    if (!tracking) return null;

    const RECEIVING_STATUSES = new Set([
      TRACKING_STATUS.PO_APPROVED,
      TRACKING_STATUS.IN_PROGRESS,
      TRACKING_STATUS.PARTIAL,
      TRACKING_STATUS.COMPLETED,
    ]);
    if (!RECEIVING_STATUSES.has(tracking.status)) return tracking;

    const po = await StockPurchaseOrderModel.findOne({ _id: tracking.poId, isActive: true })
      .session(session)
      .lean();
    if (!po) return tracking;

    const approvedInvoices = await StockInvoiceModel.find({
      trackingOrderId,
      status: INVOICE_STATUS.APPROVED,
      isActive: true,
    })
      .session(session)
      .lean();

    const approvedByLine = new Map(); // quotationItemId -> sum(receivedQuantity)
    approvedInvoices.forEach((inv) =>
      (inv.lines || []).forEach((line) => {
        const key = String(line.quotationItemId);
        approvedByLine.set(key, (approvedByLine.get(key) || 0) + (line.receivedQuantity || 0));
      })
    );

    let allComplete = true;
    let anyReceived = false;
    (po.items || []).forEach((poLine) => {
      const received = approvedByLine.get(String(poLine.quotationItemId)) || 0;
      if (received > 0) anyReceived = true;
      if (received < poLine.quantity) allComplete = false;
    });

    tracking.status = allComplete
      ? TRACKING_STATUS.COMPLETED
      : anyReceived
      ? TRACKING_STATUS.PARTIAL
      : TRACKING_STATUS.IN_PROGRESS;

    await tracking.save({ session });
    return tracking;
  }

  static async getByQuotationAndVendor(sourceQuotationId, vendorId, session) {
    return StockTrackingOrderModel.findOne({
      sourceQuotationId,
      vendorId,
      isActive: true,
    }).session(session ?? null);
  }

  /* ---------------------------------------------------------------------- */
  /* Sync from PO lifecycle                                                  */
  /* ---------------------------------------------------------------------- */

  static async syncStatusForPo(poId, status, session) {
    await StockTrackingOrderModel.updateOne(
      { poId, isActive: true },
      { $set: { status } },
      { session }
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Mail result — records the send outcome (emailed or handled manually).   */
  /* The status is deliberately NOT touched: approving already moved the      */
  /* tracking order to PO_APPROVED, which is where it stays until goods start */
  /* arriving. The mailResult itself is the "it reached the vendor" marker.   */
  /* ---------------------------------------------------------------------- */

  static async recordMailResult(poId, mailResult, session) {
    await StockTrackingOrderModel.updateOne(
      { poId, isActive: true },
      { $set: { mailResult: { ...mailResult, sentAt: new Date() } } },
      { session }
    );
  }
}
