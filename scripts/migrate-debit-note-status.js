/**
 * Debit notes raised before the review/approval chain existed were in force
 * the day they were raised. Give each one status APPROVED, a DN number per
 * invoice (oldest first) and a one-line history, so every screen reads them the
 * same way as a note that went through the chain.
 *
 * Idempotent: only touches DEBIT_NOTE rows whose status is not one of the
 * chain's — none at all, or a leftover from the older PENDING/ACCEPTED/
 * REJECTED review (every one of those was in force when that review was
 * removed).
 *
 * Run: node scripts/migrate-debit-note-status.js
 */
import "dotenv/config";
import mongoose from "mongoose";
import StockInvoiceAdjustmentModel from "../models/stock.invoice.adjustment.model.js";
import { ADJUSTMENT_TYPE, DEBIT_NOTE_STATUS, DEBIT_NOTE_STATUS_ARRAY } from "../constants/stock.enums.js";

await mongoose.connect(process.env.MONGO_URI);

const pending = await StockInvoiceAdjustmentModel.find({
  type: ADJUSTMENT_TYPE.DEBIT_NOTE,
  status: { $nin: DEBIT_NOTE_STATUS_ARRAY },
})
  .sort({ createdAt: 1 })
  .lean();

const byInvoice = new Map();
pending.forEach((d) => {
  const k = String(d.invoiceId);
  if (!byInvoice.has(k)) byInvoice.set(k, []);
  byInvoice.get(k).push(d);
});

let updated = 0;
for (const [invoiceId, notes] of byInvoice) {
  // Continue after any number already used on this invoice.
  const top = await StockInvoiceAdjustmentModel.findOne({ invoiceId, type: ADJUSTMENT_TYPE.DEBIT_NOTE, dnNumber: { $ne: null } })
    .sort({ dnNumber: -1 })
    .select("dnNumber")
    .lean();
  let n = top?.dnNumber || 0;
  for (const d of notes) {
    n += 1;
    await StockInvoiceAdjustmentModel.updateOne(
      { _id: d._id },
      {
        $set: { status: DEBIT_NOTE_STATUS.APPROVED, dnNumber: n },
        $push: {
          history: {
            at: d.createdOn || d.createdAt || new Date(),
            by: null,
            byName: d.createdByName || "",
            action: "APPROVED",
            note: "Raised before the review and approval steps existed — in force since it was raised",
            fromAmount: null,
            toAmount: d.amount || 0,
          },
        },
      }
    );
    updated += 1;
  }
}

console.log(`Debit notes migrated to APPROVED: ${updated}`);
await mongoose.disconnect();
