import mongoose from "mongoose";

const { Schema } = mongoose;

/*
  One row per invoice scan — what it cost and how long it took, so AI
  Settings can show "this month: 42 scans, ~₹8" and a model's real speed.
  Never the invoice contents: those belong to the invoice once it is saved.
*/
const aiScanLogSchema = new Schema(
  {
    feature: { type: String, trim: true, default: "INVOICE_SCAN" },
    model: { type: String, trim: true, required: true },
    // The model that actually answered — differs after a server-side fallback.
    servedBy: { type: String, trim: true, default: "" },
    ok: { type: Boolean, default: true },
    error: { type: String, trim: true, default: "" },
    durationMs: { type: Number, default: 0 },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    fileType: { type: String, trim: true, default: "" },
    fileBytes: { type: Number, default: 0 },
    trackingOrderId: { type: Schema.Types.ObjectId, default: null },
    byUserId: { type: Schema.Types.ObjectId, default: null },
    byName: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

aiScanLogSchema.index({ createdAt: -1 });

const StockAiScanLogModel = mongoose.model("ai_scan_logs", aiScanLogSchema, "ai_scan_logs");

export default StockAiScanLogModel;
