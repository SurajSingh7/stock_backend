import StockFieldDefinitionModel from "../models/stock.field.definition.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";

export default class StockFieldDefinitionService {
  static async createFieldDefinition(body, session) {
    try {
      const { code, label, inputType, optionsSource, isRequired, isFilterable } = body;

      const existing = await StockFieldDefinitionModel.findOne({ code }).lean();
      if (existing) throw new Error(`Field with code "${code}" already exists`);

      const field = new StockFieldDefinitionModel({
        code,
        label,
        inputType,
        optionsSource: optionsSource ?? null,
        isRequired: isRequired ?? false,
        isFilterable: isFilterable ?? false,
      });

      await field.save({ session });
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
          .sort({ createdAt: -1 })
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

  static async updateFieldDefinition(id, body, session) {
    try {
      if (body.code !== undefined) throw new Error("code is immutable and cannot be updated");

      const field = await StockFieldDefinitionModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!field) throw new Error("Field definition not found");

      const allowed = ["label", "inputType", "optionsSource", "isRequired", "isFilterable"];
      allowed.forEach((key) => {
        if (body[key] !== undefined) field[key] = body[key];
      });

      await field.save({ session });
      return field;
    } catch (error) {
      throw error;
    }
  }

  static async softDeleteFieldDefinition(id, deletedBy, session) {
    try {
      const field = await StockFieldDefinitionModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!field) throw new Error("Field definition not found");

      // Block if used in any product definition
      const usageCount = await StockProductDefinitionModel.countDocuments({
        "selectedFields.fieldDefId": id,
        isActive: true,
      });
      if (usageCount > 0)
        throw new Error(
          `Cannot delete — field is used in ${usageCount} product definition(s)`
        );

      field.isActive = false;
      field.deletedAt = new Date();
      field.deletedBy = deletedBy ?? null;
      await field.save({ session });
      return field;
    } catch (error) {
      throw error;
    }
  }

  static async restoreFieldDefinition(id, session) {
    try {
      const field = await StockFieldDefinitionModel.findOne({ _id: id }).session(session);
      if (!field) throw new Error("Field definition not found");
      if (field.isActive) throw new Error("Field definition is already active");

      field.isActive = true;
      field.deletedAt = null;
      field.deletedBy = null;
      await field.save({ session });
      return field;
    } catch (error) {
      throw error;
    }
  }
}
