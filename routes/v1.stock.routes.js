import express from "express";
import StockCategoryController from "../controllers/stock.category.controller.js";
import StockFieldDefinitionController from "../controllers/stock.field.definition.controller.js";
import StockProductDefinitionController from "../controllers/stock.product.definition.controller.js";
import StockInventoryItemController from "../controllers/stock.inventory.item.controller.js";

const router = express.Router();

// ─── Field Definitions ────────────────────────────────────────────────────────
router.post("/field-definitions", StockFieldDefinitionController.createFieldDefinition);
router.get("/field-definitions", StockFieldDefinitionController.getAllFieldDefinitions);
router.get("/field-definitions/:id", StockFieldDefinitionController.getFieldDefinitionById);
router.put("/field-definitions/:id", StockFieldDefinitionController.updateFieldDefinition);
router.delete("/field-definitions/:id", StockFieldDefinitionController.softDeleteFieldDefinition);
router.patch("/field-definitions/:id/restore", StockFieldDefinitionController.restoreFieldDefinition);

// ─── Categories ───────────────────────────────────────────────────────────────
router.post("/categories", StockCategoryController.createCategory);
router.get("/categories", StockCategoryController.getCategoryTree);
router.get("/categories/flat", StockCategoryController.getCategoriesFlat);
router.patch("/categories/reorder", StockCategoryController.reorderCategories);
router.get("/categories/:id", StockCategoryController.getCategoryById);
router.put("/categories/:id", StockCategoryController.updateCategory);
router.patch("/categories/:id/move", StockCategoryController.moveCategory);
router.delete("/categories/:id", StockCategoryController.softDeleteCategory);
router.patch("/categories/:id/restore", StockCategoryController.restoreCategory);

// ─── Product Definitions ──────────────────────────────────────────────────────
router.post("/product-definitions", StockProductDefinitionController.createProductDefinition);
router.get("/product-definitions", StockProductDefinitionController.getAllProductDefinitions);
router.get("/product-definitions/by-category/:catId", StockProductDefinitionController.getProductDefinitionsByCategory);
router.get("/product-definitions/:id", StockProductDefinitionController.getProductDefinitionById);
router.put("/product-definitions/:id", StockProductDefinitionController.updateProductDefinition);
router.delete("/product-definitions/:id", StockProductDefinitionController.softDeleteProductDefinition);
router.patch("/product-definitions/:id/restore", StockProductDefinitionController.restoreProductDefinition);

// ─── Inventory Items ──────────────────────────────────────────────────────────
router.post("/inventory-items/bulk", StockInventoryItemController.bulkCreateInventoryItems);
router.post("/inventory-items", StockInventoryItemController.createInventoryItem);
router.get("/inventory-items", StockInventoryItemController.getAllInventoryItems);
router.get("/inventory-items/summary/:defId", StockInventoryItemController.getStockSummary);
router.get("/inventory-items/:id", StockInventoryItemController.getInventoryItemById);
router.put("/inventory-items/:id", StockInventoryItemController.updateInventoryItem);
router.patch("/inventory-items/:id/status", StockInventoryItemController.updateItemStatus);
router.delete("/inventory-items/:id", StockInventoryItemController.softDeleteInventoryItem);
router.patch("/inventory-items/:id/restore", StockInventoryItemController.restoreInventoryItem);

export default router;
