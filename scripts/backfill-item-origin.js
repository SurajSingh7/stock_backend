/**
 * One-off: give inventory items created before origin tracking existed their
 * origin, cost, warranty and first timeline row.
 *
 *   - Invoice items (invoiceId set, no source yet): source = PURCHASE with the
 *     invoice number, purchase date = invoice date, cost = the invoice line's
 *     unit price (0 for FOC), warranty = the quoted months from that date
 *     (the product default where the quotation has none), condition = NEW.
 *   - Approved invoice items with no timeline: one RECEIVED row, dated when
 *     the invoice was approved.
 *   - Batches a transfer created before batches carried their origin have no
 *     invoice to trace back to. They are reported and left as they are.
 *
 * Serial/MAC keys are NOT built here — they follow the "Unique identifier"
 * tick on Field Definitions, and ticking it builds them for every unit (and
 * refuses, naming the values, if existing data already repeats one).
 *
 * Safe to re-run: only rows still missing a source / a timeline are touched.
 *
 * Run: node scripts/backfill-item-origin.js [--dry]
 */
import mongoose from "mongoose";
import { mongoUri } from "../config/env.config.js";
import { warrantyEndDate } from "../helpers/stock.warranty.helper.js";

const DRY = process.argv.includes("--dry");

await mongoose.connect(mongoUri);
const db = mongoose.connection.db;
const items = db.collection("inventory_items");
const movements = db.collection("inventory_item_movements");

const pending = await items
  .find({ invoiceId: { $ne: null }, $or: [{ "source.type": null }, { "source.type": { $exists: false } }] })
  .toArray();

const invoiceIds = [...new Set((await items.distinct("invoiceId", { invoiceId: { $ne: null } })).map(String))].map((id) => new mongoose.Types.ObjectId(id));
const invoices = await db.collection("invoices").find({ _id: { $in: invoiceIds } }).toArray();
const invoiceById = new Map(invoices.map((inv) => [String(inv._id), inv]));

const trackingIds = invoices.map((inv) => inv.trackingOrderId).filter(Boolean);
const trackings = await db.collection("tracking_orders").find({ _id: { $in: trackingIds } }).project({ sourceQuotationId: 1 }).toArray();
const quotationByTracking = new Map(trackings.map((t) => [String(t._id), t.sourceQuotationId]));
const quotations = await db
  .collection("quotations")
  .find({ _id: { $in: trackings.map((t) => t.sourceQuotationId).filter(Boolean) } })
  .project({ "items._id": 1, "items.warrantyMonths": 1 })
  .toArray();
const monthsByQuotationItem = new Map(quotations.flatMap((q) => (q.items || []).map((i) => [String(i._id), i.warrantyMonths ?? null])));

const products = await db.collection("product_definitions").find({}).project({ warrantyMonths: 1 }).toArray();
const productMonths = new Map(products.map((p) => [String(p._id), p.warrantyMonths ?? null]));

let stamped = 0;
let missingInvoice = 0;
for (const it of pending) {
  const inv = invoiceById.get(String(it.invoiceId));
  if (!inv) {
    missingInvoice++;
    continue;
  }
  // The invoice line this unit arrived on — by recorded id, else by product.
  const allLines = [...(inv.lines || []), ...(inv.entries || []).flatMap((e) => e.lines || [])];
  const line =
    allLines.find((l) => (l.createdInventoryItemIds || []).some((id) => String(id) === String(it._id))) ||
    (inv.lines || []).find((l) => String(l.productDefinitionId) === String(it.productDefinitionId));
  const priced = (inv.lines || []).find((l) => String(l.quotationItemId) === String(line?.quotationItemId));
  const months =
    monthsByQuotationItem.get(String(line?.quotationItemId)) ?? productMonths.get(String(it.productDefinitionId)) ?? null;

  const set = {
    source: { type: "PURCHASE", refId: inv._id, refNumber: inv.invoiceNumber || "" },
    condition: it.condition || "NEW",
    purchaseDate: inv.invoiceDate || null,
    purchaseCost: it.isFoc ? 0 : priced?.unitPrice ?? null,
    warranty: { startDate: inv.invoiceDate || null, months, endDate: warrantyEndDate(inv.invoiceDate, months) },
  };
  if (!DRY) await items.updateOne({ _id: it._id }, { $set: set });
  stamped++;
}

// First timeline row for approved invoice stock that has none.
const approved = await items
  .find({ invoiceId: { $ne: null }, approvalStatus: "APPROVED", isActive: true })
  .project({ productDefinitionId: 1, branchId: 1, quantity: 1, status: 1, invoiceId: 1, receivedAt: 1 })
  .toArray();
const withTimeline = new Set(
  (await movements.distinct("inventoryItemId", { inventoryItemId: { $in: approved.map((a) => a._id) } })).map(String)
);
const rows = approved
  .filter((a) => !withTimeline.has(String(a._id)) && invoiceById.has(String(a.invoiceId)))
  .map((a) => {
    const inv = invoiceById.get(String(a.invoiceId));
    return {
      inventoryItemId: a._id,
      productDefinitionId: a.productDefinitionId,
      type: "RECEIVED",
      at: inv?.reviewedAt || a.receivedAt || new Date(),
      quantity: a.quantity ?? null,
      toBranchId: a.branchId ?? null,
      status: a.status,
      ref: { type: "INVOICE", refId: a.invoiceId, refNumber: inv?.invoiceNumber || "" },
      relatedItemId: null,
      note: "",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });
if (!DRY && rows.length) await movements.insertMany(rows);

const orphanBatches = await items.countDocuments({
  invoiceId: null,
  $or: [{ "source.type": null }, { "source.type": { $exists: false } }],
});

console.log(`${DRY ? "[dry run] " : ""}Origin stamped on ${stamped} invoice item(s).`);
if (missingInvoice) console.log(`  ${missingInvoice} item(s) point at an invoice that no longer exists — left as they are.`);
console.log(`${DRY ? "[dry run] " : ""}RECEIVED timeline row added for ${rows.length} item(s).`);
if (orphanBatches) console.log(`  ${orphanBatches} item(s) have no invoice and no origin (older transfer batches) — left as they are.`);

await mongoose.disconnect();
