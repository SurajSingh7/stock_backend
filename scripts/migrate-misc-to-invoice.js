/**
 * Misc moved onto the invoice (its extra charges). Every live MISC adjustment
 * is appended to its invoice's extraCharges as a billed row — so the payable
 * does not move — recorded in miscEdits, and then soft-deleted with a note
 * saying where it went. Adjustments whose invoice no longer exists are only
 * soft-deleted.
 *
 * Idempotent: only live MISC adjustments are touched.
 *
 * Run: node scripts/migrate-misc-to-invoice.js
 */
import "dotenv/config";
import mongoose from "mongoose";
import StockInvoiceAdjustmentModel from "../models/stock.invoice.adjustment.model.js";
import StockInvoiceModel from "../models/stock.invoice.model.js";
import StockInvoiceService from "../services/stock.invoice.service.js";
import { ADJUSTMENT_TYPE } from "../constants/stock.enums.js";

await mongoose.connect(process.env.MONGO_URI);

const miscs = await StockInvoiceAdjustmentModel.find({ type: ADJUSTMENT_TYPE.MISC, isActive: true });
let moved = 0, orphaned = 0;
for (const adj of miscs) {
  const invoice = await StockInvoiceModel.findOne({ _id: adj.invoiceId });
  if (invoice) {
    const rows = (adj.extras || []).length
      ? adj.extras.map((e) => ({ note: e.note || adj.reason || "Misc", amount: e.amount || 0, includeInBilling: true }))
      : [{ note: adj.reason || "Misc", amount: adj.amount || 0, includeInBilling: true }];
    const before = StockInvoiceService._sumCharges(invoice.extraCharges, true);
    invoice.extraCharges.push(...rows);
    invoice.amount = StockInvoiceService._computeAmount(invoice.lines, invoice.extraCharges);
    invoice.miscEdits.push({
      fromTotal: before,
      toTotal: StockInvoiceService._sumCharges(invoice.extraCharges, true),
      reason: "Moved from a separate misc charge" + (adj.reason ? ` (${adj.reason})` : ""),
      byName: adj.createdByName || "",
      at: adj.createdOn || adj.createdAt || new Date(),
    });
    await invoice.save();
    moved += 1;
  } else {
    orphaned += 1;
  }
  adj.isActive = false;
  adj.deletedAt = new Date();
  adj.deletedReason = invoice ? "Moved onto the invoice as misc" : "Invoice no longer exists";
  await adj.save();
}
console.log(`Misc adjustments moved onto invoices: ${moved}, invoice missing: ${orphaned}`);
await mongoose.disconnect();
