import { actorSnapshot } from "../models/plugins/actor.stamp.plugin.js";
import StockTdsRateModel from "../models/stock.tds.rate.model.js";
import StockAuditLogService from "./stock.audit.log.service.js";

const ENTITY_TYPE = "tds-rates";

// One row per buyer company, the same for every user — nothing to scope on,
// so no applyDataScope here. Registered as `{}` in config/data.scope.registry.js.

const normalizeAlias = (value) => String(value || "").trim().toUpperCase();

export default class StockTdsRateService {
  static async assertNotDuplicate({ entityAlias, session, excludeId = null }) {
    const filter = { entityAlias: normalizeAlias(entityAlias) };
    if (excludeId) filter._id = { $ne: excludeId };

    const existing = await StockTdsRateModel.findOne(filter).lean().session(session ?? null);
    if (!existing) return;
    if (existing.isActive) throw new Error(`A TDS rate for ${filter.entityAlias} already exists.`);
    throw new Error(
      `A TDS rate for ${filter.entityAlias} exists in inactive records. Please restore it instead of creating a duplicate.`
    );
  }

  static async createTdsRate(body, actor, session) {
    const { entityAlias, rate, note } = body;
    await StockTdsRateService.assertNotDuplicate({ entityAlias, session });

    const tdsRate = new StockTdsRateModel({
      entityAlias: normalizeAlias(entityAlias),
      rate: Number(rate),
      note: note || "",
    });
    await tdsRate.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: tdsRate._id,
      action: "CREATE",
      actor,
      before: null,
      after: tdsRate.toObject(),
    });

    return tdsRate;
  }

  static async getAllTdsRates({ skip, limit, search, showInactive }) {
    const filter = showInactive ? {} : { isActive: true };
    if (search) {
      const or = [
        { entityAlias: { $regex: search, $options: "i" } },
        { note: { $regex: search, $options: "i" } },
      ];
      const asNumber = Number(search);
      if (Number.isFinite(asNumber)) or.push({ rate: asNumber });
      filter.$or = or;
    }

    const [data, total] = await Promise.all([
      StockTdsRateModel.find(filter).sort({ entityAlias: 1 }).skip(skip).limit(limit).lean(),
      StockTdsRateModel.countDocuments(filter),
    ]);
    return { data, total };
  }

  /**
   * The live rate for a buyer entity, or null when none is set (TDS 0).
   * Read once, when an invoice first enters the ledger — see
   * StockInvoiceService._applyTds.
   */
  static async getActiveRateFor(entityAlias, session) {
    const alias = normalizeAlias(entityAlias);
    if (!alias) return null;
    return StockTdsRateModel.findOne({ entityAlias: alias, isActive: true })
      .session(session ?? null)
      .lean();
  }

  static async getTdsRateById(id) {
    const tdsRate = await StockTdsRateModel.findOne({ _id: id }).lean();
    if (!tdsRate) throw new Error("TDS rate not found");
    return tdsRate;
  }

  static async updateTdsRate(id, body, actor, session) {
    const tdsRate = await StockTdsRateModel.findOne({ _id: id, isActive: true }).session(session);
    if (!tdsRate) throw new Error("TDS rate not found");
    const before = tdsRate.toObject();

    if (body.entityAlias !== undefined && normalizeAlias(body.entityAlias) !== tdsRate.entityAlias) {
      await StockTdsRateService.assertNotDuplicate({
        entityAlias: body.entityAlias,
        session,
        excludeId: tdsRate._id,
      });
      tdsRate.entityAlias = normalizeAlias(body.entityAlias);
    }
    if (body.rate !== undefined) tdsRate.rate = Number(body.rate);
    if (body.note !== undefined) tdsRate.note = body.note;

    await tdsRate.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: tdsRate._id,
      action: "UPDATE",
      actor,
      before,
      after: tdsRate.toObject(),
    });

    return tdsRate;
  }

  // Soft delete only. Invoices already approved keep their snapshotted rate.
  static async softDeleteTdsRate(id, actor, session) {
    const tdsRate = await StockTdsRateModel.findOne({ _id: id, isActive: true }).session(session);
    if (!tdsRate) throw new Error("TDS rate not found");
    const before = tdsRate.toObject();

    tdsRate.isActive = false;
    tdsRate.deletedAt = new Date();
    tdsRate.deletedBy = actorSnapshot(actor);
    await tdsRate.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: tdsRate._id,
      action: "DELETE",
      actor,
      before,
      after: tdsRate.toObject(),
    });

    return tdsRate;
  }

  static async restoreTdsRate(id, actor, session) {
    const tdsRate = await StockTdsRateModel.findOne({ _id: id }).session(session);
    if (!tdsRate) throw new Error("TDS rate not found");
    if (tdsRate.isActive) throw new Error("TDS rate is already active");
    await StockTdsRateService.assertNotDuplicate({
      entityAlias: tdsRate.entityAlias,
      session,
      excludeId: tdsRate._id,
    });
    const before = tdsRate.toObject();

    tdsRate.isActive = true;
    tdsRate.deletedAt = null;
    tdsRate.deletedBy = null;
    await tdsRate.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: tdsRate._id,
      action: "RESTORE",
      actor,
      before,
      after: tdsRate.toObject(),
    });

    return tdsRate;
  }
}
