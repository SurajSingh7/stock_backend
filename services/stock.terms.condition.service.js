import StockTermsConditionModel from "../models/stock.terms.condition.model.js";
import { actorSnapshot } from "../models/plugins/actor.stamp.plugin.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import mongoose from "mongoose";
import { TERMS_SOURCE } from "../constants/stock.enums.js";

const ENTITY_TYPE = "terms-conditions";

const escapeRegex = (str = "") => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Strip <script>/<style> blocks, inline event handlers, and javascript: URLs
// out of the rich-text HTML before it's ever persisted — this content gets
// rendered back with dangerouslySetInnerHTML (master preview + PO terms
// snapshot), so it's sanitized at the write boundary rather than trusted.
const sanitizeRichText = (html) =>
  String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");

export default class StockTermsConditionService {
  // ─── Create ──────────────────────────────────────────────────────────────

  static async createTermsCondition(body, actor, session) {
    try {
      const { termName, isDefault, applicableVendors, termsContent } = body;
      const wantsDefault = !!isDefault;

      // Only one ACTIVE default term at a time — demote whatever currently
      // holds it rather than making the admin do it as a separate step.
      if (wantsDefault) {
        await StockTermsConditionModel.updateMany(
          { isActive: true, isDefault: true },
          { $set: { isDefault: false } },
          { session }
        );
      }

      const [term] = await StockTermsConditionModel.create(
        [
          {
            termName: termName.trim(),
            isDefault: wantsDefault,
            applicableVendors: wantsDefault ? [] : applicableVendors || [],
            termsContent: sanitizeRichText(termsContent),
          },
        ],
        { session }
      );
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: term._id, action: "CREATE", actor, before: null, after: term.toObject(),
      });
      return term;
    } catch (error) {
      throw error;
    }
  }

  // ─── List ────────────────────────────────────────────────────────────────

  // status=ACTIVE|INACTIVE filters on isActive (paging stays right for either
  // tab); vendorId = the terms that apply to that vendor — its own, and the default.
  static async getAllTermsConditions({ skip, limit, search, status, showInactive, vendorId }) {
    try {
      const filter = showInactive ? {} : { isActive: true };
      if (status === "INACTIVE") filter.isActive = false;
      else if (status === "ACTIVE") filter.isActive = true;
      if (search) filter.termName = { $regex: escapeRegex(search.trim()), $options: "i" };
      if (vendorId) {
        if (!mongoose.Types.ObjectId.isValid(vendorId)) return { data: [], total: 0 };
        filter.$or = [{ applicableVendors: new mongoose.Types.ObjectId(vendorId) }, { isDefault: true }];
      }

      const [data, total] = await Promise.all([
        StockTermsConditionModel.find(filter)
          .populate("applicableVendors", "name")
          .sort({ isDefault: -1, createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        StockTermsConditionModel.countDocuments(filter),
      ]);

      return { data, total };
    } catch (error) {
      throw error;
    }
  }

  // ─── Get one ─────────────────────────────────────────────────────────────

  static async getTermsConditionById(id) {
    try {
      const term = await StockTermsConditionModel.findOne({ _id: id, isActive: true })
        .populate("applicableVendors", "name")
        .lean();
      if (!term) throw new Error("Terms & Conditions not found");
      return term;
    } catch (error) {
      throw error;
    }
  }

  // ─── Update ──────────────────────────────────────────────────────────────

  static async updateTermsCondition(id, body, actor, session) {
    try {
      const term = await StockTermsConditionModel.findOne({ _id: id, isActive: true }).session(session);
      if (!term) throw new Error("Terms & Conditions not found");
      const before = term.toObject();

      const { termName, isDefault, applicableVendors, termsContent } = body;
      const nextIsDefault = isDefault !== undefined ? !!isDefault : term.isDefault;

      if (nextIsDefault && !term.isDefault) {
        await StockTermsConditionModel.updateMany(
          { isActive: true, isDefault: true, _id: { $ne: term._id } },
          { $set: { isDefault: false } },
          { session }
        );
      }

      if (termName !== undefined) term.termName = termName.trim();
      term.isDefault = nextIsDefault;
      term.applicableVendors = nextIsDefault ? [] : applicableVendors || [];
      if (termsContent !== undefined) term.termsContent = sanitizeRichText(termsContent);

      await term.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: term._id, action: "UPDATE", actor, before, after: term.toObject(),
      });
      return term;
    } catch (error) {
      throw error;
    }
  }

  // ─── Soft delete ─────────────────────────────────────────────────────────
  // No special guard against deleting the current default — PO creation
  // falls back gracefully to TERMS_SOURCE.NONE (empty terms) when neither a
  // vendor-specific nor a default term is configured; see resolveForVendor.

  static async softDeleteTermsCondition(id, actor, session) {
    try {
      const term = await StockTermsConditionModel.findOne({ _id: id, isActive: true }).session(session);
      if (!term) throw new Error("Terms & Conditions not found");
      const before = term.toObject();

      term.isActive = false;
      term.deletedAt = new Date();
      term.deletedBy = actorSnapshot(actor);
      await term.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: term._id, action: "DELETE", actor, before, after: term.toObject(),
      });
      return term;
    } catch (error) {
      throw error;
    }
  }

  // ─── Restore ─────────────────────────────────────────────────────────────

  static async restoreTermsCondition(id, actor, session) {
    try {
      const term = await StockTermsConditionModel.findOne({ _id: id }).session(session);
      if (!term) throw new Error("Terms & Conditions not found");
      if (term.isActive) throw new Error("Terms & Conditions is already active");
      const before = term.toObject();

      // Restoring a former default must not collide with whatever is the
      // current default — demote it first, same rule as create/update.
      if (term.isDefault) {
        await StockTermsConditionModel.updateMany(
          { isActive: true, isDefault: true, _id: { $ne: term._id } },
          { $set: { isDefault: false } },
          { session }
        );
      }

      term.isActive = true;
      term.deletedAt = null;
      term.deletedBy = null;
      await term.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: term._id, action: "RESTORE", actor, before, after: term.toObject(),
      });
      return term;
    } catch (error) {
      throw error;
    }
  }

  // ─── Resolve — used by PO creation (Section: auto-pick terms) ────────────
  // Vendor-specific ACTIVE term (isDefault: false, applicableVendors
  // includes vendorId) wins; otherwise fall back to the single ACTIVE
  // default term; otherwise NONE (caller stores empty terms, non-fatal).

  static async resolveForVendor(vendorId, session) {
    try {
      if (vendorId) {
        const vendorTerm = await StockTermsConditionModel.findOne({
          isActive: true,
          isDefault: false,
          applicableVendors: vendorId,
        })
          .sort({ updatedAt: -1 })
          .session(session ?? null)
          .lean();

        if (vendorTerm) return { term: vendorTerm, source: TERMS_SOURCE.VENDOR };
      }

      const defaultTerm = await StockTermsConditionModel.findOne({
        isActive: true,
        isDefault: true,
      })
        .session(session ?? null)
        .lean();

      if (defaultTerm) return { term: defaultTerm, source: TERMS_SOURCE.DEFAULT };

      return { term: null, source: TERMS_SOURCE.NONE };
    } catch (error) {
      throw error;
    }
  }

  // ─── Get one ACTIVE term by id — used by PO creation's manual-select      ─
  // fallback when resolveForVendor finds nothing. Non-fatal on any error
  // (bad id, etc.) — caller treats a null return the same as "not found".

  static async getActiveById(id, session) {
    if (!id) return null;
    try {
      return await StockTermsConditionModel.findOne({
        _id: id,
        isActive: true,
      })
        .session(session ?? null)
        .lean();
    } catch {
      return null;
    }
  }
}
