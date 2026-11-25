import mongoose from "mongoose";
import { actorSnapshot } from "../models/plugins/actor.stamp.plugin.js";

import StockPurchaseOrderModel from "../models/stock.purchase.order.model.js";
import StockQuotationModel from "../models/stock.quotation.model.js";
import StockVendorModel from "../models/stock.vendor.model.js";
import "../models/stock.category.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";

import StockTermsConditionService from "./stock.terms.condition.service.js";
import StockTrackingOrderService from "./stock.tracking.order.service.js";
import StockInternalEntityService from "./stock.internal.entity.service.js";
import StockAlertManualService from "./stock.alert.manual.service.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import StockTrackingOrderModel from "../models/stock.tracking.order.model.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import { nextDocumentNumber } from "../helpers/document.number.helper.js";
import { readVendorOrders, sumBy, sortBoardByLatest } from "./stock.vendor.order.reader.js";
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

// The PO's requester, named from the session. HRMS can leave first/last name
// blank on a Login, and this string is printed on the vendor's PDF, so it falls
// back to identifiers that always exist rather than going out empty.
const requesterName = (user) =>
  (user?.name || "").trim() || user?.employeeCode || user?.email || "";
import { getLogger } from "../helpers/logger.helper.js";
import { generatePOPdf } from "../helpers/stock.po.pdf.helper.js";
import {
  PO_STATUS,
  PO_TAX_TYPE,
  TERMS_SOURCE,
  TRACKING_STATUS,
  MAIL_MODE,
  MAIL_REACHED_VENDOR,
  ALERT_CHANNEL,
} from "../constants/stock.enums.js";

const log = getLogger(import.meta.url);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const ENTITY_TYPE = "purchase-orders";
const QUOTATION_ENTITY_TYPE = "quotations";

export default class StockPurchaseOrderService {
  // Was countDocuments + 1, which hands two simultaneous creates the same
  // number — and poNumber carries a unique index, so the second one died on a
  // raw duplicate-key error. See helpers/document.number.helper.js.
  static generatePONumber(session) {
    return nextDocumentNumber({
      model: StockPurchaseOrderModel,
      field: "poNumber",
      prefix: "PO",
      session,
    });
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

  /*
    getCandidates used to sit here — "approved selections not yet on a PO,
    grouped by vendor". It was born in the same commit as getBoard, as a second
    answer to the same question, and getBoard is the one that won: nothing in
    any frontend ever called it.

    Removed rather than left dormant, because it was also wrong. It took no
    dataAccess (so it ignored the entity scope every other read applies), it
    never looked at trackingOrder.excludedItems (so it offered lines marked Not
    Required), and it ignored the tracking status (so it offered lines for
    vendors with no entity yet, and for vendors dropped entirely) — all three
    of which createPurchaseOrder refuses anyway.

    What the PO create screen actually uses: the board row's own items, which
    come from getBoard below.
  */

  /* ---------------------------------------------------------------------- */
  /* Board — one entry per quotation, each with vendor sections              */
  /* ---------------------------------------------------------------------- */


  static async getBoard(query = {}, dataAccess) {
    const { search, vendorId, categoryId, productId, entityAlias, status, dateFrom, dateTo, branchId } = query;

    // Every vendor order, assembled once. Shared with the Tracking Orders
    // board — see services/stock.vendor.order.reader.js.
    const vendorOrders = await readVendorOrders({ sourceQuotationId: query.sourceQuotationId });

    // A vendor row belongs on THIS board only once its tracking order has
    // moved past ENTITY_PENDING — and never once it is NOT_REQUIRED.
    const VISIBLE_TRACKING_STATUSES = new Set([
      TRACKING_STATUS.PO_PENDING,
      TRACKING_STATUS.PO_GENERATED,
      TRACKING_STATUS.PO_APPROVED,
      TRACKING_STATUS.AWAITING_DELIVERY,
      TRACKING_STATUS.PARTLY_RECEIVED,
      TRACKING_STATUS.FULLY_RECEIVED,
      TRACKING_STATUS.CLOSED_SHORT,
      TRACKING_STATUS.REJECTED,
    ]);

    const fullBoard = [];
    vendorOrders.forEach(({ quotation: q, approvalDate, vendors }) => {
      const rows = [];
      vendors.forEach((entry) => {
        const { vendorId: vId, vendor: v, tracking, po } = entry;
        if (!tracking || !VISIBLE_TRACKING_STATUSES.has(tracking.status)) return;

        const primary = (v.contacts || []).find((c) => c.label === "PRIMARY") || (v.contacts || [])[0] || {};
        const row = {
          vendorName: entry.vendorName,
          phone: primary.phone || "", email: primary.email || "", contactName: primary.name || "",
          // Full recipient list, split the way the vendor was configured. The
          // Send Mail dialog shows these instead of guessing from the primary
          // contact alone. No "|| TO" fallback: the default is NONE, so
          // treating a missing value as TO would mail people who opted out.
          mailTo: (v.contacts || [])
            .filter((c) => c.recipientType === "TO" && c.email)
            .map((c) => ({ name: c.name || "", email: c.email })),
          mailCc: (v.contacts || [])
            .filter((c) => c.recipientType === "CC" && c.email)
            .map((c) => ({ name: c.name || "", email: c.email })),
          gstNumber: v.gst?.gstNumber || "", address: v.address?.fullAddress || "",
          state: v.gst?.state?.name || v.address?.state?.name || "",
          stateCode: v.gst?.state?.code || v.address?.state?.code || "",
          paymentTerms: v.paymentTerms || "",
          // Lines already consumed by a PO are not offered again; excluded
          // lines never reach "Create PO" at all. createPurchaseOrder enforces
          // the same rule server-side, so hiding the button is not the only
          // guard.
          _pending: entry.lines.filter((l) => !l.poId),
          _skipped: entry.excludedLines.filter((l) => !l.poId),
        };
        let statusVal, items, poId = null, poNumber = "";
        // Local, not the outer query.entityAlias filter — this is the row's OWN
        // alias, read fresh per row.
        const rowEntityAlias = tracking.buyerEntity?.alias || "";
        let totalAmount = 0, totalQuantity = 0, rejectedReason = "", filterDate = approvalDate;
        let createdBy = null;

        if (po) {
          poId = po._id; poNumber = po.poNumber; statusVal = po.status;
          // Carried so the ownership filter below has something to read. Without
          // it row.createdBy was undefined and every OWN-scoped user saw an
          // empty board.
          createdBy = po.createdBy || null;
          // entry.poItems is po.items with warranty attached by the reader —
          // this board doesn't show warranty, but sharing the same array means
          // there's only one place that ever builds a PO's board-facing lines.
          items = entry.poItems;
          totalAmount = po.grandTotal;
          totalQuantity = sumBy(items, "quantity");
          rejectedReason = po.rejectedReason || "";
          filterDate = po.status === "GENERATED" ? po.createdAt : (po.reviewedAt || po.updatedAt || po.createdAt);
        } else {
          statusVal = "PO_PENDING"; items = row._pending;
          totalAmount = round2(sumBy(items, "lineTotal"));
          totalQuantity = sumBy(items, "quantity");
          filterDate = approvalDate;
        }

        if (!po && items.length === 0 && row._skipped.length === 0) return;

        const catIds = [...new Set(items.map((i) => String(i.categoryId)).filter(Boolean))];
        const prodIds = [...new Set(items.map((i) => String(i.productDefinitionId)).filter(Boolean))];

        rows.push({
          // Revise Order writes to the TRACKING order, not the PO, so the row
          // has to carry its id — without it the client posts to
          // /tracking-orders/undefined/revise and Mongo throws a CastError.
          trackingOrderId: tracking._id,
          resets: tracking.resets || [],
          activity: tracking.activity || [],
          vendorId: vId, vendorName: row.vendorName, phone: row.phone, email: row.email, contactName: row.contactName,
          // The branch the vendor belongs to (vendor master) — the Branch filter.
          branchId: v.branchId || null,
          mailTo: row.mailTo || [], mailCc: row.mailCc || [],
          gstNumber: row.gstNumber, address: row.address, state: row.state, stateCode: row.stateCode,
          paymentTerms: row.paymentTerms,
          poId, poNumber, status: statusVal, entityAlias: rowEntityAlias, createdBy,
          buyerEntity: tracking.buyerEntity || {},
          // The state was switched on Create PO — shown on the board with its reason.
          stateChange: po?.stateChange || null,
          items, totalAmount, totalQuantity, excludedItems: row._skipped, filterDate,
          rejectedReason,
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
    sortBoardByLatest(fullBoard);

    // ── server-side filters ───────────────────────────────────────────────────
    const t = search ? String(search).toLowerCase().trim() : "";
    const from = dateFrom ? new Date(dateFrom) : null;
    const to = dateTo ? new Date(dateTo + "T23:59:59") : null;

    const rowPass = (row, quotationNumber, ignoreStatus) => {
      if (!ignoreStatus && status && row.status !== status) return false;
      if (vendorId && String(row.vendorId) !== String(vendorId)) return false;
      if (entityAlias && (row.entityAlias || "") !== entityAlias) return false;
      if (branchId && String(row.branchId || "") !== String(branchId)) return false;
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
        board.flatMap((q) => q.rows.flatMap((r) => [...r.items, ...(r.excludedItems || [])].map((it) => String(it.productDefinitionId))))
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
        if (r.excludedItems) r.excludedItems = r.excludedItems.map(attachProductMeta);
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
  /*
    disableVendor / enableVendor used to live here. They wrote
    quotation.disabledVendors[], which nothing enforced (createPurchaseOrder
    never read it) and nothing in the UI could even set — only the "Enable"
    undo was wired up. Excluding a vendor or a line is now one mechanism on the
    tracking order: StockTrackingOrderService.setExclusions, reached from
    "Not Required" (Tracking Orders) and "Revise Order" (PO board), and
    actually enforced in getBoard and createPurchaseOrder below.
  */

  /*
    Turn the requested quotation item ids into PO lines, with the running
    totals, and refuse anything that must not be on this order.

    Every rejection here is a rule, not a convenience: an item that is not an
    approved selection, belongs to another vendor, is already on a PO, or was
    marked Not Required. The board hides all four, but the board is only the
    button — this is what actually stops a crafted request.

    Prices come from the approved SELECTION, never from the request: what was
    approved is what gets ordered.
  */
  static buildPoLines({ quotation, quotationItemIds, vendorId, excludedIds, taxType }) {
    const wantIds = new Set((quotationItemIds || []).map(String));
    if (wantIds.size === 0) throw new Error("Select at least one item for the PO");

    const selByItemId = new Map();
    (quotation.categoryApprovals || [])
      .filter((ca) => ca.status === "APPROVED")
      .forEach((ca) =>
        (ca.selections || []).forEach((sel) => selByItemId.set(String(sel.itemId), { ca, sel }))
      );

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
      if (excludedIds.has(itemId)) {
        throw new Error(`${item.productName} was excluded from this order and can't be added`);
      }

      const { sel, ca } = found;
      const taxable = round2(sel.quantity * sel.unitPrice);
      const { cgst, sgst, igst, gstAmount } = StockPurchaseOrderService.computeLineTax(
        taxable,
        sel.gstRate,
        taxType
      );

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
        lineTotal: round2(taxable + gstAmount),
      });
    }

    return { items, subTotal, cgstTotal, sgstTotal, igstTotal };
  }

  // Everything about the vendor the PO freezes at create time. Snapshotted, not
  // referenced: a later edit to the vendor master must not rewrite an order
  // that has already gone out.
  static vendorSnapshot(vendor) {
    const primary =
      (vendor.contacts || []).find((c) => c.label === "PRIMARY") || (vendor.contacts || [])[0] || {};
    return {
      vendorName: vendor.name || "",
      vendorGstin: vendor.gst?.gstNumber || "",
      vendorAddress: vendor.address?.fullAddress || "",
      vendorState: vendor.gst?.state?.name || vendor.address?.state?.name || "",
      vendorStateCode: StockPurchaseOrderService.vendorStateCode(vendor),
      vendorPhone: primary.phone || "",
      vendorEmail: primary.email || "",
      paymentTerms: vendor.paymentTerms || "",
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Create — one PO from the given quotation item ids (all same vendor)     */
  /* ---------------------------------------------------------------------- */

  static async createPurchaseOrder(body, user, session, dataAccess) {
    const {
      sourceQuotationId,
      vendorId,
      quotationItemIds,

      poDate,
      shipmentPreference,
      notes,
      termsConditionId,
      buyerEntityId,
      stateChangeReason,
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
    const assigned = tracking.buyerEntity;

    /*
      The Create PO screen may switch to ANOTHER STATE of the same entity
      (same alias, a different ERP record with its own GST and address). Only
      the id is taken from the client; the snapshot is resolved from the ERP
      list, exactly like addEntity. A different alias is refused — changing the
      entity itself would move the order across data scopes. The reason is
      mandatory because the state decides CGST+SGST vs IGST on a real PO.
    */
    let buyerEntity = assigned;
    let stateChange = null;
    if (buyerEntityId && String(buyerEntityId) !== String(assigned.entityId || "")) {
      const picked = await StockInternalEntityService.resolve(buyerEntityId);
      if (!picked) throw new Error("That state no longer exists or is not available");
      if (String(picked.alias || "").toUpperCase() !== String(assigned.alias || "").toUpperCase()) {
        throw new Error("Invalid state — only another state of " + (assigned.alias || "the assigned entity") + " can be picked");
      }
      if (!picked.stateCode) throw new Error((picked.alias || "This entity") + " has no state code for " + (picked.state || "that state") + " in the ERP — fix it there first");
      const reason = String(stateChangeReason || "").trim();
      if (!reason) throw new Error("A reason is required to change the state");
      stateChange = {
        fromState: assigned.state || "", fromStateCode: String(assigned.stateCode || ""),
        toState: picked.state || "", toStateCode: String(picked.stateCode),
        reason, changedBy: requesterName(user), changedAt: new Date(),
      };
      buyerEntity = { ...picked };
      // The tracking order follows the PO, so its card, invoices and filters
      // show the state the PO was actually raised in.
      tracking.buyerEntity = { ...picked };
    }

    // Lines excluded on the tracking order ("Not Required" / "Revise Order")
    // are refused here, not just hidden on the board — the board's Create PO
    // button disappearing is a convenience, this is the actual rule.
    const excludedIds = new Set(
      (tracking.excludedItems || []).map((e) => String(e.quotationItemId))
    );

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

    // Same state means the tax splits into CGST+SGST; different states means
    // one IGST line. Derived from the two snapshots, never sent by the client.
    const buyerStateCode = String(buyerEntity?.stateCode || "");
    const vendorStateCode = String(StockPurchaseOrderService.vendorStateCode(vendor));
    const taxType =
      buyerStateCode && buyerStateCode === vendorStateCode
        ? PO_TAX_TYPE.CGST_SGST
        : PO_TAX_TYPE.IGST;

    const { items, subTotal, cgstTotal, sgstTotal, igstTotal } =
      StockPurchaseOrderService.buildPoLines({
        quotation,
        quotationItemIds,
        vendorId,
        excludedIds,
        taxType,
      });
    const gstTotal = round2(cgstTotal + sgstTotal + igstTotal);
    const grandTotal = round2(subTotal + gstTotal);
    const poNumber = await StockPurchaseOrderService.generatePONumber(session);

    const [po] = await StockPurchaseOrderModel.create(
      [
        {
          poNumber,
          sourceQuotationId,
          vendorId,
          ...StockPurchaseOrderService.vendorSnapshot(vendor),
          buyerEntity: {
            entityId: buyerEntity?.entityId || null,
            name: buyerEntity?.name || "",
            alias: buyerEntity?.alias || "",
            gstNumber: buyerEntity?.gstNumber || "",
            address: buyerEntity?.address || "",
            state: buyerEntity?.state || "",
            stateCode: buyerStateCode,
          },
          stateChange,
          // Whoever is raising this PO, read off the authenticated session —
          // not from the form. The requester is printed on the PO PDF the
          // vendor receives, so it names a real, verifiable person rather than
          // whatever the client chose to type. Same rule as buyerEntity above.
          requester: requesterName(user),
          poDate: poDate || new Date(),
          shipmentPreference: shipmentPreference || "",
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

    // Lock the used quotation items so they can't be PO'd again. Driven by the
    // lines that were actually built, not by the requested ids — buildPoLines
    // is what decided which of those are legitimate.
    items.forEach(({ quotationItemId }) => {
      const item = quotation.items.id(quotationItemId);
      if (item) {
        item.poId = po._id;
        item.poAddedAt = new Date();
      }
    });

    // Unchecking a line at PO time used to permanently skip it here, writing
    // back onto the approved quotation. That decision now belongs to "Revise
    // Order" on the tracking order, which is reversible until a PO exists and
    // leaves the quotation — the approval record — untouched.
    await quotation.save({ session });

    // The PDF is NOT written here. generatePOPdf puts a file on disk, and a
    // file write cannot be rolled back — if this transaction later aborted the
    // PDF would be left behind as an orphan, and until then a slow disk write
    // would hold the transaction's locks open. It is generated after the
    // commit instead; see attachPdf, called by the controller.

    tracking.poId = po._id;
    tracking.status = TRACKING_STATUS.PO_GENERATED;
    await tracking.save({ session });

    log.info(`PO created: ${poNumber} (${items.length} items, ${taxType})`);
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: po._id, action: "CREATE", actor: user, before: null, after: po.toObject(),
    });
    return po;
  }

  /*
    Write the PO's PDF and record where it went — called AFTER the creating OR
    editing transaction has committed. Both createPurchaseOrder and
    updatePurchaseOrder share this: it's the one place generatePOPdf is
    ever called from.

    Deliberately outside that transaction: a file on disk cannot be rolled
    back, so generating it inside meant an aborted transaction left an orphan
    PDF behind, with the transaction's locks held open across a slow disk write
    in the meantime.

    Failing here leaves a real PO whose pdfPath is unset (create) or still
    points at its pre-edit PDF (update) — either way recoverable, since
    editing the PO again regenerates it. That is a far better failure than
    the PO's own data being lost because its PDF could not be written.
  */
  static async attachPdf(poId) {
    const po = await StockPurchaseOrderModel.findOne({ _id: poId, isActive: true });
    if (!po) return null;
    try {
      po.pdfPath = await generatePOPdf(po.toObject());
      await po.save();
      return po.pdfPath;
    } catch (err) {
      log.error(`PO ${po.poNumber}'s PDF could not be written: ${err.message}`);
      return null;
    }
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

    // requester is not editable: it names who raised this PO, stamped from the
    // session at create. An edit — including a resubmit after rejection, which
    // may well be done by someone else — does not change whose request it was.
    // The audit log is what records who touched it afterwards.
    if (body.poDate !== undefined) po.poDate = body.poDate;
    if (body.shipmentPreference !== undefined) po.shipmentPreference = body.shipmentPreference;
    // terms/termsConditionId/termsSource are immutable after create — they're
    // a point-in-time snapshot from the Terms & Conditions master, not a
    // free-text field (see createPurchaseOrder).
    if (body.notes !== undefined) po.notes = body.notes;

    // Buyer entity is no longer editable here — it's a one-time assignment
    // made on the Tracking Orders page before the PO ever existed (see
    // createPurchaseOrder) and stays fixed for the life of the PO.

    // Edit only allowed on GENERATED/REJECTED, and after edit it goes back to
    // GENERATED for a fresh review.
    po.status = PO_STATUS.GENERATED;
    po.rejectedReason = "";

    // The PDF is NOT regenerated here — same reason as createPurchaseOrder:
    // a file write can't be rolled back, so doing it inside this transaction
    // risked an orphan file on an abort and held the transaction's locks open
    // across a disk write. attachPdf does it after the controller commits.
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

  /*
    Takes no session on purpose.

    Sending is an external side effect that cannot be undone. It used to run
    inside the caller's transaction, which meant: mail reaches the vendor, a
    later write fails, everything rolls back — and the system now says "not
    sent" while the vendor is holding the PO. Nothing could repair that,
    because the mail was already gone.

    So the order is: verify, send, then record in a short transaction of its
    own. The remaining failure — sent but not recorded — is the one that IS
    repairable: the PO stays resendable, and a resend records it.
  */
  static async sendMail(id, body, user, dataAccess) {
    const po = await StockPurchaseOrderModel.findOne({ _id: id, isActive: true });
    if (!po) throw new Error("Purchase order not found");
    assertDataScope(po, dataAccess);
    // Approved covers both the first send and every resend — a PO stays
    // resendable indefinitely (see PurchaseOrderPage buildRowActions).
    if (po.status !== PO_STATUS.APPROVED) {
      throw new Error("Only an approved PO can be sent");
    }
    const before = po.toObject();

    const { sendEmail, to, cc } = body;

    // One or many. A string is still accepted so an older caller keeps working.
    const toList = (Array.isArray(to) ? to : [to])
      .map((t) => String(t || "").trim())
      .filter(Boolean);

    let mailResult;
    if (sendEmail) {
      // Checked here, not only in the dialog: the recipient list comes from the
      // vendor's contacts, and a vendor with every contact marked CC would
      // otherwise send a mail addressed to nobody.
      if (!toList.length) {
        throw new Error(
          "This vendor has no contact marked To. Edit the vendor and set at least one contact's Recipient Type to To."
        );
      }

      // Through Alerts & Escalations: the PO's Manual rule supplies the
      // subject, text and PDF; the dialog supplies To/CC. Sent at once (the
      // dialog waits), logged in the Message Log, master switch + sandbox
      // applied. Throws when nothing went out — then nothing is recorded.
      const sent = await StockAlertManualService.sendNow("PO_SEND_TO_VENDOR", po._id, {
        to: toList,
        cc: Array.isArray(cc) ? cc : [],
        actor: user,
      });

      po.emailedTo = toList.join(", ");
      po.emailedAt = new Date();
      mailResult = {
        mode: MAIL_MODE.SENT,
        channel: ALERT_CHANNEL.EMAIL,
        ruleId: sent.ruleId,
        alertMessageId: sent.messageId,
        to: sent.to,
        cc: sent.cc,
        from: process.env.MAIL_FROM_DEFAULT || "",
        sandboxedTo: sent.sandboxedTo || "",
      };
    } else {
      // Not sent by the system. Either the vendor got it some other way
      // (Sent Manually) or it is not being sent at all (Mail Skipped) — both
      // let the order move on. A missing skipMode is an older caller: MANUAL.
      const mode = body.skipMode === MAIL_MODE.SKIPPED ? MAIL_MODE.SKIPPED : MAIL_MODE.MANUAL;

      // "Skipped" would claim the vendor does not have a PO they already hold.
      if (mode === MAIL_MODE.SKIPPED) {
        const tracked = await StockTrackingOrderModel.findOne({ poId: po._id, isActive: true }).lean();
        if (MAIL_REACHED_VENDOR.includes(tracked?.mailResult?.mode)) {
          throw new Error("This PO has already reached the vendor, so its mail can no longer be skipped");
        }
      }

      mailResult = {
        mode,
        channel: ALERT_CHANNEL.EMAIL,
        to: toList,
        cc: Array.isArray(cc) ? cc.filter(Boolean) : [],
        note: typeof body.note === "string" ? body.note.trim() : "",
      };
    }

    // Recorded only now, in a transaction of its own, so the PO's emailed
    // stamp and the tracking order's mailResult either both land or neither
    // does. The mail itself is already gone by this point and is not part of
    // what can be rolled back.
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      await po.save({ session });
      await StockTrackingOrderService.recordMailResult(po._id, mailResult, session);
      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      log.error(`PO ${po.poNumber} was sent but recording it failed: ${err.message}`);
      throw new Error("The PO was sent, but saving that failed. Check the vendor's inbox before resending.");
    } finally {
      await session.endSession();
    }

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: po._id, action: "SEND_MAIL", actor: user, before, after: po.toObject(),
      reason: mailResult.mode,
    });

    return { po, mailResult };
  }

  /* ---------------------------------------------------------------------- */
  /* Soft delete — frees the quotation-item lock                             */
  /* ---------------------------------------------------------------------- */

  static async softDeletePurchaseOrder(id, user, session, dataAccess) {
    const po = await StockPurchaseOrderModel.findOne({ _id: id, isActive: true }).session(session);
    if (!po) throw new Error("Purchase order not found");
    assertDataScope(po, dataAccess);
    // With no SENT status left, "the send step is done" is whatever the
    // tracking order recorded (Mail Sent, Sent Manually or Mail Skipped) —
    // po.emailedAt alone would miss the last two.
    const tracked = await StockTrackingOrderModel.findOne({ poId: po._id, isActive: true })
      .session(session)
      .lean();
    if (po.emailedAt || tracked?.mailResult?.mode) {
      throw new Error(
        tracked?.mailResult?.mode === MAIL_MODE.SKIPPED
          ? "Cannot delete — this PO's mail was skipped and the order has moved on"
          : "Cannot delete — this PO has already been sent to the vendor"
      );
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

    // Hand the vendor order back to the stage before a PO existed. Freeing the
    // quotation items above is only half of it: createPurchaseOrder refuses
    // unless the tracking order is PO_PENDING, so without this the row was
    // stranded — its lines free, but no way to raise a replacement PO or to
    // change which lines it carries. The entity stays assigned; it was decided
    // once on the Tracking Orders page and is not undone by removing a PO.
    await StockTrackingOrderModel.updateOne(
      { poId: po._id, isActive: true },
      { $set: { status: TRACKING_STATUS.PO_PENDING, poId: null } },
      { session }
    );

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