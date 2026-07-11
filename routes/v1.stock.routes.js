import express from "express";
import StockCategoryController from "../controllers/stock.category.controller.js";
import StockFieldDefinitionController from "../controllers/stock.field.definition.controller.js";
import StockProductDefinitionController from "../controllers/stock.product.definition.controller.js";
import StockInventoryItemController from "../controllers/stock.inventory.item.controller.js";
import { uploadProductImage } from "../helpers/stock.upload.helper.js";
import StockVendorController from "../controllers/stock.vendor.controller.js";
import StockQuotationController from "../controllers/stock.quotation.controller.js";
import StockPurchaseOrderController from "../controllers/stock.purchase.order.controller.js";

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
router.patch("/categories/:id/toggle-type", StockCategoryController.toggleCategoryType);
router.patch("/categories/:id/move", StockCategoryController.moveCategory);
router.delete("/categories/:id", StockCategoryController.softDeleteCategory);
router.patch("/categories/:id/restore", StockCategoryController.restoreCategory);

// ─── Product Definitions ──────────────────────────────────────────────────────
router.post(
  "/product-definitions",
  uploadProductImage.single("image"),
  StockProductDefinitionController.createProductDefinition
);
router.get("/product-definitions", StockProductDefinitionController.getAllProductDefinitions);
router.get("/product-definitions/gst-rates", StockProductDefinitionController.getGstRates);
router.get("/product-definitions/by-category/:catId", StockProductDefinitionController.getProductDefinitionsByCategory);
router.get("/product-definitions/:id", StockProductDefinitionController.getProductDefinitionById);
router.put(
  "/product-definitions/:id",
  uploadProductImage.single("image"),
  StockProductDefinitionController.updateProductDefinition
);
router.delete("/product-definitions/:id", StockProductDefinitionController.softDeleteProductDefinition);
router.patch("/product-definitions/:id/restore", StockProductDefinitionController.restoreProductDefinition);

// ─── Vendor ──────────────────────────────────────────────────────────
router.post("/vendors", StockVendorController.createVendor);
router.get("/vendors", StockVendorController.getAllVendors);
router.get("/vendors/:id", StockVendorController.getVendorById);
router.put("/vendors/:id", StockVendorController.updateVendor);
router.delete("/vendors/:id", StockVendorController.softDeleteVendor);
router.patch("/vendors/:id/restore", StockVendorController.restoreVendor);

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

// ─── Quotations ────────────────────────────────────────────────────────────────
// Specific string paths are declared BEFORE "/:id" so Express doesn't treat them
// as an id (same pattern as /categories/flat).
router.post("/quotations", StockQuotationController.createQuotation);
router.get("/quotations", StockQuotationController.getAllQuotations);
router.get("/quotations/status-summary", StockQuotationController.getStatusSummary);
router.get("/quotations/vendors-for-category/:catId", StockQuotationController.getVendorsForCategory);
router.get("/quotations/:id", StockQuotationController.getQuotationById);
router.put("/quotations/:id", StockQuotationController.updateQuotation);
// Approver submits one decision per category, all at once.
router.patch("/quotations/:id/review", StockQuotationController.reviewQuotation);
router.patch("/quotations/:quotationId/disable-vendor", StockPurchaseOrderController.disableVendor);
router.patch("/quotations/:quotationId/enable-vendor", StockPurchaseOrderController.enableVendor);
router.delete("/quotations/:id", StockQuotationController.softDeleteQuotation);
router.patch("/quotations/:id/restore", StockQuotationController.restoreQuotation);

// ─── Purchase Orders ─────────────────────────────────────────────────────────
// Specific paths BEFORE "/:id".
router.get("/purchase-orders/board", StockPurchaseOrderController.getBoard);
router.get("/purchase-orders/candidates", StockPurchaseOrderController.getCandidates);
router.post("/purchase-orders", StockPurchaseOrderController.createPurchaseOrder);
router.get("/purchase-orders", StockPurchaseOrderController.getAllPurchaseOrders);
router.get("/purchase-orders/:id/pdf", StockPurchaseOrderController.getPurchaseOrderPdf);
router.get("/purchase-orders/:id", StockPurchaseOrderController.getPurchaseOrderById);
router.put("/purchase-orders/:id", StockPurchaseOrderController.updatePurchaseOrder);
router.patch("/purchase-orders/:id/approve", StockPurchaseOrderController.approvePurchaseOrder);
router.patch("/purchase-orders/:id/reject", StockPurchaseOrderController.rejectPurchaseOrder);
router.delete("/purchase-orders/:id", StockPurchaseOrderController.softDeletePurchaseOrder);
 

export default router;



