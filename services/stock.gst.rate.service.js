import { actorSnapshot } from "../models/plugins/actor.stamp.plugin.js";
import StockGstRateModel from "../models/stock.gst.rate.model.js";
import StockAuditLogService from "./stock.audit.log.service.js";

const ENTITY_TYPE = "gst-rates";

// GST slabs are the same five rows for every user in the company — there is no
// branch, entity or ownership dimension to scope them on, so this service
// deliberately makes no applyDataScope call. Registered as `{}` in
// config/data.scope.registry.js, which is what makes that explicit.

const normalizeRate = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error("rate must be a number");
  return num;
};

export default class StockGstRateService {
  static async assertRateNotDuplicate({ rate, session, excludeId = null }) {
    const filter = { rate: normalizeRate(rate) };
    if (excludeId) filter._id = { $ne: excludeId };

    const existing = await StockGstRateModel.findOne(filter).lean().session(session ?? null);
    if (!existing) return;
    if (existing.isActive) throw new Error("This GST rate already exists.");
    throw new Error(
      "This GST rate already exists in inactive records. Please restore it instead of creating a duplicate."
    );
  }

  static async createGstRate(body, actor, session) {
    const { rate, label, description, order } = body;
    await StockGstRateService.assertRateNotDuplicate({ rate, session });

    const gstRate = new StockGstRateModel({
      rate: normalizeRate(rate),
      label: label ? String(label).trim() : "",
      description: description || "",
      order: order === undefined || order === null || order === "" ? 0 : Number(order),
    });
    await gstRate.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: gstRate._id,
      action: "CREATE",
      actor,
      before: null,
      after: gstRate.toObject(),
    });

    return gstRate;
  }

  static async getAllGstRates({ skip, limit, search, showInactive }) {
    const filter = showInactive ? {} : { isActive: true };
    if (search) {
      const or = [
        { label: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
      // "18" should find the 18% slab, but a text search must not throw on a
      // non-numeric term — only add the numeric clause when one parses.
      const asNumber = Number(search);
      if (Number.isFinite(asNumber)) or.push({ rate: asNumber });
      filter.$or = or;
    }

    const [data, total] = await Promise.all([
      StockGstRateModel.find(filter).sort({ order: 1, rate: 1 }).skip(skip).limit(limit).lean(),
      StockGstRateModel.countDocuments(filter),
    ]);
    return { data, total };
  }

  /**
   * The picker feed — every GST dropdown in the app reads this.
   *
   * Deliberately NOT behind `gst-rates:READ`. That is the Master > GST Rates
   * *management* permission, and a purchaser filling in a quotation line must
   * not be forced to take it (and the nav entry it unlocks) just to choose a
   * slab. Same reasoning as StockBranchService.getScopedActiveBranches, minus
   * the scoping — GST rates have no per-user dimension at all.
   */
  static async getActiveGstRates() {
    return StockGstRateModel.find({ isActive: true })
      .select("rate label description order")
      .sort({ order: 1, rate: 1 })
      .lean();
  }

  /**
   * Write-path guard for any model persisting a gstRate number.
   *
   * Enforced on create/update ONLY. Reads never run through here on purpose:
   * a product saved at 12% must keep opening after the 12% slab is retired,
   * and a historical purchase order must keep rendering. Validating on read
   * would break exactly the records this design exists to protect.
   */
  static async assertRateAllowed(rate, session) {
    if (rate === undefined || rate === null || rate === "") return null;

    const num = normalizeRate(rate);
    const existing = await StockGstRateModel.findOne({ rate: num, isActive: true })
      .lean()
      .session(session ?? null);
    if (!existing) {
      const active = await StockGstRateService.getActiveGstRates();
      throw new Error(
        active.length
          ? `gstRate must be one of the active GST rates: ${active.map((r) => r.label).join(", ")}`
          : "No active GST rates are configured. Add one under Master > GST Rates first."
      );
    }
    return num;
  }

  static async getGstRateById(id) {
    const gstRate = await StockGstRateModel.findOne({ _id: id }).lean();
    if (!gstRate) throw new Error("GST rate not found");
    return gstRate;
  }

  static async updateGstRate(id, body, actor, session) {
    const gstRate = await StockGstRateModel.findOne({ _id: id, isActive: true }).session(session);
    if (!gstRate) throw new Error("GST rate not found");
    const before = gstRate.toObject();

    if (body.rate !== undefined && normalizeRate(body.rate) !== gstRate.rate) {
      await StockGstRateService.assertRateNotDuplicate({
        rate: body.rate,
        session,
        excludeId: gstRate._id,
      });
      gstRate.rate = normalizeRate(body.rate);
      // A blank label tracks the rate; a custom one is left alone.
      if (before.label === `${before.rate}%`) gstRate.label = `${gstRate.rate}%`;
    }

    if (body.label !== undefined) gstRate.label = String(body.label).trim();
    if (body.description !== undefined) gstRate.description = body.description;
    if (body.order !== undefined) gstRate.order = Number(body.order) || 0;

    await gstRate.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: gstRate._id,
      action: "UPDATE",
      actor,
      before,
      after: gstRate.toObject(),
    });

    return gstRate;
  }

  /**
   * Soft delete only — a hard delete is never offered.
   *
   * Retiring a slab must not disturb anything already priced with it. Because
   * those documents hold the number and not a reference, deactivating this row
   * removes it from future pickers and changes no existing total.
   */
  static async softDeleteGstRate(id, actor, session) {
    const gstRate = await StockGstRateModel.findOne({ _id: id, isActive: true }).session(session);
    if (!gstRate) throw new Error("GST rate not found");
    const before = gstRate.toObject();

    gstRate.isActive = false;
    gstRate.deletedAt = new Date();
    gstRate.deletedBy = actorSnapshot(actor);
    await gstRate.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: gstRate._id,
      action: "DELETE",
      actor,
      before,
      after: gstRate.toObject(),
    });

    return gstRate;
  }

  static async restoreGstRate(id, actor, session) {
    const gstRate = await StockGstRateModel.findOne({ _id: id }).session(session);
    if (!gstRate) throw new Error("GST rate not found");
    if (gstRate.isActive) throw new Error("GST rate is already active");
    // Another row may have taken this slab while it was retired.
    await StockGstRateService.assertRateNotDuplicate({
      rate: gstRate.rate,
      session,
      excludeId: gstRate._id,
    });
    const before = gstRate.toObject();

    gstRate.isActive = true;
    gstRate.deletedAt = null;
    gstRate.deletedBy = null;
    await gstRate.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: gstRate._id,
      action: "RESTORE",
      actor,
      before,
      after: gstRate.toObject(),
    });

    return gstRate;
  }
}
