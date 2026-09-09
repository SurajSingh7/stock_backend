import mongoose from "mongoose";
import { actorSnapshot } from "../models/plugins/actor.stamp.plugin.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockCategoryModel from "../models/stock.category.model.js";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import StockFieldDefinitionModel from "../models/stock.field.definition.model.js";
import StockBranchModel from "../models/stock.branch.model.js";
import StockGstRateService from "./stock.gst.rate.service.js";
import { CATEGORY_TYPES } from "../constants/stock.enums.js";
import { deleteProductImageFile } from "../helpers/stock.upload.helper.js";
import StockAuditLogService from "./stock.audit.log.service.js";

const ENTITY_TYPE = "product-definitions";

export default class StockProductDefinitionService {
  // 🔒 A field definition can be restricted to Individual-only or
  // Group-only tracking (see stock.field.definition.model.js
  // `applicableTrackingMethods`). Reject any selection that isn't offered
  // for the product's tracking method, mirroring what the picker UI already
  // filters out client-side.
  static async assertSelectedFieldsApplicable(trackingMethod, selectedFields, session) {
    if (!trackingMethod || !Array.isArray(selectedFields) || selectedFields.length === 0) return;

    const fieldDefIds = selectedFields.map((f) => f.fieldDefId);
    const fieldDefs = await StockFieldDefinitionModel.find({ _id: { $in: fieldDefIds } })
      .select("label applicableTrackingMethods")
      .lean()
      .session(session ?? null);

    const byId = new Map(fieldDefs.map((f) => [String(f._id), f]));
    const invalid = fieldDefIds
      .map((id) => byId.get(String(id)))
      // Legacy field-definition docs saved before applicableTrackingMethods
      // existed have no value stored (lean() won't backfill the schema
      // default) — treat "not set" the same as "applies to both".
      .filter((f) => f && f.applicableTrackingMethods?.length && !f.applicableTrackingMethods.includes(trackingMethod));

    if (invalid.length > 0) {
      throw new Error(
        `These fields are not applicable to the selected tracking method: ${invalid.map((f) => f.label).join(", ")}`
      );
    }
  }

  // 🔔 Stock alerts are raised PER BRANCH, so every active branch must
  // carry an explicit threshold on the product — an un-covered branch would
  // silently never alert. The array's *shape* is checked in the validator; this
  // is the half of the rule that needs the branch collection.
  static async assertBranchThresholdsComplete(branchThresholds, session) {
    const activeBranches = await StockBranchModel.find({ isActive: true })
      .select("name code")
      .lean()
      .session(session ?? null);

    if (activeBranches.length === 0)
      throw new Error("At least one active branch is required before a product can be defined");

    const activeById = new Map(activeBranches.map((w) => [String(w._id), w]));
    const provided = new Set((branchThresholds || []).map((r) => String(r.branchId)));

    const missing = activeBranches.filter((w) => !provided.has(String(w._id)));
    if (missing.length > 0)
      throw new Error(
        `A stock alert threshold is required for every branch. Missing: ${missing
          .map((w) => `${w.name} (${w.code})`)
          .join(", ")}`
      );

    // Guards a stale form posting a branch that was deleted meanwhile.
    const unknown = [...provided].filter((id) => !activeById.has(id));
    if (unknown.length > 0)
      throw new Error(`Invalid branch in stock alert thresholds: ${unknown.join(", ")}`);
  }

  static async createProductDefinition(body, actor, session) {
    try {
      const {
        categoryId,
        name,
        trackingMethod,
        selectedFields,
        status,
        gstRate,
        unit,
        defaultStockAlertThreshold,
        branchThresholds,
        warrantyYears,
        image, // NEW — public path set by controller from req.file, or null
      } = body;

      const category = await StockCategoryModel.findOne({
        _id: categoryId,
        isActive: true,
      })
        .lean()
        .session(session);
      if (!category) throw new Error("Category not found");
      if (category.type !== CATEGORY_TYPES.LEAF)
        throw new Error("productDefinitions can only be linked to LEAF categories");

      // Pre-check for a case-insensitive duplicate so the user gets a clean
      // error instead of a raw E11000 bubbling up from the unique index.
      const exists = await StockProductDefinitionModel.findOne({ categoryId, name, isActive: true })
        .collation({ locale: "en", strength: 2 })
        .session(session);
      if (exists) throw new Error("A product with this name already exists in this category");

      await StockProductDefinitionService.assertSelectedFieldsApplicable(trackingMethod, selectedFields, session);
      await StockProductDefinitionService.assertBranchThresholdsComplete(branchThresholds, session);
      // Returns the rate as a Number (or null) — the same normalisation the
      // priced-line models already apply, done once here.
      const normalizedGstRate = await StockGstRateService.assertRateAllowed(gstRate, session);

      const def = new StockProductDefinitionModel({
        categoryId,
        name,
        trackingMethod,
        selectedFields,
        status: status ?? "ACTIVE",
        gstRate: normalizedGstRate,
        // Independent of trackingMethod — validated (required, pieces/meter)
        // in validateCreateProductDefinition.
        unit,
        defaultStockAlertThreshold,
        branchThresholds,
        warrantyYears,
        image: image ?? null,
      });

      await def.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: def._id, action: "CREATE", actor, before: null, after: def.toObject(),
      });
      return def;
    } catch (error) {
      throw error;
    }
  }

  static async getAllProductDefinitions({
    skip,
    limit,
    search,
    categoryId,
    showInactive,
    trackingMethod,
    productId,
  }) {
    try {
      const filter = showInactive ? {} : { isActive: true };
      if (search) filter.name = { $regex: search, $options: "i" };
      if (categoryId) filter.categoryId = categoryId;
      if (trackingMethod) filter.trackingMethod = trackingMethod;
      if (productId) filter._id = new mongoose.Types.ObjectId(productId);

      const [data, total] = await Promise.all([
        StockProductDefinitionModel.find(filter)
          .populate("selectedFields.fieldDefId", "code label inputType optionsSource isRequired")
          .populate("branchThresholds.branchId", "name code")
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
        .populate("branchThresholds.branchId", "name code")
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
        .populate("branchThresholds.branchId", "name code")
        .sort({ name: 1 })
        .lean();

      return defs;
    } catch (error) {
      throw error;
    }
  }

  static async updateProductDefinition(id, body, actor, session) {
    try {
      if (body.categoryId !== undefined)
        throw new Error("categoryId cannot be changed after creation");

      const def = await StockProductDefinitionModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!def) throw new Error("Product definition not found");
      const before = def.toObject();

      // Track the previous image so it can be cleaned up from disk AFTER the
      // save succeeds — never delete the old file before the new document is
      // safely persisted, or a failed save would leave the product with no image.
      const previousImage = def.image;
      const replacingImage = body.image !== undefined && body.image !== previousImage;

      const effectiveTrackingMethod = body.trackingMethod !== undefined ? body.trackingMethod : def.trackingMethod;
      const effectiveSelectedFields = body.selectedFields !== undefined ? body.selectedFields : def.selectedFields;
      await StockProductDefinitionService.assertSelectedFieldsApplicable(
        effectiveTrackingMethod,
        effectiveSelectedFields,
        session
      );

      if (body.branchThresholds !== undefined) {
        await StockProductDefinitionService.assertBranchThresholdsComplete(body.branchThresholds, session);
      }

      // Only when the edit actually touches it — an update that leaves gstRate
      // alone must keep working after the product's slab has been retired.
      if (body.gstRate !== undefined) {
        body.gstRate = await StockGstRateService.assertRateAllowed(body.gstRate, session);
      }

      const allowed = [
        "name",
        "trackingMethod",
        "selectedFields",
        "status",
        "gstRate",
        "unit",
        "defaultStockAlertThreshold",
        "branchThresholds",
        "warrantyYears",
        "image", // NEW
      ];
      allowed.forEach((key) => {
        if (body[key] !== undefined) def[key] = body[key];
      });

      await def.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: def._id, action: "UPDATE", actor, before, after: def.toObject(),
      });

      if (replacingImage && previousImage) {
        deleteProductImageFile(previousImage);
      }

      return def;
    } catch (error) {
      throw error;
    }
  }

  static async softDeleteProductDefinition(id, actor, session) {
    try {
      const def = await StockProductDefinitionModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!def) throw new Error("Product definition not found");
      const before = def.toObject();

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
      def.deletedBy = actorSnapshot(actor);
      await def.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: def._id, action: "DELETE", actor, before, after: def.toObject(),
      });
      // NOTE: the image file is intentionally NOT deleted on soft delete —
      // soft delete is reversible (restore), so the image must survive it.
      // Only a real replace (updateProductDefinition) or a future hard-delete
      // path should ever call deleteProductImageFile().
      return def;
    } catch (error) {
      throw error;
    }
  }

  static async restoreProductDefinition(id, actor, session) {
    try {
      const def = await StockProductDefinitionModel.findOne({ _id: id }).session(session);
      if (!def) throw new Error("Product definition not found");
      if (def.isActive) throw new Error("Product definition is already active");
      const before = def.toObject();

      def.isActive = true;
      def.deletedAt = null;
      def.deletedBy = null;
      await def.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: def._id, action: "RESTORE", actor, before, after: def.toObject(),
      });
      return def;
    } catch (error) {
      throw error;
    }
  }

}