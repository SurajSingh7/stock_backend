import mongoose from "mongoose";
import StockCategoryModel from "../models/stock.category.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import { CATEGORY_TYPES } from "../constants/stock.enums.js";

export default class StockCategoryService {
  // ─── Create ──────────────────────────────────────────────────────────────────

  static async createCategory(body, session) {
    try {
      const { name, type, parentId, sortOrder } = body;

      let path;

      if (!parentId) {
        // Root category — create first to get _id, then update path
        const category = new StockCategoryModel({
          name,
          type,
          parentId: null,
          path: "/placeholder/",
          sortOrder: sortOrder ?? 0,
        });
        await category.save({ session });
        category.path = `/${category._id}/`;
        await category.save({ session });
        return category;
      }

      // With parent
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
        name,
        type,
        parentId,
        path: "/placeholder/",
        sortOrder: sortOrder ?? 0,
      });
      await category.save({ session });
      category.path = `${parent.path}${category._id}/`;
      await category.save({ session });
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

      return roots;
    } catch (error) {
      throw error;
    }
  }

  // ─── Flat list ────────────────────────────────────────────────────────────────

  static async getCategoriesFlat({ skip, limit, search, type, showInactive }) {
    try {
      const filter = showInactive ? {} : { isActive: true };
      if (search) filter.name = { $regex: search, $options: "i" };
      if (type) filter.type = type;

      const [data, total] = await Promise.all([
        StockCategoryModel.find(filter)
          .sort({ sortOrder: 1, name: 1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        StockCategoryModel.countDocuments(filter),
      ]);

      return { data, total };
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

      return { ...category, children };
    } catch (error) {
      throw error;
    }
  }

  // ─── Update (rename only) ─────────────────────────────────────────────────────

  static async updateCategory(id, body, session) {
    try {
      const category = await StockCategoryModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!category) throw new Error("Category not found");

      if (body.type !== undefined) throw new Error("type is immutable");
      category.name = body.name;
      await category.save({ session });
      return category;
    } catch (error) {
      throw error;
    }
  }

  // ─── Move ─────────────────────────────────────────────────────────────────────

  static async moveCategory(id, newParentId, session) {
    try {
      const category = await StockCategoryModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!category) throw new Error("Category not found");

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
        // Prevent moving into own subtree
        if (newParent.path.startsWith(oldPath))
          throw new Error("Cannot move a category into its own descendant");

        newPath = `${newParent.path}${category._id}/`;
        category.parentId = newParentId;
      }

      category.path = newPath;
      await category.save({ session });

      // Update all descendants
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

      return category;
    } catch (error) {
      throw error;
    }
  }

  // ─── Soft delete ──────────────────────────────────────────────────────────────

  static async softDeleteCategory(id, deletedBy, session) {
    try {
      const category = await StockCategoryModel.findOne({
        _id: id,
        isActive: true,
      }).session(session);
      if (!category) throw new Error("Category not found");

      const now = new Date();

      // Soft delete self
      category.isActive = false;
      category.deletedAt = now;
      category.deletedBy = deletedBy ?? null;
      await category.save({ session });

      // Soft delete all descendants
      await StockCategoryModel.updateMany(
        { path: { $regex: `^${category.path}` }, isActive: true },
        { $set: { isActive: false, deletedAt: now, deletedBy: deletedBy ?? null } },
        { session }
      );

      // If LEAF or any descendant LEAFs, soft delete their product definitions
      const leafIds = await StockCategoryModel.find(
        {
          path: { $regex: `^${category.path}` },
          type: CATEGORY_TYPES.LEAF,
        },
        "_id"
      )
        .lean()
        .session(session);

      const leafIdArr = leafIds.map((l) => l._id);
      if (category.type === CATEGORY_TYPES.LEAF) leafIdArr.push(category._id);

      if (leafIdArr.length > 0) {
        await StockProductDefinitionModel.updateMany(
          { categoryId: { $in: leafIdArr }, isActive: true },
          { $set: { isActive: false, deletedAt: now, deletedBy: deletedBy ?? null } },
          { session }
        );
      }

      return category;
    } catch (error) {
      throw error;
    }
  }

  // ─── Restore ──────────────────────────────────────────────────────────────────

  static async restoreCategory(id, session) {
    try {
      const category = await StockCategoryModel.findOne({ _id: id }).session(session);
      if (!category) throw new Error("Category not found");
      if (category.isActive) throw new Error("Category is already active");

      category.isActive = true;
      category.deletedAt = null;
      category.deletedBy = null;
      await category.save({ session });
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
