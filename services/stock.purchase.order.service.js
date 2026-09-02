import mongoose from "mongoose";
import { actorSnapshot } from "../models/plugins/actor.stamp.plugin.js";

import StockPurchaseOrderModel from "../models/stock.purchase.order.model.js";
import StockQuotationModel from "../models/stock.quotation.model.js";
import StockVendorModel from "../models/stock.vendor.model.js";
import "../models/stock.category.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";

import StockTermsConditionService from "./stock.terms.condition.service.js";
import StockTrackingOrderService from "./stock.tracking.order.service.js";
import StockNotificationService from "./stock.notification.service.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import StockTrackingOrderModel from "../models/stock.tracking.order.model.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import { applyDataScope, isWithinDataScope } from "../helpers/data.scope.helper.js";

const SCOPE_MODULE_KEY = "purchase-orders";

// Guard for every by-id read AND every mutation. Throws the resource's normal
// "not found" rather than a 403 — a 403 would confirm that a PO belonging to
// another entity exists, which is exactly what the scope is meant to hide.
// allowUnassigned:false — a PO cannot exist without an entity (createPurchaseOrder
// refuses until the tracking order has one), so a blank alias here would be
// corrupt data, not pending work. The board is different: it is assembled from
// tracking orders and legitimately includes rows that have no PO yet.
const assertDataScope = (po, dataAccess) => {
  if (!isWithinDataScope(po, dataAccess, SCOPE_MODULE_KEY)) {
    throw new Error("Purchase order not found");
  }
};
import { getLogger } from "../helpers/logger.helper.js";
import { generatePOPdf } from "../helpers/stock.po.pdf.helper.js";
import { poPdfAbsolutePath } from "../helpers/stock.po.pdf.helper.js";
import { sendMail as sendMailTransport } from "../helpers/mail.helper.js";
import {
  PO_STATUS,
  PO_TAX_TYPE,
  QUOTATION_STATUS,
  TERMS_SOURCE,
  TRACKING_STATUS,
  MAIL_MODE,
  NOTIFICATION_CHANNEL,
} from "../constants/stock.enums.js";

const log = getLogger(import.meta.url);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const ENTITY_TYPE = "purchase-orders";
const QUOTATION_ENTITY_TYPE = "quotations";

export default class StockPurchaseOrderService {
  static async generatePONumber(session) {
    const year = new Date().getFullYear();
    const prefix = `PO-${year}-`;
    const count = await StockPurchaseOrderModel.countDocuments({
      poNumber: new RegExp(`^${prefix}`),
    }).session(session);
    return `${prefix}${String(count + 1).padStart(4, "0")}`;
  }

  static vendorStateCode(vendor) {
    return (
      vendor?.gst?.state?.code ||
      vendor?.address?.state?.code ||
      ""
    );
  }

  // CGST+SGST when buyer & vendor share a state code, else IGST.
  static computeLineTax(taxable, gstRate, taxType) {
    const gstAmount = round2((taxable * (gstRate || 0)) / 100);
    if (taxType === PO_TAX_TYPE.CGST_SGST) {
      const half = round2(gstAmount / 2);
      return { cgst: half, sgst: half, igst: 0, gstAmount: round2(half * 2) };
    }
    return { cgst: 0, sgst: 0, igst: gstAmount, gstAmount };
  }

  /* ---------------------------------------------------------------------- */
  /* Candidates — approved selections not yet on a PO, grouped by vendor     */
  /* ---------------------------------------------------------------------- */

  static async getCandidates(query = {}) {
    const filter = {
      isActive: true,
      status: { $in: [QUOTATION_STATUS.APPROVED, QUOTATION_STATUS.PARTIALLY_APPROVED] },
    };
    if (query.sourceQuotationId) filter._id = query.sourceQuotationId;

    const quotations = await StockQuotationModel.find(filter)
      .select("quotationNumber items categoryApprovals")
      .lean();

    const groups = [];
    quotations.forEach((q) => {
      // map itemId -> item (to read poId + snapshot)
      const itemById = new Map((q.items || []).map((it) => [String(it._id), it]));

      const byVendor = new Map();
      (q.categoryApprovals || [])
        .filter((ca) => ca.status === "APPROVED")
        .forEach((ca) => {
          (ca.selections || []).forEach((sel) => {
            const item = itemById.get(String(sel.itemId));
            if (!item || item.poId || item.poSkipped) return; // already on a PO, or permanently skipped
            const vId = String(sel.vendorId);
            if (!byVendor.has(vId)) {
              byVendor.set(vId, {
                sourceQuotationId: q._id,
                quotationNumber: q.quotationNumber,
                vendorId: sel.vendorId,
                vendorName: sel.vendorName,
                items: [],
              });
            }
            byVendor.get(vId).items.push({
              quotationItemId: sel.itemId,
              categoryId: ca.categoryId,
              categoryName: ca.categoryName,
              productDefinitionId: sel.productDefinitionId,
              productName: sel.productName,
              quantity: sel.quantity,
              unitPrice: sel.unitPrice,
              gstRate: sel.gstRate,
              lineTotal: sel.lineTotal,
            });
          });
        });

      byVendor.forEach((g) => {
        if (g.items.length) groups.push(g);
      });
    });

    return groups;
  }

  /* ---------------------------------------------------------------------- */
  /* Board — one entry per quotation, each with vendor sections              */
  /* ---------------------------------------------------------------------- */


  static async getBoard(query = {}, dataAccess) {
    const { search, vendorId, categoryId, productId, entityAlias, status, dateFrom, dateTo } = query;

    const qFilter = {
      isActive: true,
      status: { $in: [QUOTATION_STATUS.APPROVED, QUOTATION_STATUS.PARTIALLY_APPROVED] },
    };
    if (query.sourceQuotationId) qFilter._id = query.sourceQuotationId;

    const quotations = await StockQuotationModel.find(qFilter)
      .select("quotationNumber items categoryApprovals disabledVendors updatedAt")
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
    const pos = await StockPurchaseOrderModel.find({ sourceQuotationId: { $in: quotationIds }, isActive: true })
      .select("poNumber status grandTotal vendorId sourceQuotationId items buyerEntity createdAt updatedAt reviewedAt rejectedReason")
      .lean();
    const poByKey = new Map();
    pos.forEach((po) => poByKey.set(`${po.sourceQuotationId}::${po.vendorId}`, po));

    // Entity/State now lives on the Tracking Order, assigned once on the
    // Tracking Orders page — a vendor row only belongs on THIS board once its
    // tracking order has moved past ENTITY_PENDING (and isn't NOT_REQUIRED).
    const trackingOrders = await StockTrackingOrderModel.find({
      sourceQuotationId: { $in: quotationIds },
      isActive: true,
    }).lean();
    const trackingByKey = new Map(
      trackingOrders.map((t) => [`${t.sourceQuotationId}::${t.vendorId}`, t])
    );
    const VISIBLE_TRACKING_STATUSES = new Set([
      TRACKING_STATUS.PO_PENDING,
      TRACKING_STATUS.PO_GENERATED,
      TRACKING_STATUS.PO_APPROVED,
      TRACKING_STATUS.IN_PROGRESS,
      TRACKING_STATUS.PARTIAL,
      TRACKING_STATUS.COMPLETED,
      TRACKING_STATUS.REJECTED,
    ]);

    // ── build the full board (unfiltered) ────────────────────────────────────
    const fullBoard = [];
    quotations.forEach((q) => {
      const itemById = new Map((q.items || []).map((it) => [String(it._id), it]));
      const disabledMap = new Map((q.disabledVendors || []).map((d) => [String(d.vendorId), d]));

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
              const d = disabledMap.get(vId);
              byVendor.set(vId, {
                vendorId: vId, vendorName: sel.vendorName || v.name || "",
                phone: primary.phone || "", email: primary.email || "", contactName: primary.name || "",
                gstNumber: v.gst?.gstNumber || "", address: v.address?.fullAddress || "",
                state: v.gst?.state?.name || v.address?.state?.name || "",
                stateCode: v.gst?.state?.code || v.address?.state?.code || "",
                paymentTerms: v.paymentTerms || "",
                disabled: Boolean(d), disabledReason: d?.reason || "",
                _pending: [],
                _skipped: [],
              });
            }
            const row = byVendor.get(vId);
            const qty = sel.quantity, price = sel.unitPrice, gstRate = sel.gstRate;
            const taxable = round2(qty * price);
            const gstAmount = round2((taxable * gstRate) / 100);
            const lineTotal = round2(taxable + gstAmount);
            const detail = {
              quotationItemId: item._id, categoryId: ca.categoryId, categoryName: ca.categoryName,
              productDefinitionId: sel.productDefinitionId, productName: sel.productName,
              quantity: qty, unitPrice: price, gstRate, taxable, gstAmount, lineTotal,
            };
            if (item.poSkipped) row._skipped.push({ ...detail, poSkipReason: item.poSkipReason || "" });
            else if (!item.poId) row._pending.push(detail);
          })
        );

      const rows = [];
      byVendor.forEach((row, vId) => {
        const tracking = trackingByKey.get(`${q._id}::${vId}`);
        if (!tracking || !VISIBLE_TRACKING_STATUSES.has(tracking.status)) return;

        const po = poByKey.get(`${q._id}::${vId}`);
        let statusVal, items, poId = null, poNumber = "";
        const entityAlias = tracking.buyerEntity?.alias || "";
        let totalAmount = 0, totalQuantity = 0, rejectedReason = "", filterDate = approvalDate;
        let createdBy = null;

        if (po) {
          poId = po._id; poNumber = po.poNumber; statusVal = po.status;
          // Carried so the ownership filter below has something to read. Without
          // it row.createdBy was undefined and every OWN-scoped user saw an
          // empty board.
          createdBy = po.createdBy || null;
          items = (po.items || []).map((it) => ({
            quotationItemId: it.quotationItemId, categoryId: it.categoryId, categoryName: it.categoryName,
            productDefinitionId: it.productDefinitionId, productName: it.productName,
            quantity: it.quantity, unitPrice: it.unitPrice, gstRate: it.gstRate,
            taxable: it.taxable, gstAmount: it.gstAmount, lineTotal: it.lineTotal,
          }));
          totalAmount = po.grandTotal;
          totalQuantity = items.reduce((s, i) => s + (i.quantity || 0), 0);
          rejectedReason = po.rejectedReason || "";
          filterDate = po.status === "GENERATED" ? po.createdAt : (po.reviewedAt || po.updatedAt || po.createdAt);
        } else {
          statusVal = "PO_PENDING"; items = row._pending;
          totalAmount = round2(items.reduce((s, i) => s + (i.lineTotal || 0), 0));
          totalQuantity = items.reduce((s, i) => s + (i.quantity || 0), 0);
          filterDate = approvalDate;
        }

        if (!po && items.length === 0 && row._skipped.length === 0) return;

        const catIds = [...new Set(items.map((i) => String(i.categoryId)).filter(Boolean))];
        const prodIds = [...new Set(items.map((i) => String(i.productDefinitionId)).filter(Boolean))];

        rows.push({
          vendorId: vId, vendorName: row.vendorName, phone: row.phone, email: row.email, contactName: row.contactName,
          gstNumber: row.gstNumber, address: row.address, state: row.state, stateCode: row.stateCode,
          paymentTerms: row.paymentTerms,
          poId, poNumber, status: statusVal, entityAlias, createdBy,
          buyerEntity: tracking.buyerEntity || {},
          items, totalAmount, totalQuantity, skipped: row._skipped, filterDate,
          disabled: row.disabled, disabledReason: row.disabledReason, rejectedReason,
          mailResult: tracking.mailResult || null,
          _catIds: catIds, _prodIds: prodIds,
        });
      });

      if (rows.length) {
        fullBoard.push({
          sourceQuotationId: q._id, quotationNumber: q.quotationNumber,
          quotationApprovalDate: approvalDate, vendorCount: rows.length, rows,
        });
      }
    });

    // most recently updated / approved cards float to the top — each card's
    // "latest" is the newest filterDate among its rows (PO create/approve/
    // reject date, or the quotation approval date when a row has no PO yet)
    fullBoard.sort((a, b) => {
      const aLatest = a.rows.reduce(
        (m, r) => (r.filterDate && (!m || new Date(r.filterDate) > new Date(m)) ? r.filterDate : m),
        null
      );
      const bLatest = b.rows.reduce(
        (m, r) => (r.filterDate && (!m || new Date(r.filterDate) > new Date(m)) ? r.filterDate : m),
        null
      );
      return new Date(bLatest || 0) - new Date(aLatest || 0);
    });

    // ── server-side filters ───────────────────────────────────────────────────
    const t = search ? String(search).toLowerCase().trim() : "";
    const from = dateFrom ? new Date(dateFrom) : null;
    const to = dateTo ? new Date(dateTo + "T23:59:59") : null;

    const rowPass = (row, quotationNumber, ignoreStatus) => {
      if (!ignoreStatus && status && row.status !== status) return false;
      if (vendorId && String(row.vendorId) !== String(vendorId)) return false;
      if (entityAlias && (row.entityAlias || "") !== entityAlias) return false;
      // This board is assembled in memory from quotations + tracking orders,
      // so the scope is applied to the built row rather than to a Mongo filter.
      // Rows with no entity yet stay visible — that is the ENTITY_PENDING work
      // someone still has to pick up.
      if (!isWithinDataScope({ buyerEntity: { alias: row.entityAlias }, createdBy: row.createdBy }, dataAccess, SCOPE_MODULE_KEY)) return false;
      if (categoryId && !row._catIds.includes(String(categoryId))) return false;
      if (productId && !row._prodIds.includes(String(productId))) return false;
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

    // counts: every filter EXCEPT status
    const counts = { ALL: 0, PO_PENDING: 0, GENERATED: 0, APPROVED: 0, REJECTED: 0 };
    fullBoard.forEach((q) =>
      q.rows.forEach((r) => {
        if (rowPass(r, q.quotationNumber, true)) {
          counts.ALL += 1;
          if (counts[r.status] !== undefined) counts[r.status] += 1;
        }
      })
    );

    // final filtered board (incl status); strip internal fields
    const filteredBoard = fullBoard
      .map((q) => ({
        ...q,
        rows: q.rows
          .filter((r) => rowPass(r, q.quotationNumber, false))
          .map(({ _catIds, _prodIds, ...r }) => r),
      }))
      .filter((q) => q.rows.length > 0);

    // pagination — page the QUOTATION CARDS (counts stay global for the filter set)
    const { skip, limit, page } = paginate(query);
    const total = filteredBoard.length;
    const board = filteredBoard.slice(skip, skip + limit);

    // trackingMethod/unit aren't snapshotted on quotation/PO line items —
    // resolve them for just this page's rows (display-only, read path, no
    // schema change), so the board can show the actual saved unit next to
    // every quantity.
    const boardProductDefIds = [
      ...new Set(
        board.flatMap((q) => q.rows.flatMap((r) => [...r.items, ...(r.skipped || [])].map((it) => String(it.productDefinitionId))))
      ),
    ];
    const boardProductDefs = await StockProductDefinitionModel.find({ _id: { $in: boardProductDefIds } })
      .select("trackingMethod unit")
      .lean();
    const boardProductDefById = new Map(boardProductDefs.map((p) => [String(p._id), p]));
    board.forEach((q) => {
      q.rows.forEach((r) => {
        const attachProductMeta = (it) => {
          const pd = boardProductDefById.get(String(it.productDefinitionId));
          return { ...it, trackingMethod: pd?.trackingMethod || "quantity", unit: pd?.unit || null };
        };
        r.items = r.items.map(attachProductMeta);
        if (r.skipped) r.skipped = r.skipped.map(attachProductMeta);
      });
    });

    // successResponseHandler flattens `.pagination` to the top level and sets
    // response.data to `.data` — so board + counts must live inside `data`,
    // else they get dropped.
    return {
      data: { board, counts },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /* Disable / enable a vendor on a quotation (admin). Disabled = hidden from PO flow. */
  static async disableVendor(quotationId, payload, user, session) {
    const { vendorId, reason } = payload || {};
    const quotation = await StockQuotationModel.findOne({ _id: quotationId, isActive: true }).session(session);
    if (!quotation) throw new Error("Quotation not found");
    if (!vendorId) throw new Error("vendorId is required");
    if (!reason || !String(reason).trim()) throw new Error("A reason is required to disable a vendor");

    const exists = (quotation.disabledVendors || []).some((d) => String(d.vendorId) === String(vendorId));
    if (!exists) {
      const before = quotation.toObject();
      const item = quotation.items.find((it) => String(it.vendorId) === String(vendorId));
      quotation.disabledVendors.push({
        vendorId,
        vendorName: item?.vendorName || "",
        reason: String(reason).trim(),
        disabledBy: user?.id || user?._id || null,
        disabledByName: user?.name || "",
        disabledAt: new Date(),
      });
      await quotation.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: QUOTATION_ENTITY_TYPE, entityId: quotation._id, action: "DISABLE_VENDOR", actor: user, before, after: quotation.toObject(),
        reason: `vendor=${vendorId}: ${reason}`,
      });
    }
    return quotation;
  }

  static async enableVendor(quotationId, vendorId, user, session) {
    const quotation = await StockQuotationModel.findOne({ _id: quotationId, isActive: true }).session(session);
    if (!quotation) throw new Error("Quotation not found");
    const before = quotation.toObject();
    quotation.disabledVendors = (quotation.disabledVendors || []).filter(
      (d) => String(d.vendorId) !== String(vendorId)
    );
    await quotation.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: QUOTATION_ENTITY_TYPE, entityId: quotation._id, action: "ENABLE_VENDOR", actor: user, before, after: quotation.toObject(),
      reason: `vendor=${vendorId}`,
    });
    return quotation;
  }

  /* ---------------------------------------------------------------------- */
  /* Create — one PO from the given quotation item ids (all same vendor)     */
  /* ---------------------------------------------------------------------- */

  static async createPurchaseOrder(body, user, session, dataAccess) {
    const {
      sourceQuotationId,
      vendorId,
      quotationItemIds,
      skippedItems,
      requester,
      poDate,
      shipmentPreference,
      notes,
      termsConditionId,
    } = body;

    const quotation = await StockQuotationModel.findOne({
      _id: sourceQuotationId,
      isActive: true,
    }).session(session);
    if (!quotation) throw new Error("Source quotation not found");

    const vendor = await StockVendorModel.findOne({
      _id: vendorId,
      isActive: true,
    })
      .session(session)
      .lean();
    if (!vendor) throw new Error("Vendor not found or inactive");

    // Buyer entity is no longer sent by the client — it's assigned once on
    // the Tracking Orders page and consumed here read-only.
    const tracking = await StockTrackingOrderService.getByQuotationAndVendor(
      sourceQuotationId,
      vendorId,
      session
    );
    if (!tracking || tracking.status !== TRACKING_STATUS.PO_PENDING || !tracking.buyerEntity?.stateCode) {
      throw new Error("Entity not assigned yet — add it in Tracking Orders before creating a PO");
    }
    // The entity is already fixed on the tracking order by this point, so a
    // PO can only be raised by someone allowed to work on that entity.
    assertDataScope(tracking, dataAccess);
    const buyerEntity = tracking.buyerEntity;

    // Auto-pick terms: a vendor-specific ACTIVE term wins, else the single
    // Default term, else none (graceful — doesn't block PO creation).
    let { term: resolvedTerm, source: termsSource } =
      await StockTermsConditionService.resolveForVendor(vendorId, session);

    // Manual fallback — the PO create screen requires the user to pick a
    // template by hand when nothing auto-resolves; honor that pick here.
    if (termsSource === TERMS_SOURCE.NONE && termsConditionId) {
      const manual = await StockTermsConditionService.getActiveById(termsConditionId, session);
      if (manual) {
        resolvedTerm = manual;
        termsSource = TERMS_SOURCE.MANUAL;
      }
    }

    // Collect the approved-selection snapshots for the requested item ids.
    const wantIds = new Set((quotationItemIds || []).map(String));
    const selByItemId = new Map();
    (quotation.categoryApprovals || [])
      .filter((ca) => ca.status === "APPROVED")
      .forEach((ca) =>
        (ca.selections || []).forEach((sel) => {
          selByItemId.set(String(sel.itemId), { ca, sel });
        })
      );

    if (wantIds.size === 0) throw new Error("Select at least one item for the PO");

    const buyerStateCode = String(buyerEntity?.stateCode || "");
    const vendorStateCode = String(StockPurchaseOrderService.vendorStateCode(vendor));
    const taxType =
      buyerStateCode && buyerStateCode === vendorStateCode
        ? PO_TAX_TYPE.CGST_SGST
        : PO_TAX_TYPE.IGST;

    const items = [];
    let subTotal = 0, cgstTotal = 0, sgstTotal = 0, igstTotal = 0;

    for (const itemId of wantIds) {
      const found = selByItemId.get(itemId);
      if (!found) throw new Error("An item is not an approved selection of this quotation");

      const item = quotation.items.id(itemId);
      if (!item) throw new Error("Quotation item not found");
      if (String(item.vendorId) !== String(vendorId)) {
        throw new Error("All items in one PO must belong to the same vendor");
      }
      if (item.poId) throw new Error(`${item.productName} is already on a PO`);
      if (item.poSkipped) throw new Error(`${item.productName} was skipped and can't be added`);

      const { sel, ca } = found;
      const taxable = round2(sel.quantity * sel.unitPrice);
      const { cgst, sgst, igst, gstAmount } = StockPurchaseOrderService.computeLineTax(
        taxable,
        sel.gstRate,
        taxType
      );
      const lineTotal = round2(taxable + gstAmount);

      subTotal = round2(subTotal + taxable);
      cgstTotal = round2(cgstTotal + cgst);
      sgstTotal = round2(sgstTotal + sgst);
      igstTotal = round2(igstTotal + igst);

      items.push({
        quotationItemId: item._id,
        categoryId: ca.categoryId,
        categoryName: ca.categoryName,
        productDefinitionId: sel.productDefinitionId,
        productName: sel.productName,
        quantity: sel.quantity,
        unitPrice: sel.unitPrice,
        gstRate: sel.gstRate,
        taxable,
        cgst,
        sgst,
        igst,
        gstAmount,
        lineTotal,
      });
    }

    const gstTotal = round2(cgstTotal + sgstTotal + igstTotal);
    const grandTotal = round2(subTotal + gstTotal);
    const poNumber = await StockPurchaseOrderService.generatePONumber(session);
    const primaryContact = (vendor.contacts || []).find((c) => c.label === "PRIMARY") ||
      (vendor.contacts || [])[0] || {};

    const [po] = await StockPurchaseOrderModel.create(
      [
        {
          poNumber,
          sourceQuotationId,
          vendorId,
          vendorName: vendor.name || "",
          vendorGstin: vendor.gst?.gstNumber || "",
          vendorAddress: vendor.address?.fullAddress || "",
          vendorState: vendor.gst?.state?.name || vendor.address?.state?.name || "",
          vendorStateCode,
          vendorPhone: primaryContact.phone || "",
          vendorEmail: primaryContact.email || "",
          buyerEntity: {
            entityId: buyerEntity?.entityId || null,
            name: buyerEntity?.name || "",
            alias: buyerEntity?.alias || "",
            gstNumber: buyerEntity?.gstNumber || "",
            address: buyerEntity?.address || "",
            state: buyerEntity?.state || "",
            stateCode: buyerStateCode,
          },
          requester: requester || "",
          poDate: poDate || new Date(),
          shipmentPreference: shipmentPreference || "",
          paymentTerms: vendor.paymentTerms || "",
          terms: resolvedTerm?.termsContent || "",
          termsConditionId: resolvedTerm?._id || null,
          termsSource,
          notes: notes || "",
          taxType,
          items,
          subTotal,
          cgstTotal,
          sgstTotal,
          igstTotal,
          gstTotal,
          grandTotal,
          status: PO_STATUS.GENERATED,
        },
      ],
      { session }
    );

    // Lock the used quotation items so they can't be PO'd again.
    wantIds.forEach((itemId) => {
      const item = quotation.items.id(itemId);
      if (item) {
        item.poId = po._id;
        item.poAddedAt = new Date();
      }
    });

    // Permanently skip the unchecked items (reason required — validated in controller).
    (skippedItems || []).forEach((s) => {
      const item = quotation.items.id(String(s.itemId));
      if (item && !item.poId && !item.poSkipped) {
        item.poSkipped = true;
        item.poSkipReason = String(s.reason || "").trim();
        item.poSkippedBy = user?.id || user?._id || null;
        item.poSkippedAt = new Date();
      }
    });

    await quotation.save({ session });

    // Generate the PDF (outside the mongoose write, but before commit is fine).
    const pdfPath = await generatePOPdf(po.toObject());
    po.pdfPath = pdfPath;
    await po.save({ session });

    tracking.poId = po._id;
    tracking.status = TRACKING_STATUS.PO_GENERATED;
    await tracking.save({ session });

    log.info(`PO created: ${poNumber} (${items.length} items, ${taxType})`);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: po._id, action: "CREATE", actor: user, before: null, after: po.toObject(),
    });
    return po;
  }

  /* ---------------------------------------------------------------------- */
  /* Read                                                                    */
  /* ---------------------------------------------------------------------- */

  static async getAllPurchaseOrders(query, dataAccess) {
    const { search, status, vendorId, sourceQuotationId } = query;
    const { skip, limit, page } = paginate(query);

    const filter = { isActive: true };
    if (status) filter.status = status;
    if (vendorId) filter.vendorId = vendorId;
    if (sourceQuotationId) filter.sourceQuotationId = sourceQuotationId;
    if (search) {
      const regex = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ poNumber: regex }, { vendorName: regex }];
    }
    applyDataScope(filter, dataAccess, SCOPE_MODULE_KEY);

    const [data, total] = await Promise.all([
      StockPurchaseOrderModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      StockPurchaseOrderModel.countDocuments(filter),
    ]);
    return paginateReturn(data, total, page, limit);
  }

  static async getPurchaseOrderById(id, dataAccess) {
    const po = await StockPurchaseOrderModel.findOne({ _id: id, isActive: true }).lean();
    if (!po) throw new Error("Purchase order not found");
    assertDataScope(po, dataAccess);

    // trackingMethod/unit aren't snapshotted on the PO line item — resolve
    // them so the view/edit screens can show the actual saved unit next to
    // every quantity.
    const productDefIds = [...new Set((po.items || []).map((it) => String(it.productDefinitionId)))];
    const productDefs = await StockProductDefinitionModel.find({ _id: { $in: productDefIds } })
      .select("trackingMethod unit")
      .lean();
    const productDefById = new Map(productDefs.map((p) => [String(p._id), p]));
    po.items = (po.items || []).map((it) => {
      const pd = productDefById.get(String(it.productDefinitionId));
      return { ...it, trackingMethod: pd?.trackingMethod || "quantity", unit: pd?.unit || null };
    });

    return po;
  }

  /* ---------------------------------------------------------------------- */
  /* Edit (GENERATED/REJECTED only) → regenerate PDF                         */
  /* ---------------------------------------------------------------------- */

  static async updatePurchaseOrder(id, body, user, session, dataAccess) {
    const po = await StockPurchaseOrderModel.findOne({ _id: id, isActive: true }).session(session);
    if (!po) throw new Error("Purchase order not found");
    assertDataScope(po, dataAccess);
    if (![PO_STATUS.GENERATED, PO_STATUS.REJECTED].includes(po.status)) {
      throw new Error("Only a generated or rejected PO can be edited");
    }
    const before = po.toObject();

    if (body.requester !== undefined) po.requester = body.requester;
    if (body.poDate !== undefined) po.poDate = body.poDate;
    if (body.shipmentPreference !== undefined) po.shipmentPreference = body.shipmentPreference;
    // terms/termsConditionId/termsSource are immutable after create — they're
    // a point-in-time snapshot from the Terms & Conditions master, not a
    // free-text field (see createPurchaseOrder).
    if (body.notes !== undefined) po.notes = body.notes;

    // Buyer entity is no longer editable here — it's a one-time assignment
    // made on the Tracking Orders page before the PO ever existed (see
    // createPurchaseOrder) and stays fixed for the life of the PO.

    // Editing an approved-then... no: edit only allowed on GENERATED/REJECTED,
    // and after edit it goes back to GENERATED for a fresh review.
    po.status = PO_STATUS.GENERATED;
    po.rejectedReason = "";

    po.pdfPath = await generatePOPdf(po.toObject());
    await po.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: po._id, action: "UPDATE", actor: user, before, after: po.toObject(),
    });
    return po;
  }

  /* ---------------------------------------------------------------------- */
  /* Approve / Reject                                                        */
  /* ---------------------------------------------------------------------- */

  static async approvePurchaseOrder(id, user, session, dataAccess) {
    const po = await StockPurchaseOrderModel.findOne({ _id: id, isActive: true }).session(session);
    if (!po) throw new Error("Purchase order not found");
    assertDataScope(po, dataAccess);
    if (![PO_STATUS.GENERATED, PO_STATUS.REJECTED].includes(po.status)) {
      throw new Error("Only a generated or rejected PO can be approved");
    }
    const before = po.toObject();
    po.status = PO_STATUS.APPROVED;
    po.rejectedReason = "";
    po.reviewedBy = user?.id || user?._id || null;
    po.reviewedByName = user?.name || "";
    po.reviewedAt = new Date();
    await po.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: po._id, action: "APPROVE", actor: user, before, after: po.toObject(),
    });
    await StockTrackingOrderService.syncStatusForPo(po._id, TRACKING_STATUS.PO_APPROVED, session);
    return po;
  }

  static async rejectPurchaseOrder(id, reason, user, session, dataAccess) {
    const po = await StockPurchaseOrderModel.findOne({ _id: id, isActive: true }).session(session);
    if (!po) throw new Error("Purchase order not found");
    assertDataScope(po, dataAccess);
    if (po.status !== PO_STATUS.GENERATED) {
      throw new Error("Only a generated PO can be rejected");
    }
    const before = po.toObject();
    po.status = PO_STATUS.REJECTED;
    po.rejectedReason = typeof reason === "string" ? reason : "";
    po.reviewedBy = user?.id || user?._id || null;
    po.reviewedByName = user?.name || "";
    po.reviewedAt = new Date();
    await po.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: po._id, action: "REJECT", actor: user, before, after: po.toObject(), reason,
    });
    await StockTrackingOrderService.syncStatusForPo(po._id, TRACKING_STATUS.REJECTED, session);
    return po;
  }

  /* ---------------------------------------------------------------------- */
  /* Send Mail — APPROVED only. Either actually emails the PO (via the       */
  /* resolved Notification's From/CC) or records a Manual hand-off; either   */
  /* way the PO STAYS APPROVED — that is the terminal state now. What marks  */
  /* it as gone-to-vendor is the mailResult on the tracking order, which is  */
  /* also what turns "Send Mail" into "Resend Mail" and blocks deletion.     */
  /* ---------------------------------------------------------------------- */

  static async sendMail(id, body, user, session, dataAccess) {
    const po = await StockPurchaseOrderModel.findOne({ _id: id, isActive: true }).session(session);
    if (!po) throw new Error("Purchase order not found");
    assertDataScope(po, dataAccess);
    // Approved covers both the first send and every resend — a PO stays
    // resendable indefinitely (see PurchaseOrderPage buildRowActions).
    if (po.status !== PO_STATUS.APPROVED) {
      throw new Error("Only an approved PO can be sent");
    }
    const before = po.toObject();

    const { sendEmail, to, cc, from } = body;
    const { notification } = await StockNotificationService.resolveForVendor(
      po.vendorId,
      NOTIFICATION_CHANNEL.EMAIL,
      session
    );

    let mailResult;
    if (sendEmail) {
      // No per-notification From address anymore — sending always goes out
      // as MAIL_FROM_DEFAULT (see mail.helper.js) unless a caller explicitly
      // passes one.
      const resolvedFrom = from || undefined;
      const resolvedCc = Array.isArray(cc) && cc.length ? cc : notification?.ccEmails || [];

      const pdfAbs = po.pdfPath ? poPdfAbsolutePath(po.pdfPath) : null;
      await sendMailTransport({
        from: resolvedFrom,
        to,
        cc: resolvedCc,
        subject: `Purchase Order ${po.poNumber}`,
        html: `<p>Please find attached Purchase Order <strong>${po.poNumber}</strong>.</p>`,
        attachments: pdfAbs ? [{ filename: `${po.poNumber}.pdf`, path: pdfAbs }] : undefined,
      });

      po.emailedTo = to;
      po.emailedAt = new Date();
      mailResult = {
        mode: MAIL_MODE.SENT,
        channel: NOTIFICATION_CHANNEL.EMAIL,
        notificationId: notification?._id || null,
        to,
        cc: resolvedCc,
        from: resolvedFrom || "",
      };
    } else {
      // Manual hand-off — no email sent through the ERP, but the PO has still
      // left the building, so it is recorded the same as an emailed one.
      mailResult = {
        mode: MAIL_MODE.MANUAL,
        channel: NOTIFICATION_CHANNEL.EMAIL,
        notificationId: notification?._id || null,
        to: to || "",
        cc: cc || [],
        from: from || "",
      };
    }

    await po.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: po._id, action: "SEND_MAIL", actor: user, before, after: po.toObject(),
      reason: mailResult.mode,
    });
    await StockTrackingOrderService.recordMailResult(po._id, mailResult, session);

    return { po, mailResult };
  }

  /* ---------------------------------------------------------------------- */
  /* Soft delete — frees the quotation-item lock                             */
  /* ---------------------------------------------------------------------- */

  static async softDeletePurchaseOrder(id, user, session, dataAccess) {
    const po = await StockPurchaseOrderModel.findOne({ _id: id, isActive: true }).session(session);
    if (!po) throw new Error("Purchase order not found");
    assertDataScope(po, dataAccess);
    // With no SENT status left, "already gone to the vendor" is whatever the
    // tracking order recorded when the mail went out (emailed OR marked
    // Manual) — po.emailedAt alone would miss the manual hand-off.
    const tracked = await StockTrackingOrderModel.findOne({ poId: po._id, isActive: true })
      .session(session)
      .lean();
    if (po.emailedAt || tracked?.mailResult?.mode) {
      throw new Error("Cannot delete — this PO has already been sent to the vendor");
    }
    const before = po.toObject();

    // Free the locked quotation items so they can be PO'd again.
    const quotation = await StockQuotationModel.findOne({
      _id: po.sourceQuotationId,
      isActive: true,
    }).session(session);
    if (quotation) {
      quotation.items.forEach((it) => {
        if (String(it.poId) === String(po._id)) {
          it.poId = null;
          it.poAddedAt = null;
        }
      });
      await quotation.save({ session });
    }

    po.isActive = false;
    po.deletedAt = new Date();
    po.deletedBy = actorSnapshot(user);
    await po.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: po._id, action: "DELETE", actor: user, before, after: po.toObject(),
    });
    return po;
  }
}