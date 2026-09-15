import StockQuotationModel from "../models/stock.quotation.model.js";
import StockVendorModel from "../models/stock.vendor.model.js";
import StockTrackingOrderModel from "../models/stock.tracking.order.model.js";
import StockPurchaseOrderModel from "../models/stock.purchase.order.model.js";
import { QUOTATION_STATUS } from "../constants/stock.enums.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const key = (quotationId, vendorId) => `${quotationId}::${vendorId}`;

/*
  The one place that turns approved quotations into "what each vendor is being
  bought", which is the row both boards are built from.

  It used to live twice — once in the Tracking Orders board and once in the PO
  board, ~150 near-identical lines apiece. They drifted by hand every time
  something changed: the excluded-lines filter had to be written into both, and
  so did warranty. Anything true of a vendor order for both boards belongs
  here; anything only one board shows stays in that board.

  Returns, per quotation, its vendors — each with the tracking order that gates
  it, the PO if one exists, and its approved lines already split into the ones
  being ordered and the ones marked Not Required.
*/
export async function readVendorOrders({ sourceQuotationId } = {}) {
  /*
    Tracking orders first, not quotations.

    Every board row IS a tracking order, and one exists only for a vendor that
    won a category. Starting here means the quotation query is bounded by rows
    that can actually appear, instead of loading every approved quotation and
    discovering most of them contribute nothing.
  */
  const trackingFilter = { isActive: true };
  if (sourceQuotationId) trackingFilter.sourceQuotationId = sourceQuotationId;
  const trackingOrders = await StockTrackingOrderModel.find(trackingFilter).lean();

  const quotationIds = [...new Set(trackingOrders.map((t) => String(t.sourceQuotationId)))];
  if (quotationIds.length === 0) return [];

  const quotations = await StockQuotationModel.find({
    _id: { $in: quotationIds },
    isActive: true,
    status: { $in: [QUOTATION_STATUS.APPROVED, QUOTATION_STATUS.PARTIALLY_APPROVED] },
  })
    .select("quotationNumber items categoryApprovals updatedAt")
    .lean();

  const vendorIds = new Set();
  quotations.forEach((q) =>
    (q.categoryApprovals || [])
      .filter((ca) => ca.status === "APPROVED")
      .forEach((ca) => (ca.selections || []).forEach((s) => vendorIds.add(String(s.vendorId))))
  );

  const [vendors, pos] = await Promise.all([
    StockVendorModel.find({ _id: { $in: [...vendorIds] } }).lean(),
    StockPurchaseOrderModel.find({
      sourceQuotationId: { $in: quotations.map((q) => q._id) },
      isActive: true,
    }).lean(),
  ]);

  const vendorById = new Map(vendors.map((v) => [String(v._id), v]));
  const trackingByKey = new Map(trackingOrders.map((t) => [key(t.sourceQuotationId, t.vendorId), t]));
  const poByKey = new Map(pos.map((p) => [key(p.sourceQuotationId, p.vendorId), p]));

  return quotations.map((quotation) => {
    const itemById = new Map((quotation.items || []).map((it) => [String(it._id), it]));

    // The latest category decision — when this quotation became actionable.
    let approvalDate = null;
    (quotation.categoryApprovals || []).forEach((ca) => {
      if (ca.decidedAt && (!approvalDate || new Date(ca.decidedAt) > new Date(approvalDate))) {
        approvalDate = ca.decidedAt;
      }
    });

    const byVendor = new Map();
    (quotation.categoryApprovals || [])
      .filter((ca) => ca.status === "APPROVED")
      .forEach((ca) =>
        (ca.selections || []).forEach((sel) => {
          const item = itemById.get(String(sel.itemId));
          if (!item) return;
          const vId = String(sel.vendorId);
          if (!byVendor.has(vId)) {
            byVendor.set(vId, {
              vendorId: vId,
              vendorName: sel.vendorName || vendorById.get(vId)?.name || "",
              vendor: vendorById.get(vId) || {},
              tracking: trackingByKey.get(key(quotation._id, vId)) || null,
              po: poByKey.get(key(quotation._id, vId)) || null,
              lines: [],
              excludedLines: [],
            });
          }

          const taxable = round2(sel.quantity * sel.unitPrice);
          const gstAmount = round2((taxable * sel.gstRate) / 100);
          byVendor.get(vId).lines.push({
            quotationItemId: item._id,
            categoryId: ca.categoryId,
            categoryName: ca.categoryName,
            productDefinitionId: sel.productDefinitionId,
            productName: sel.productName,
            // Warranty lives on the approved SELECTION — a PO line does not
            // carry it — so it is read across here once for both boards.
            warrantyMonths: sel.warrantyMonths ?? null,
            quantity: sel.quantity,
            unitPrice: sel.unitPrice,
            gstRate: sel.gstRate,
            taxable,
            gstAmount,
            lineTotal: round2(taxable + gstAmount),
            // Which PO consumed this line, if any. Kept so a board can tell
            // "still orderable" from "already ordered" without another lookup.
            poId: item.poId || null,
          });
        })
      );

    // Split off what was marked Not Required. Both boards need exactly this,
    // and both used to do it themselves.
    byVendor.forEach((entry) => {
      const excludedById = new Map(
        (entry.tracking?.excludedItems || []).map((e) => [String(e.quotationItemId), e])
      );
      if (excludedById.size === 0) return;
      entry.excludedLines = entry.lines
        .filter((l) => excludedById.has(String(l.quotationItemId)))
        .map((l) => {
          const e = excludedById.get(String(l.quotationItemId));
          return {
            ...l,
            reason: e.reason || "",
            excludedByName: e.excludedByName || "",
            excludedAt: e.excludedAt || null,
          };
        });
      entry.lines = entry.lines.filter((l) => !excludedById.has(String(l.quotationItemId)));
    });

    return { quotation, approvalDate, vendors: [...byVendor.values()] };
  });
}
