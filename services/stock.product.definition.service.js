import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockCategoryModel from "../models/stock.category.model.js";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import { CATEGORY_TYPES } from "../constants/stock.enums.js";

export default class StockProductDefinitionService {
  static async createProductDefinition(body, session) {
    try {
      const { categoryId, name, trackingMethod, selectedFields, status } = body;

      const category = await StockCategoryModel.findOne({
        _id: categoryId,
        isActive: true,
      })
        .lean()
        .session(session);
      if (!category) throw new Error("Category not found");
      if (category.type !== CATEGORY_TYPES.LEAF)
        throw new Error("productDefinitions can only be linked to LEAF categories");

      const def = new StockProductDefinitionModel({
        categoryId,
        name,
        trackingMethod,
        selectedFields,
        status: status ?? "ACTIVE",
      });

      await def.save({ session });
      return def;
    } catch (error) {
      throw error;
    }
  }

  static async getAllProductDefinitions({ skip, limit, search, categoryId, showInactive }) {
    try {
      const filter = showInactive ? {} : { isActive: true };
      if (search) filter.name = { $regex: search, $options: "i" };
      if (categoryId) filter.categoryId = categoryId;

      const [data, total] = await Promise.all([
        StockProductDefinitionModel.find(filter)
          .populate("selectedFields.fieldDefId", "code label inputType optionsSource isRequired")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        StockProductDefinitionModel.countDocuments(filter),
      ]);

      return { data, total };
    } catch (error) {
      throw error;
    }
  }

  static async getProductDefinitionById(id) {
    try {
      const def = await StockProductDefinitionModel.findOne({
        _id: id,
        isActive: true,
      })
        .populate("selectedFields.fieldDefId", "code label inputType optionsSource isRequired")
        .lean();
      if (!def) throw new Error("Product definition not found");
      return def;
    } catch (error) {
      throw error;
    }
  }

  static async getProductDefinitionsByCategory(catId) {
    try {
      const category = await StockCategoryModel.findOne({
        _id: catId,
        isActive: true,
      }).lean();
      if (!category) throw new Error("Category not found");
      if (category.type !== CATEGORY_TYPES.LEAF)
        throw new Error("Only LEAF categories can have product definitions");

      const defs = await StockProductDefinitionModel.find({
        categoryId: catId,
        isActive: true,
      })
        .populate("selectedFields.fieldDefId", "code label inputType optionsSource isRequired")
        .sort({ name: 1 })
        .lean();

      return defs;
    } catch (error) {
      throw error;
    }
  }

  static async updateProductDefinition(id, body, session) {
    try {
      if (body.categoryId !== undefined)
        throw new Error("categoryId cannot be changed after creation");

      const def = await StockProductDefinitionModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!def) throw new Error("Product definition not found");

      const allowed = ["name", "trackingMethod", "selectedFields", "status"];
      allowed.forEach((key) => {
        if (body[key] !== undefined) def[key] = body[key];
      });

      await def.save({ session });
      return def;
    } catch (error) {
      throw error;
    }
  }

  static async softDeleteProductDefinition(id, deletedBy, session) {
    try {
      const def = await StockProductDefinitionModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!def) throw new Error("Product definition not found");

      const activeItems = await StockInventoryItemModel.countDocuments({
        productDefinitionId: id,
        isActive: true,
      });
      if (activeItems > 0)
        throw new Error(
          "Cannot delete — active inventory items exist for this definition"
        );

      def.isActive = false;
      def.deletedAt = new Date();
      def.deletedBy = deletedBy ?? null;
      await def.save({ session });
      return def;
    } catch (error) {
      throw error;
    }
  }

  static async restoreProductDefinition(id, session) {
    try {
      const def = await StockProductDefinitionModel.findOne({ _id: id }).session(session);
      if (!def) throw new Error("Product definition not found");
      if (def.isActive) throw new Error("Product definition is already active");

      def.isActive = true;
      def.deletedAt = null;
      def.deletedBy = null;
      await def.save({ session });
      return def;
    } catch (error) {
      throw error;
    }
  }
}
