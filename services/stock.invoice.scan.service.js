import StockAiScanLogModel from "../models/stock.ai.scan.log.model.js";
import StockAiSettingsService from "./stock.ai.settings.service.js";
import { aiModelById, estimateCostUsd } from "../config/ai.models.js";
import { getClaudeClient, claudeErrorMessage } from "../helpers/claude.client.helper.js";
import { getLogger } from "../helpers/logger.helper.js";

/*
  Reads an uploaded vendor invoice with Claude and returns what it says,
  mapped onto the PO it was raised against.

  Claude gets the file (PDF as a document, a photo as an image) plus the PO's
  products, each with a short ref (P1, P2…), and answers in a fixed JSON
  schema (structured output) — so the reply always parses. It only READS:
  every value lands on the Add Invoice form as a suggestion, checked and
  corrected by a person before anything is saved.

  The server then checks the answer against the PO and turns doubts into
  warnings: an invoice line no PO product matches, more than the PO has left,
  a rate off the PO rate, a vendor / GSTIN that is not the PO's vendor.
*/
const log = getLogger(import.meta.url);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const RATE_TOLERANCE = 0.01; // 1% — rounding on the invoice is not a mismatch
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["readable", "invoiceNumber", "invoiceDate", "totalAmount", "vendorName", "vendorGstin", "lines", "extraCharges", "notes"],
  properties: {
    readable: { type: "boolean", description: "false if this is not a readable invoice" },
    invoiceNumber: { type: "string", description: "exactly as printed; empty if not found" },
    invoiceDate: { type: "string", description: "YYYY-MM-DD; empty if not found" },
    totalAmount: { type: "number", description: "grand total payable incl. GST and charges; 0 if not found" },
    vendorName: { type: "string", description: "seller / supplier name; empty if not found" },
    vendorGstin: { type: "string", description: "seller GSTIN; empty if not found" },
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "quantity", "unitPrice", "poRef"],
        properties: {
          description: { type: "string" },
          quantity: { type: "number" },
          unitPrice: { type: "number", description: "rate per unit BEFORE GST; 0 if not printed" },
          poRef: { type: "string", description: "ref of the matching PO product (e.g. P2), or empty if none matches" },
        },
      },
    },
    extraCharges: {
      type: "array",
      description: "freight, transport, packing, handling etc. — amounts before GST",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["note", "amount"],
        properties: { note: { type: "string" }, amount: { type: "number" } },
      },
    },
    notes: { type: "string", description: "anything unclear, in one short sentence; empty if all clear" },
  },
};

const SYSTEM = `You read Indian GST tax invoices for a purchase team and extract their contents exactly.

Rules:
- Copy values exactly as printed. Never guess or invent a value: use "" or 0 when it is not on the invoice.
- invoiceDate as YYYY-MM-DD (Indian invoices print day first: 05/03/2026 is 5 March 2026).
- lines: every product line on the invoice. quantity as a number (a "10 Nos" line is 10; metres stay metres). unitPrice is the rate per unit before GST.
- Match each line to one product from the PO list by meaning (model numbers, brand, type), not by exact wording. Put that product's ref in poRef. If no PO product is clearly the same item, leave poRef empty — a wrong match is worse than none.
- extraCharges: freight, transport, cartage, packing, loading/handling, courier and similar charges billed on the invoice — not GST, not round-off, not discounts.
- totalAmount: the final invoice total (grand total / amount payable).
- Set readable to false only if the file is not an invoice or cannot be read at all.`;

// The real type, from the file's first bytes — a renamed photo (.png that is
// really a JPEG) is common, and Claude refuses a mismatched media type.
const sniffType = (buf, declared) => {
  if (buf.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return declared === "image/jpg" ? "image/jpeg" : declared;
};

const mediaBlock = (file) => {
  const data = file.buffer.toString("base64");
  const type = sniffType(file.buffer, file.mimetype);
  if (type === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
  }
  return { type: "image", source: { type: "base64", media_type: type, data } };
};

export default class StockInvoiceScanService {
  /**
   * @param file      multer memory file { buffer, mimetype, size }
   * @param poItems   [{ quotationItemId, productName, unit, remaining, unitPrice, gstRate }]
   * @param vendor    { name, gstin } — the PO's vendor
   * @param context   { trackingOrderId, user }
   */
  static async scan(file, poItems, vendor, { trackingOrderId = null, user = null } = {}) {
    const settings = await StockAiSettingsService.get();
    if (!settings.invoiceScan.enabled) throw new Error("AI invoice scan is switched off in AI Settings — enter the details by hand");
    const model = settings.invoiceScan.model;
    const modelInfo = aiModelById(model);
    if (!modelInfo) throw new Error("Invalid AI model");

    const refs = poItems.map((it, i) => ({ ref: `P${i + 1}`, ...it }));
    const poList = refs
      .map((r) => `${r.ref}: ${r.productName} — still to invoice ${r.remaining}${r.unit === "meter" ? " m" : ""}, PO rate ₹${r.unitPrice} + GST ${r.gstRate}%`)
      .join("\n");

    const request = {
      model,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            mediaBlock(file),
            { type: "text", text: `Products on this purchase order (vendor: ${vendor.name || "—"}):\n${poList}\n\nExtract this invoice.` },
          ],
        },
      ],
    };

    const started = Date.now();
    const logRow = {
      model, fileType: file.mimetype, fileBytes: file.size || 0, trackingOrderId,
      byUserId: user?._id || null, byName: user?.name || "",
    };
    let res;
    try {
      const client = getClaudeClient();
      // Sonnet / Opus: a rare policy decline is retried on another model inside the same call.
      res = modelInfo.fallback
        ? await client.beta.messages.create({ ...request, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
        : await client.messages.create(request);
    } catch (err) {
      const message = claudeErrorMessage(err);
      await StockAiScanLogModel.create({ ...logRow, ok: false, error: message, durationMs: Date.now() - started }).catch(() => {});
      log.error(`Invoice scan failed: ${message}`);
      throw new Error(message);
    }

    const durationMs = Date.now() - started;
    const usage = { inputTokens: res.usage?.input_tokens || 0, outputTokens: res.usage?.output_tokens || 0 };
    const finish = (ok, error = "") =>
      StockAiScanLogModel.create({
        ...logRow, servedBy: res.model || model, ok, error, durationMs, ...usage, costUsd: estimateCostUsd(res.model || model, usage),
      }).catch(() => {});

    if (res.stop_reason === "refusal") {
      await finish(false, "refused");
      throw new Error("Claude declined to read this file — enter the details by hand");
    }
    if (res.stop_reason === "max_tokens") {
      await finish(false, "answer cut off");
      throw new Error("The invoice was too long to read in one go — enter the details by hand");
    }
    let out;
    try {
      const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      out = JSON.parse(text);
    } catch {
      await finish(false, "unreadable answer");
      throw new Error("Claude's answer could not be read — try Re-scan");
    }
    await finish(true);
    if (!out.readable) throw new Error(out.notes || "This file doesn't look like a readable invoice");

    return { ...StockInvoiceScanService._check(out, refs, vendor), model: res.model || model, seconds: round2(durationMs / 1000) };
  }

  // Map the answer onto PO lines and say what does not add up.
  static _check(out, refs, vendor) {
    const warnings = [];
    const byRef = new Map(refs.map((r) => [r.ref, r]));
    const qty = new Map(); // ref → quantity on the invoice
    const rates = new Map(); // ref → rates seen

    for (const line of out.lines || []) {
      const r = byRef.get(String(line.poRef || "").trim().toUpperCase());
      if (!r) {
        warnings.push(`“${line.description}” (qty ${line.quantity}) is not on this PO — not filled in`);
        continue;
      }
      qty.set(r.ref, round2((qty.get(r.ref) || 0) + (Number(line.quantity) || 0)));
      if (Number(line.unitPrice) > 0) rates.set(r.ref, [...(rates.get(r.ref) || []), Number(line.unitPrice)]);
    }

    for (const r of refs) {
      const q = qty.get(r.ref) || 0;
      if (q > r.remaining) warnings.push(`${r.productName}: invoice says ${q}, but only ${r.remaining} is left on the PO`);
      for (const rate of rates.get(r.ref) || []) {
        if (r.unitPrice > 0 && Math.abs(rate - r.unitPrice) / r.unitPrice > RATE_TOLERANCE) {
          warnings.push(`${r.productName}: invoice rate ₹${rate}, PO rate ₹${r.unitPrice}`);
        }
      }
    }

    const gstin = String(out.vendorGstin || "").toUpperCase().replace(/\s/g, "");
    if (gstin && vendor.gstin && gstin !== String(vendor.gstin).toUpperCase()) {
      warnings.push(`Invoice GSTIN ${gstin} is not the PO vendor's (${vendor.gstin})`);
    } else if (!gstin && out.vendorName && vendor.name) {
      const a = norm(out.vendorName);
      const b = norm(vendor.name);
      if (a && b && !a.includes(b) && !b.includes(a)) warnings.push(`Invoice is from “${out.vendorName}”, the PO is with “${vendor.name}”`);
    }
    if (!out.invoiceNumber) warnings.push("Invoice number not found — enter it by hand");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.invoiceDate || "")) warnings.push("Invoice date not found — enter it by hand");
    if (out.notes) warnings.push(out.notes);

    return {
      source: "AI",
      invoiceNumber: String(out.invoiceNumber || "").trim(),
      invoiceDate: /^\d{4}-\d{2}-\d{2}$/.test(out.invoiceDate || "") ? out.invoiceDate : "",
      invoiceAmount: round2(out.totalAmount || 0),
      vendorName: out.vendorName || "",
      vendorGstin: gstin,
      lines: refs.map((r) => ({
        quotationItemId: r.quotationItemId,
        productName: r.productName,
        invoiceQuantity: qty.get(r.ref) || 0,
      })),
      extraCharges: (out.extraCharges || [])
        .filter((c) => Number(c.amount) > 0)
        .map((c) => ({ note: String(c.note || "").trim(), amount: round2(c.amount), includeInBilling: true })),
      warnings,
    };
  }
}
