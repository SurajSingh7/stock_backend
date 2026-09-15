import StockTrackingOrderModel from "../models/stock.tracking.order.model.js";
import StockQuotationModel from "../models/stock.quotation.model.js";
import StockVendorModel from "../models/stock.vendor.model.js";
import StockPurchaseOrderModel from "../models/stock.purchase.order.model.js";
import StockInvoiceModel from "../models/stock.invoice.model.js";

import { paginate } from "../helpers/pagination.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import {
  QUOTATION_STATUS,
  TRACKING_STATUS,
  INVOICE_STATUS,
  CATEGORY_APPROVAL_STATUS,
} from "../constants/stock.enums.js";
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
              // Warranty lives on the approved SELECTION, never on the PO line —
              // a PO does not carry it. Sent here so the card can show it in
              // both states without the screen going looking for it.
              warrantyMonths: sel.warrantyMonths ?? null,
              quantity: qty, unitPrice: price, gstRate, taxable, gstAmount, lineTotal,
            });
          })
        );

      const rows = [];
      byVendor.forEach((row, vId) => {
        const tracking = trackingByKey.get(`${q._id}::${vId}`);
        if (!tracking) return; // shouldn't happen — created at review time

        const po = poByKey.get(`${q._id}::${vId}`);

        // Excluded lines leave the row's items and its money: what this row
        // shows must be what a PO would actually be raised for. They are
        // returned alongside, so the screen can still list what was dropped.
        const excludedById = new Map(
          (tracking.excludedItems || []).map((e) => [String(e.quotationItemId), e])
        );
        const excludedItems = row.items
          .filter((it) => excludedById.has(String(it.quotationItemId)))
          .map((it) => {
            const e = excludedById.get(String(it.quotationItemId));
            return {
              ...it,
              reason: e.reason || "",
                  excludedByName: e.excludedByName || "",
              excludedAt: e.excludedAt || null,
            };
          });
        row.items = row.items.filter((it) => !excludedById.has(String(it.quotationItemId)));

        let items = row.items, totalAmount, totalQuantity;

        if (po) {
          // A PO line does not carry warranty, so carry it across from the
          // approved selection this line came from. That selection is itself a
          // snapshot taken at approval, so this is not reading anything live.
          const warrantyByItemId = new Map(
            row.items.map((it) => [String(it.quotationItemId), it.warrantyMonths ?? null])
          );
          items = (po.items || []).map((it) => ({
            quotationItemId: it.quotationItemId, categoryId: it.categoryId, categoryName: it.categoryName,
            productDefinitionId: it.productDefinitionId, productName: it.productName,
            warrantyMonths: warrantyByItemId.get(String(it.quotationItemId)) ?? null,
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
          // poDate is a date the creator PICKS, so it has no meaningful time of
          // day. The card shows the picked date with the time the PO was
          // actually created, which is the only real clock reading available.
          poCreatedAt: po?.createdAt || null,
          taxType: po?.taxType || "CGST_SGST", subTotal, cgstTotal, sgstTotal,
          igstTotal, poPdfPath: po?.pdfPath || "",
          status: tracking.status,
          entityAlias: tracking.buyerEntity?.alias || "",
          entityState: tracking.buyerEntity?.state || "",
          buyerEntity: tracking.buyerEntity || {},
          items, totalAmount, totalQuantity,
          excludedItems,
          receivedQuantity, pendingQuantity,
          notRequiredReason: tracking.notRequiredReason || "",
          // Every restart this order has been through — the History button on
          // both boards reads this, so the count is visible without opening it.
          resets: tracking.resets || [],
          activity: tracking.activity || [],
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

  /*
    The Not Required register — everything the business decided not to order,
    as ONE CARD per (quotation, vendor).

    A card, not a row per product, because that is the unit a reader thinks in:
    "what did we drop from this vendor on this quotation, and why". Paging rows
    would also split one vendor's products across two pages.

    Two kinds of card:
      - a vendor dropped WHOLE (status NOT_REQUIRED). Only this kind can be
        undone from here, with "Mark as Required" — a dropped vendor no longer
        appears as workable on either board, so there is nowhere else to do it.
      - a vendor still in the flow, with some products excluded. Those go back
        on the Tracking Orders page, where they were decided.

    A dropped vendor is listed even when excludedItems is empty: the status is
    what makes it not required, and its products are then read from the
    quotation rather than from anything stored here.
  */
  static async getNotRequired(query = {}, dataAccess) {
    const { search, vendorId, dateTo, dateFrom } = query;

    const trackingOrders = await StockTrackingOrderModel.find({
      isActive: true,
      $or: [
        { status: TRACKING_STATUS.NOT_REQUIRED },
        { "excludedItems.0": { $exists: true } },
      ],
    })
      .populate("sourceQuotationId", "quotationNumber")
      .populate("vendorId", "name")
      .lean();

    // Dropped vendors need their products, and one dropped before any line was
    // excluded has nothing stored to list, so the quotation is the only source.
    // Loaded in one query for all of them rather than per card.
    const dropped = trackingOrders.filter((t) => t.status === TRACKING_STATUS.NOT_REQUIRED);
    const quotationById = new Map();
    if (dropped.length) {
      const ids = [...new Set(dropped.map((t) => String(t.sourceQuotationId?._id || t.sourceQuotationId)))];
      const quotations = await StockQuotationModel.find({ _id: { $in: ids } })
        .select("items categoryApprovals")
        .lean();
      quotations.forEach((q) => quotationById.set(String(q._id), q));
    }

    const from = dateFrom ? new Date(dateFrom) : null;
    const to = dateTo ? new Date(`${dateTo}T23:59:59`) : null;
    const term = search ? String(search).toLowerCase().trim() : "";

    const cards = [];
    trackingOrders.forEach((t) => {
      // Entity scope, with one deliberate exception: a card whose entity was
      // never assigned. isWithinDataScope treats a blank alias as "matches
      // nothing" and hides it — correct for a record that SHOULD have an
      // entity, wrong here, because the commonest decision of all is taken on
      // the Tracking Orders page BEFORE any entity exists. Without this the
      // register reads empty for every user who is not entity-unrestricted.
      const alias = t.buyerEntity?.alias || "";
      if (alias && !isWithinDataScope(t, dataAccess, SCOPE_MODULE_KEY)) return;

      const quotationNumber = t.sourceQuotationId?.quotationNumber || "";
      const vendorName = t.vendorId?.name || "";
      const tVendorId = t.vendorId?._id || t.vendorId;
      if (vendorId && String(tVendorId) !== String(vendorId)) return;

      const wholeVendor = t.status === TRACKING_STATUS.NOT_REQUIRED;
      const excluded = t.excludedItems || [];

      // What the card lists. For a dropped vendor with nothing stored, fall
      // back to its approved lines — the products ARE the whole order.
      let products = excluded.map((e) => ({
        productName: e.productName || "",
        categoryName: e.categoryName || "",
        quantity: e.quantity || 0,
        lineTotal: e.lineTotal || 0,
        reason: e.reason || "",
        byName: e.excludedByName || "",
        at: e.excludedAt || null,
      }));
      if (wholeVendor && products.length === 0) {
        const quotation = quotationById.get(String(t.sourceQuotationId?._id || t.sourceQuotationId));
        const approved = quotation
          ? StockTrackingOrderService.approvedLinesFor(quotation, tVendorId)
          : [];
        products = approved.map(({ ca, sel }) => ({
          productName: sel.productName || "",
          categoryName: ca.categoryName || "",
          quantity: sel.quantity || 0,
          lineTotal: sel.lineTotal || 0,
          reason: t.notRequiredReason || "",
          byName: t.disabledByName || "",
          at: t.disabledAt || null,
        }));
      }

      // The card's own reason/author: the whole-vendor decision if there was
      // one, else whatever the first excluded product recorded.
      const reason = wholeVendor ? t.notRequiredReason || products[0]?.reason || "" : "";
      const byName = wholeVendor ? t.disabledByName || products[0]?.byName || "" : "";
      const at = wholeVendor ? t.disabledAt || products[0]?.at || null : products[0]?.at || null;

      if (from && at && new Date(at) < from) return;
      if (to && at && new Date(at) > to) return;
      if (term) {
        const hit =
          quotationNumber.toLowerCase().includes(term) ||
          vendorName.toLowerCase().includes(term) ||
          reason.toLowerCase().includes(term) ||
          products.some(
            (pr) =>
              (pr.productName || "").toLowerCase().includes(term) ||
              (pr.categoryName || "").toLowerCase().includes(term) ||
              (pr.reason || "").toLowerCase().includes(term)
          );
        if (!hit) return;
      }

      cards.push({
        trackingOrderId: t._id,
        sourceQuotationId: t.sourceQuotationId?._id || t.sourceQuotationId,
        quotationNumber,
        vendorId: tVendorId,
        vendorName,
        entityAlias: alias,
        wholeVendor,
        reason,
        byName,
        at,
        products,
        productCount: products.length,
        totalValue: round2(products.reduce((s, pr) => s + (pr.lineTotal || 0), 0)),
        // Feeds the History button — same two tabs as the Tracking Orders page.
        resets: t.resets || [],
        activity: t.activity || [],
      });
    });

    cards.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));

    const { skip, limit, page } = paginate(query);
    // Shape matters here: successResponseHandler UNWRAPS any payload carrying a
    // `pagination` key — it lifts `data.data` to the top and drops every other
    // sibling. Everything the screen needs therefore goes inside `data`,
    // exactly as getBoard does with { board, counts }.
    return {
      data: {
        cards: cards.slice(skip, skip + limit),
        totals: {
          vendors: cards.length,
          products: cards.reduce((s, c) => s + c.productCount, 0),
          value: round2(cards.reduce((s, c) => s + c.totalValue, 0)),
        },
      },
      pagination: { page, limit, total: cards.length, totalPages: Math.ceil(cards.length / limit) || 1 },
    };
  }

  // The approved lines this vendor is on, read from the quotation's
  // categoryApprovals — the same source both boards build their rows from.
  static approvedLinesFor(quotation, vendorId) {
    const itemById = new Map((quotation.items || []).map((it) => [String(it._id), it]));
    const lines = [];
    (quotation.categoryApprovals || [])
      .filter((ca) => ca.status === CATEGORY_APPROVAL_STATUS.APPROVED)
      .forEach((ca) =>
        (ca.selections || []).forEach((sel) => {
          if (String(sel.vendorId) !== String(vendorId)) return;
          const item = itemById.get(String(sel.itemId));
          if (item) lines.push({ ca, sel, item });
        })
      );
    return lines;
  }

  /*
    Bring a dropped vendor back into the flow — the "Mark as Required" button
    on the Not Required register.

    The exclusions are cleared, not kept. They are what made the vendor Not
    Required in the first place, so leaving them would send the row straight
    back where it came from. It returns to ENTITY_PENDING, which is exactly the
    screen where "Not Required" lives, so anything that really should stay out
    can be taken out again in one click.
  */
  static async markRequired(id, actor, session, dataAccess) {
    const tracking = await StockTrackingOrderModel.findOne({ _id: id, isActive: true }).session(session);
    if (!tracking) throw new Error("Tracking order not found");
    if (!isWithinDataScope(tracking, dataAccess, SCOPE_MODULE_KEY)) {
      throw new Error("Tracking order not found");
    }
    if (tracking.status !== TRACKING_STATUS.NOT_REQUIRED) {
      throw new Error("This vendor order is already required");
    }

    const before = tracking.toObject();
    const restoredNames = (tracking.excludedItems || []).map((e) => e.productName || "");

    tracking.status = TRACKING_STATUS.ENTITY_PENDING;
    tracking.excludedItems = [];
    tracking.notRequiredReason = "";
    tracking.disabledBy = null;
    tracking.disabledByName = "";
    tracking.disabledAt = null;
    // The excluded list is gone by design; this is what is left to say it
    // happened at all.
    tracking.activity.push({
      type: "REQUIRED",
      scope: "WHOLE_VENDOR",
      products: restoredNames,
      productCount: restoredNames.length,
      reason: "",
      byName: actor?.name || "",
      at: new Date(),
    });
    await tracking.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: tracking._id, action: "MARK_REQUIRED",
      actor, before, after: tracking.toObject(),
      reason: `${before.excludedItems?.length || 0} excluded lines restored`,
    });
    return tracking;
  }

  /*
    Reset a vendor order back to the very start — the accounts team's only way
    to change an order once it has left the Tracking Orders page.

    It is a FULL rewind on purpose. The purchase order is deleted and its
    number is not reused, the entity is cleared so it can be chosen again, and
    the lines are freed. Deliberately NOT cleared: excludedItems. A reset says
    "raise this order again", not "forget what we decided not to buy" — and
    those decisions are still editable on the screen this sends the row back to.

    Not available once the PO is approved: at that point it has been mailed to
    the vendor, and nothing here can unsend that.
  */
  static async resetOrder(id, payload, actor, session, dataAccess) {
    const { reason } = payload || {};
    const tracking = await StockTrackingOrderModel.findOne({ _id: id, isActive: true }).session(session);
    if (!tracking) throw new Error("Tracking order not found");
    if (!isWithinDataScope(tracking, dataAccess, SCOPE_MODULE_KEY)) {
      throw new Error("Tracking order not found");
    }

    const RESETTABLE = [
      TRACKING_STATUS.PO_PENDING,
      TRACKING_STATUS.PO_GENERATED,
      TRACKING_STATUS.REJECTED,
    ];
    if (!RESETTABLE.includes(tracking.status)) {
      throw new Error("This order can no longer be reset");
    }
    if (tracking.mailResult?.mode) {
      throw new Error("Cannot reset — this order has already been sent to the vendor");
    }

    const before = tracking.toObject();

    // Delete the PO, if one got as far as being generated, and hand its lines
    // back to the quotation so a future PO can pick them up again.
    let voidedPoNumber = "";
    const po = await StockPurchaseOrderModel.findOne({
      _id: tracking.poId,
      isActive: true,
    }).session(session);
    if (po) {
      voidedPoNumber = po.poNumber || "";
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
      await po.save({ session });
    }

    tracking.resets.push({
      reason: String(reason || "").trim(),
      voidedPoNumber,
      clearedEntityAlias: tracking.buyerEntity?.alias || "",
      resetBy: actor?.id || actor?._id || null,
      resetByName: actor?.name || "",
      resetAt: new Date(),
    });

    tracking.buyerEntity = {};
    tracking.poId = null;
    tracking.mailResult = null;
    tracking.status = TRACKING_STATUS.ENTITY_PENDING;
    await tracking.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: tracking._id, action: "RESET_ORDER",
      actor, before, after: tracking.toObject(),
      reason: `${voidedPoNumber ? `${voidedPoNumber} voided: ` : ""}${String(reason || "").trim()}`,
    });
    return tracking;
  }

  /*
    Set which of this vendor's approved lines will NOT be ordered.

    One screen only: "Not Required" on the Tracking Orders page, and only while
    the order is still ENTITY_PENDING. The accounts team never edits these — if
    they need something changed they reset the order, which sends the whole
    thing back to that screen.

    `excludedItemIds` is the COMPLETE list, not a delta — sending fewer ids
    puts the omitted lines back. Dropping the whole vendor is simply every id,
    which is why there is no separate flag for it: "unchecked everything" and
    "not required at all" must not become two states that look identical.
  */
  static async setExclusions(id, payload, actor, session, dataAccess) {
    const { excludedItemIds = [], reason } = payload || {};
    const tracking = await StockTrackingOrderModel.findOne({ _id: id, isActive: true }).session(session);
    if (!tracking) throw new Error("Tracking order not found");
    if (!isWithinDataScope(tracking, dataAccess, SCOPE_MODULE_KEY)) {
      throw new Error("Tracking order not found");
    }

    // Only before an entity is assigned. Once it is, the order has moved to the
    // accounts team; getting it back is their call — Reset Order — not an edit
    // made underneath them.
    if (tracking.status !== TRACKING_STATUS.ENTITY_PENDING) {
      // Two very different reasons to be here, and one message for both would
      // send people looking in the wrong place.
      throw new Error(
        tracking.status === TRACKING_STATUS.NOT_REQUIRED
          ? "This vendor is marked Not Required — use Mark as Required on the Not Required page to bring it back"
          : "This order has moved to the PO board — it has to be reset before these products can change"
      );
    }

    const quotation = await StockQuotationModel.findOne({
      _id: tracking.sourceQuotationId,
      isActive: true,
    })
      .session(session)
      .lean();
    if (!quotation) throw new Error("Source quotation not found");

    const lines = StockTrackingOrderService.approvedLinesFor(quotation, tracking.vendorId);
    const lineById = new Map(lines.map((l) => [String(l.item._id), l]));

    const wanted = [...new Set((excludedItemIds || []).map(String))];
    const stray = wanted.find((itemId) => !lineById.has(itemId));
    if (stray) throw new Error("A selected line is not an approved line of this vendor");

    // Keep the original stamp for a line that was already excluded — who first
    // decided it, and when, is the fact worth keeping; re-saving the same list
    // must not rewrite it to today's user.
    const existing = new Map((tracking.excludedItems || []).map((e) => [String(e.quotationItemId), e]));
    const now = new Date();
    const trimmedReason = String(reason || "").trim();

    const before = tracking.toObject();
    tracking.excludedItems = wanted.map((itemId) => {
      const prior = existing.get(itemId);
      if (prior) return prior;
      const { ca, sel, item } = lineById.get(itemId);
      return {
        quotationItemId: item._id,
        productDefinitionId: sel.productDefinitionId,
        productName: sel.productName || item.productName || "",
        categoryId: ca.categoryId,
        categoryName: ca.categoryName || "",
        quantity: sel.quantity,
        lineTotal: sel.lineTotal,
        reason: trimmedReason,
        excludedBy: actor?.id || actor?._id || null,
        excludedByName: actor?.name || "",
        excludedAt: now,
      };
    });

    // Every line gone => the vendor itself is Not Required. Fewer than all =>
    // the row goes back to whichever open state its entity assignment implies.
    const allGone = lines.length > 0 && wanted.length === lines.length;

    // One save can both drop products and put others back, so each direction
    // gets its own timeline entry rather than a single netted-off one that
    // would read as if only the larger change happened.
    const added = wanted.filter((itemId) => !existing.has(itemId));
    const removed = [...existing.keys()].filter((itemId) => !wanted.includes(itemId));
    const stamp = { reason: trimmedReason, byName: actor?.name || "", at: now };
    const addedNames = added.map((itemId) => lineById.get(itemId)?.sel?.productName || "");
    const removedNames = removed.map((itemId) => existing.get(itemId)?.productName || "");
    if (added.length) {
      tracking.activity.push({
        type: "NOT_REQUIRED",
        scope: allGone ? "WHOLE_VENDOR" : "SOME_PRODUCTS",
        products: addedNames,
        productCount: added.length,
        ...stamp,
      });
    }
    if (removed.length) {
      tracking.activity.push({
        type: "REQUIRED",
        scope: "SOME_PRODUCTS",
        products: removedNames,
        productCount: removed.length,
        ...stamp,
      });
    }
    if (allGone) {
      tracking.status = TRACKING_STATUS.NOT_REQUIRED;
      tracking.notRequiredReason = trimmedReason;
      tracking.disabledBy = actor?.id || actor?._id || null;
      tracking.disabledByName = actor?.name || "";
      tracking.disabledAt = now;
    } else {
      tracking.status = tracking.buyerEntity?.alias
        ? TRACKING_STATUS.PO_PENDING
        : TRACKING_STATUS.ENTITY_PENDING;
      tracking.notRequiredReason = "";
      tracking.disabledBy = null;
      tracking.disabledByName = "";
      tracking.disabledAt = null;
    }

    await tracking.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: tracking._id,
      action: "MARK_NOT_REQUIRED",
      actor,
      before,
      after: tracking.toObject(),
      reason: `${wanted.length}/${lines.length} lines excluded: ${trimmedReason}`,
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
