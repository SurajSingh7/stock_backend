import mongoose from "mongoose";
import StockCategoryModel from "../models/stock.category.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import { CATEGORY_TYPES } from "../constants/stock.enums.js";

const ENTITY_TYPE = "categories";

export default class StockCategoryService {
  // ─── Helper: escape user input before using in a $regex query ─────────────────
  static escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ─── Helper: builds "wireless / microtick" style name-path from the raw ObjectId path ----------
  static async buildDisplayPath(idPath, session) {
    const ids = idPath.split("/").filter(Boolean);
    if (ids.length === 0) return "";
    const docs = await StockCategoryModel.find(
      { _id: { $in: ids.map((i) => new mongoose.Types.ObjectId(i)) } },
      "name"
    )
      .session(session ?? null)
      .lean();
    const nameMap = {};
    docs.forEach((d) => (nameMap[d._id.toString()] = d.name));
    return ids.map((id) => nameMap[id] ?? "?").join(" / ");
  }

  // ─── Helper: checks name uniqueness against ACTIVE categories only ────────────
  // Inactive (soft-deleted) categories are intentionally excluded — they'll be
  // purged automatically down the line (retention window TBD), so a stale
  // inactive name should never block creating a fresh active category.
  static async assertNameNotDuplicate(name, session, excludeId = null) {
    if (!name || !name.trim()) {
      throw new Error("Category name is required");
    }

    const filter = {
      isActive: true,
      name: { $regex: `^${StockCategoryService.escapeRegex(name.trim())}$`, $options: "i" },
    };
    if (excludeId) filter._id = { $ne: excludeId };

    const existing = await StockCategoryModel.findOne(filter)
      .lean()
      .session(session ?? null);

    if (existing) {
      throw new Error(`Category "${name}" already exists. Duplicate category cannot be created.`);
    }
  }

  // ─── Create ──────────────────────────────────────────────────────────────────

  static async createCategory(body, actor, session) {
    try {
      const { name, description, type, parentId, sortOrder } = body;

      // 🔒 Duplicate check — active categories only
      await StockCategoryService.assertNameNotDuplicate(name, session);

      if (!parentId) {
        const category = new StockCategoryModel({
          name: name.trim(),
          description: description ?? "",
          type,
          parentId: null,
          path: "/placeholder/",
          sortOrder: sortOrder ?? 0,
        });
        await category.save({ session });
        category.path = `/${category._id}/`;
        await category.save({ session });
        await StockAuditLogService.recordAudit({
          entityType: ENTITY_TYPE, entityId: category._id, action: "CREATE", actor, before: null, after: category.toObject(),
        });
        return category;
      }

      const parent = await StockCategoryModel.findOne({
        _id: parentId,
        isActive: true,
      })
        .lean()
        .session(session);

      if (!parent) throw new Error("Parent category not found");
      if (parent.type === CATEGORY_TYPES.LEAF)
        throw new Error("Cannot add children to a LEAF category");

      const category = new StockCategoryModel({
        name: name.trim(),
        description: description ?? "",
        type,
        parentId,
        path: "/placeholder/",
        sortOrder: sortOrder ?? 0,
      });

      await category.save({ session });
      category.path = `${parent.path}${category._id}/`;
      await category.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: category._id, action: "CREATE", actor, before: null, after: category.toObject(),
      });
      return category;
    } catch (error) {
      throw error;
    }
  }

  // ─── Get full nested tree ─────────────────────────────────────────────────────

  static async getCategoryTree(showInactive = false) {
    try {
      const filter = showInactive ? {} : { isActive: true };
      const all = await StockCategoryModel.find(filter)
        .sort({ sortOrder: 1, name: 1 })
        .lean();

      const map = {};
      all.forEach((c) => {
        map[c._id.toString()] = { ...c, children: [] };
      });

      const roots = [];
      all.forEach((c) => {
        if (!c.parentId) {
          roots.push(map[c._id.toString()]);
        } else {
          const parent = map[c.parentId.toString()];
          if (parent) parent.children.push(map[c._id.toString()]);
        }
      });

      // childCount lets the UI decide, for every node in the tree (not just
      // roots), whether a GROUP is "empty" and therefore eligible for delete —
      // a GROUP can only be deleted when it has zero children.
      Object.values(map).forEach((node) => {
        node.childCount = node.children.length;
      });

      return roots;
    } catch (error) {
      throw error;
    }
  }

  // ─── Flat list ────────────────────────────────────────────────────────────────

  static async getCategoriesFlat({ skip, limit, search, type, showInactive, hasProducts }) {
    try {
      const filter = showInactive ? {} : { isActive: true };
      if (search) filter.name = { $regex: search, $options: "i" };
      if (type) filter.type = type;

      if (String(hasProducts) === "true") {
        // leaf categories that currently have at least one ACTIVE product
        const catIds = await StockProductDefinitionModel.distinct("categoryId", { isActive: true });
        filter._id = { $in: catIds };
      }

      const [data, total] = await Promise.all([
        StockCategoryModel.find(filter)
          .sort({ sortOrder: 1, name: 1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        StockCategoryModel.countDocuments(filter),
      ]);

      // Attach human-readable displayPath and childCount (the latter drives
      // whether the Delete action is available for a GROUP row in the UI).
      const dataWithPath = await Promise.all(
        data.map(async (c) => {
          const [displayPath, childCount] = await Promise.all([
            StockCategoryService.buildDisplayPath(c.path),
            StockCategoryModel.countDocuments({ parentId: c._id, isActive: true }),
          ]);
          return { ...c, displayPath, childCount };
        })
      );

      return { data: dataWithPath, total };
    } catch (error) {
      throw error;
    }
  }

  // ─── Get single with children ─────────────────────────────────────────────────

  static async getCategoryById(id) {
    try {
      const category = await StockCategoryModel.findOne({
        _id: id,
        isActive: true,
      }).lean();
      if (!category) throw new Error("Category not found");

      const children = await StockCategoryModel.find({
        parentId: id,
        isActive: true,
      })
        .sort({ sortOrder: 1 })
        .lean();

      // Each child row needs displayPath (for the "Full Path" column) and
      // childCount (so the UI only shows Delete on empty GROUP rows).
      const childrenWithPath = await Promise.all(
        children.map(async (c) => {
          const [displayPath, childCount] = await Promise.all([
            StockCategoryService.buildDisplayPath(c.path),
            StockCategoryModel.countDocuments({ parentId: c._id, isActive: true }),
          ]);
          return { ...c, displayPath, childCount };
        })
      );

      let productCount = 0;
      if (category.type === CATEGORY_TYPES.LEAF) {
        productCount = await StockProductDefinitionModel.countDocuments({
          categoryId: id,
          isActive: true,
        });
      }

      const displayPath = await StockCategoryService.buildDisplayPath(category.path);

      return { ...category, displayPath, children: childrenWithPath, productCount };
    } catch (error) {
      throw error;
    }
  }

  // ─── Update (rename / description only — type is immutable here) ─────────────

  static async updateCategory(id, body, actor, session) {
    try {
      const category = await StockCategoryModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!category) throw new Error("Category not found");
      const before = category.toObject();

      if (body.type !== undefined) throw new Error("type is immutable");

      if (body.name !== undefined && body.name.trim() !== category.name) {
        // 🔒 Same active-only duplicate check applies on rename
        await StockCategoryService.assertNameNotDuplicate(body.name, session, category._id);
        category.name = body.name.trim();
      }

      if (body.description !== undefined) category.description = body.description;
      await category.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: category._id, action: "UPDATE", actor, before, after: category.toObject(),
      });
      return category;
    } catch (error) {
      throw error;
    }
  }

  // ─── Toggle type (GROUP <-> LEAF) ──────────────────────────────────────────────

  static async toggleCategoryType(id, nextType, actor, session) {
    try {
      if (![CATEGORY_TYPES.GROUP, CATEGORY_TYPES.LEAF].includes(nextType)) {
        throw new Error("Invalid category type");
      }

      const category = await StockCategoryModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!category) throw new Error("Category not found");
      const before = category.toObject();

      if (category.type === nextType) {
        throw new Error(`Category is already ${nextType}`);
      }

      if (nextType === CATEGORY_TYPES.LEAF) {
        const childCount = await StockCategoryModel.countDocuments({
          parentId: category._id,
          isActive: true,
        }).session(session);
        if (childCount > 0) {
          throw new Error("Cannot convert to LEAF: this category has subcategories.");
        }
      } else {
        const productCount = await StockProductDefinitionModel.countDocuments({
          categoryId: category._id,
          isActive: true,
        }).session(session);
        if (productCount > 0) {
          throw new Error("Cannot convert to GROUP because this category contains products.");
        }
      }

      category.type = nextType;
      await category.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: category._id, action: "TOGGLE_TYPE", actor, before, after: category.toObject(),
      });
      return category;
    } catch (error) {
      throw error;
    }
  }

  // ─── Move ─────────────────────────────────────────────────────────────────────

  static async moveCategory(id, newParentId, actor, session) {
    try {
      const category = await StockCategoryModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!category) throw new Error("Category not found");
      const before = category.toObject();

      const oldPath = category.path;
      let newPath;

      if (!newParentId) {
        newPath = `/${category._id}/`;
        category.parentId = null;
      } else {
        const newParent = await StockCategoryModel.findOne({
          _id: newParentId,
          isActive: true,
        })
          .lean()
          .session(session);
        if (!newParent) throw new Error("New parent category not found");
        if (newParent.type === CATEGORY_TYPES.LEAF)
          throw new Error("Cannot move under a LEAF category");
        if (newParent.path.startsWith(oldPath))
          throw new Error("Cannot move a category into its own descendant");

        newPath = `${newParent.path}${category._id}/`;
        category.parentId = newParentId;
      }

      category.path = newPath;
      await category.save({ session });

      const descendants = await StockCategoryModel.find({
        path: { $regex: `^${oldPath}` },
        _id: { $ne: category._id },
      })
        .lean()
        .session(session);

      for (const desc of descendants) {
        const updatedPath = desc.path.replace(oldPath, newPath);
        await StockCategoryModel.updateOne(
          { _id: desc._id },
          { $set: { path: updatedPath } },
          { session }
        );
      }

      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: category._id, action: "MOVE", actor, before, after: category.toObject(),
      });
      return category;
    } catch (error) {
      throw error;
    }
  }

  // ─── Soft delete ──────────────────────────────────────────────────────────────
  // Deletion rules (both enforced here as a backend safety net, independent of
  // whatever the UI shows/hides):
  //   1. A LEAF category can NEVER be deleted — only moved elsewhere.
  //   2. A GROUP category can only be deleted while it is completely EMPTY
  //      (zero active children, of either type). This guarantees delete never
  //      cascades, which in turn guarantees a LEAF can never be removed
  //      indirectly by deleting one of its ancestor GROUPs.
  //   To delete a>b>c>d>e (e = LEAF): move e out first, then delete d, then
  //   c, then b, then a — bottom-up, one empty GROUP at a time.

  static async softDeleteCategory(id, actor, session) {
    try {
      const category = await StockCategoryModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!category) throw new Error("Category not found");
      const before = category.toObject();

      if (category.type === CATEGORY_TYPES.LEAF) {
        throw new Error(
          "LEAF categories cannot be deleted. Please move it under a different GROUP category instead."
        );
      }

      const childCount = await StockCategoryModel.countDocuments({
        parentId: category._id,
        isActive: true,
      }).session(session);

      if (childCount > 0) {
        throw new Error(
          "Cannot delete this category because it still has subcategories. Please delete or move its subcategories first."
        );
      }

      const now = new Date();
      category.isActive = false;
      category.deletedAt = now;
      category.deletedBy = actor?._id ?? null;
      await category.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: category._id, action: "DELETE", actor, before, after: category.toObject(),
      });

      return category;
    } catch (error) {
      throw error;
    }
  }

  // ─── Restore ──────────────────────────────────────────────────────────────────

  static async restoreCategory(id, actor, session) {
    try {
      const category = await StockCategoryModel.findOne({ _id: id }).session(session);
      if (!category) throw new Error("Category not found");
      if (category.isActive) throw new Error("Category is already active");
      const before = category.toObject();

      category.isActive = true;
      category.deletedAt = null;
      category.deletedBy = null;
      await category.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: category._id, action: "RESTORE", actor, before, after: category.toObject(),
      });
      return category;
    } catch (error) {
      throw error;
    }
  }

  // ─── Reorder siblings ─────────────────────────────────────────────────────────

  static async reorderCategories(siblings, session) {
    try {
      for (const s of siblings) {
        await StockCategoryModel.updateOne(
          { _id: s._id },
          { $set: { sortOrder: s.sortOrder } },
          { session }
        );
      }
      return true;
    } catch (error) {
      throw error;
    }
  }
}