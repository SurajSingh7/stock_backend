import StockFieldDefinitionModel from "../models/stock.field.definition.model.js";
import { actorSnapshot } from "../models/plugins/actor.stamp.plugin.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import { TRACKING_METHODS_ARRAY } from "../constants/stock.enums.js";

const ENTITY_TYPE = "field-definitions";

export default class StockFieldDefinitionService {
  // ─── Helper: checks code/label uniqueness against BOTH active AND inactive
  // records. If a match exists on an inactive record, the caller is told to
  // restore it instead of creating a duplicate. If a match exists on an
  // active record, a plain "already exists" message is shown.
  static async assertFieldNotDuplicate({ code, label, session, excludeId = null }) {
    const orConditions = [];
    if (code) orConditions.push({ code: code.trim() });
    if (label) orConditions.push({ label: { $regex: `^${label.trim()}$`, $options: "i" } });

    if (orConditions.length === 0) return;

    const filter = { $or: orConditions };
    if (excludeId) filter._id = { $ne: excludeId };

    const existing = await StockFieldDefinitionModel.findOne(filter)
      .lean()
      .session(session ?? null);

    if (existing) {
      if (existing.isActive) {
        throw new Error("This field already exists.");
      }
      throw new Error(
        "This field already exists in inactive records. Please restore the existing field instead of creating duplicate."
      );
    }
  }

  static async createFieldDefinition(body, actor, session) {
    try {
      const {
        code, label, inputType, optionsSource, isRequired, isFilterable, showList, order,
        applicableTrackingMethods,
      } = body;

      // 🔒 Duplicate check — code AND label, across active + inactive records
      await StockFieldDefinitionService.assertFieldNotDuplicate({ code, label, session });

      const field = new StockFieldDefinitionModel({
        code,
        label,
        inputType,
        optionsSource: optionsSource ?? null,
        isRequired: isRequired ?? false,
        isFilterable: isFilterable ?? false,
        showList: showList ?? false,
        order: Number.isFinite(Number(order)) ? Number(order) : 0,
        applicableTrackingMethods:
          Array.isArray(applicableTrackingMethods) && applicableTrackingMethods.length > 0
            ? applicableTrackingMethods
            : TRACKING_METHODS_ARRAY,
      });

      await field.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: field._id, action: "CREATE", actor, before: null, after: field.toObject(),
      });
      return field;
    } catch (error) {
      throw error;
    }
  }

  static async getAllFieldDefinitions({ skip, limit, search, inputType, showInactive }) {
    try {
      const filter = showInactive ? {} : { isActive: true };
      if (search) filter.label = { $regex: search, $options: "i" };
      if (inputType) filter.inputType = inputType;

      const [data, total] = await Promise.all([
        StockFieldDefinitionModel.find(filter)
          .sort({ order: 1, createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        StockFieldDefinitionModel.countDocuments(filter),
      ]);

      return { data, total };
    } catch (error) {
      throw error;
    }
  }

  static async getFieldDefinitionById(id) {
    try {
      const field = await StockFieldDefinitionModel.findOne({
        _id: id,
        isActive: true,
      }).lean();
      if (!field) throw new Error("Field definition not found");
      return field;
    } catch (error) {
      throw error;
    }
  }

  static async updateFieldDefinition(id, body, actor, session) {
    try {
      if (body.code !== undefined) throw new Error("code is immutable and cannot be updated");

      const field = await StockFieldDefinitionModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!field) throw new Error("Field definition not found");
      const before = field.toObject();

      // 🔒 Duplicate check — label only (code is immutable), excluding self
      if (body.label !== undefined && body.label.trim().toLowerCase() !== field.label.trim().toLowerCase()) {
        await StockFieldDefinitionService.assertFieldNotDuplicate({
          label: body.label,
          session,
          excludeId: field._id,
        });
      }

      const allowed = [
        "label", "inputType", "optionsSource", "isRequired", "isFilterable", "showList", "order",
        "applicableTrackingMethods",
      ];
      allowed.forEach((key) => {
        if (body[key] !== undefined) field[key] = body[key];
      });

      await field.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: field._id, action: "UPDATE", actor, before, after: field.toObject(),
      });
      return field;
    } catch (error) {
      throw error;
    }
  }

  static async softDeleteFieldDefinition(id, actor, session) {
    try {
      const field = await StockFieldDefinitionModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!field) throw new Error("Field definition not found");
      const before = field.toObject();

      // 🔒 Block delete if this field is used in any product definition
      const usageCount = await StockProductDefinitionModel.countDocuments({
        "selectedFields.fieldDefId": id,
        isActive: true,
      });
      if (usageCount > 0) {
        throw new Error("This field is already used in products and cannot be deleted.");
      }

      field.isActive = false;
      field.deletedAt = new Date();
      field.deletedBy = actorSnapshot(actor);
      await field.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: field._id, action: "DELETE", actor, before, after: field.toObject(),
      });
      return field;
    } catch (error) {
      throw error;
    }
  }

  static async restoreFieldDefinition(id, actor, session) {
    try {
      const field = await StockFieldDefinitionModel.findOne({ _id: id }).session(session);
      if (!field) throw new Error("Field definition not found");
      if (field.isActive) throw new Error("Field definition is already active");
      const before = field.toObject();

      field.isActive = true;
      field.deletedAt = null;
      field.deletedBy = null;
      await field.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: field._id, action: "RESTORE", actor, before, after: field.toObject(),
      });
      return field;
    } catch (error) {
      throw error;
    }
  }
}