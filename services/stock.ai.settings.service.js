import StockAiSettingsModel from "../models/stock.ai.settings.model.js";
import StockAiScanLogModel from "../models/stock.ai.scan.log.model.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import { AI_MODELS, DEFAULT_AI_MODEL, aiModelById, USD_TO_INR } from "../config/ai.models.js";
import { getClaudeClient, hasClaudeKey, claudeErrorMessage } from "../helpers/claude.client.helper.js";

/*
  AI Settings — which Claude model reads uploaded invoices, whether the scan
  is on, and what scanning has cost. The settings document is created on
  first read with the defaults (Haiku, ON).
*/
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const shape = (doc) => ({
  invoiceScan: {
    enabled: doc.invoiceScan?.enabled !== false,
    model: aiModelById(doc.invoiceScan?.model) ? doc.invoiceScan.model : DEFAULT_AI_MODEL,
  },
  models: AI_MODELS.map(({ id, label, hint, inputPerM, outputPerM }) => ({ id, label, hint, inputPerM, outputPerM })),
  keyConfigured: hasClaudeKey(),
  updatedAt: doc.updatedAt || null,
});

export default class StockAiSettingsService {
  static async _doc() {
    return StockAiSettingsModel.findOneAndUpdate(
      { key: "global" },
      { $setOnInsert: { key: "global" } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
  }

  static async get() {
    return shape(await StockAiSettingsService._doc());
  }

  static async update(body, user) {
    const before = await StockAiSettingsService._doc();
    const set = {};
    if (body?.invoiceScan?.model !== undefined) {
      if (!aiModelById(body.invoiceScan.model)) throw new Error("Invalid model — pick one from the list");
      set["invoiceScan.model"] = body.invoiceScan.model;
    }
    if (body?.invoiceScan?.enabled !== undefined) {
      if (typeof body.invoiceScan.enabled !== "boolean") throw new Error("enabled must be true or false");
      set["invoiceScan.enabled"] = body.invoiceScan.enabled;
    }
    if (!Object.keys(set).length) throw new Error("Nothing to update");
    const after = await StockAiSettingsModel.findOneAndUpdate({ key: "global" }, { $set: set }, { new: true }).lean();
    await StockAuditLogService.recordAudit({ entityType: "ai_settings", entityId: after._id, action: "UPDATE", actor: user, before, after });
    return shape(after);
  }

  /** A one-line call to the selected model — proves the key and the model work. */
  static async test() {
    const { invoiceScan } = await StockAiSettingsService.get();
    const started = Date.now();
    try {
      const res = await getClaudeClient().messages.create({
        model: invoiceScan.model,
        max_tokens: 64,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: "Reply with the single word OK." }],
      });
      return { ok: true, model: res.model, ms: Date.now() - started };
    } catch (err) {
      throw new Error(claudeErrorMessage(err));
    }
  }

  /** Scans this month and in total, with the estimated cost. */
  static async usage() {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const group = (match) =>
      StockAiScanLogModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: "$model",
            scans: { $sum: 1 },
            failed: { $sum: { $cond: ["$ok", 0, 1] } },
            costUsd: { $sum: "$costUsd" },
            avgMs: { $avg: { $cond: ["$ok", "$durationMs", null] } },
          },
        },
      ]);
    const [month, all, recent] = await Promise.all([
      group({ createdAt: { $gte: monthStart } }),
      group({}),
      StockAiScanLogModel.find({}).sort({ createdAt: -1 }).limit(10).lean(),
    ]);
    const total = (rows) => {
      const usd = rows.reduce((s, r) => s + r.costUsd, 0);
      return {
        scans: rows.reduce((s, r) => s + r.scans, 0),
        failed: rows.reduce((s, r) => s + r.failed, 0),
        costUsd: round2(usd * 100) / 100,
        costInr: round2(usd * USD_TO_INR),
        byModel: rows.map((r) => ({ model: r.model, scans: r.scans, avgSeconds: r.avgMs ? round2(r.avgMs / 1000) : null, costInr: round2(r.costUsd * USD_TO_INR) })),
      };
    };
    return {
      month: total(month),
      allTime: total(all),
      recent: recent.map((r) => ({
        at: r.createdAt, model: r.model, servedBy: r.servedBy, ok: r.ok, error: r.error,
        seconds: round2(r.durationMs / 1000), costInr: round2(r.costUsd * USD_TO_INR), byName: r.byName,
      })),
    };
  }
}
