import express from "express";
import StockCategoryController from "../controllers/stock.category.controller.js";
import StockFieldDefinitionController from "../controllers/stock.field.definition.controller.js";
import StockProductDefinitionController from "../controllers/stock.product.definition.controller.js";
import StockInventoryItemController from "../controllers/stock.inventory.item.controller.js";
import { uploadProductImage } from "../helpers/stock.upload.helper.js";
import StockVendorController from "../controllers/stock.vendor.controller.js";
import StockQuotationController from "../controllers/stock.quotation.controller.js";
import StockPurchaseOrderController from "../controllers/stock.purchase.order.controller.js";
import StockTermsConditionController from "../controllers/stock.terms.condition.controller.js";
import StockTrackingOrderController from "../controllers/stock.tracking.order.controller.js";
import StockNotificationController from "../controllers/stock.notification.controller.js";
import StockWarehouseController from "../controllers/stock.warehouse.controller.js";
import StockInvoiceController from "../controllers/stock.invoice.controller.js";
import { uploadInvoiceFile } from "../helpers/stock.invoice.upload.helper.js";
import StockTransferRequestController from "../controllers/stock.transfer.request.controller.js";

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

// ─── Terms & Conditions ─────────────────────────────────────────────────────
// /resolve/:vendorId BEFORE /:id — same static-before-dynamic rule as
// /categories/flat, /quotations/status-summary, etc.
router.post("/terms-conditions", StockTermsConditionController.createTermsCondition);
router.get("/terms-conditions", StockTermsConditionController.getAllTermsConditions);
router.get("/terms-conditions/resolve/:vendorId", StockTermsConditionController.resolveForVendor);
router.get("/terms-conditions/:id", StockTermsConditionController.getTermsConditionById);
router.put("/terms-conditions/:id", StockTermsConditionController.updateTermsCondition);
router.delete("/terms-conditions/:id", StockTermsConditionController.softDeleteTermsCondition);
router.patch("/terms-conditions/:id/restore", StockTermsConditionController.restoreTermsCondition);

// ─── Inventory Items ──────────────────────────────────────────────────────────
router.post("/inventory-items/bulk", StockInventoryItemController.bulkCreateInventoryItems);
router.post("/inventory-items", StockInventoryItemController.createInventoryItem);
router.get("/inventory-items", StockInventoryItemController.getAllInventoryItems);
// Static segments before "/:id" — same rule as everywhere else in this file.
router.get("/inventory-items/product-summary", StockInventoryItemController.getProductInventorySummary);
router.get("/inventory-items/history/:defId", StockInventoryItemController.getReceivingHistory);
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
router.patch("/purchase-orders/:id/send-mail", StockPurchaseOrderController.sendMail);
router.delete("/purchase-orders/:id", StockPurchaseOrderController.softDeletePurchaseOrder);

// ─── Tracking Orders ──────────────────────────────────────────────────────────
// Static path BEFORE dynamic /:id-based ones.
router.get("/tracking-orders/board", StockTrackingOrderController.getBoard);
router.patch("/tracking-orders/:id/entity", StockTrackingOrderController.addEntity);
router.patch("/tracking-orders/:id/not-required", StockTrackingOrderController.markNotRequired);
router.post(
  "/tracking-orders/:id/invoices",
  uploadInvoiceFile.single("invoiceFile"),
  StockInvoiceController.createInvoice
);
router.get("/tracking-orders/:id", StockTrackingOrderController.getDetail);

// ─── Invoices (goods receiving / Invoice Approval) ───────────────────────────
// /board BEFORE /:id — same static-before-dynamic rule as everywhere else.
router.get("/invoices/board", StockInvoiceController.getBoard);
router.get("/invoices/:id", StockInvoiceController.getInvoiceById);
router.put(
  "/invoices/:id",
  uploadInvoiceFile.single("invoiceFile"),
  StockInvoiceController.updateInvoice
);
router.patch("/invoices/:id/approve", StockInvoiceController.approveInvoice);
router.patch("/invoices/:id/reject", StockInvoiceController.rejectInvoice);

// ─── Warehouses ───────────────────────────────────────────────────────────────
// /active BEFORE /:id — same static-before-dynamic rule as everywhere else.
router.get("/warehouses/active", StockWarehouseController.getActiveWarehouses);
router.post("/warehouses", StockWarehouseController.createWarehouse);
router.get("/warehouses", StockWarehouseController.getAllWarehouses);
router.get("/warehouses/:id", StockWarehouseController.getWarehouseById);
router.put("/warehouses/:id", StockWarehouseController.updateWarehouse);
router.delete("/warehouses/:id", StockWarehouseController.softDeleteWarehouse);
router.patch("/warehouses/:id/restore", StockWarehouseController.restoreWarehouse);

// ─── Inventory Transfer Requests ──────────────────────────────────────────────
// /board BEFORE /:id — same static-before-dynamic rule as everywhere else.
router.post("/transfer-requests", StockTransferRequestController.createTransferRequest);
router.get("/transfer-requests/board", StockTransferRequestController.getBoard);
router.get("/transfer-requests/:id", StockTransferRequestController.getTransferRequestById);
router.patch("/transfer-requests/:id/process", StockTransferRequestController.processTransferRequest);
router.patch("/transfer-requests/:id/reject", StockTransferRequestController.rejectTransferRequest);

// ─── Notification master ─────────────────────────────────────────────────────
// /resolve/:vendorId BEFORE /:id — same static-before-dynamic rule as terms-conditions.
router.post("/notifications", StockNotificationController.createNotification);
router.get("/notifications", StockNotificationController.getAllNotifications);
router.get("/notifications/resolve/:vendorId", StockNotificationController.resolveForVendor);
router.get("/notifications/:id", StockNotificationController.getNotificationById);
router.put("/notifications/:id", StockNotificationController.updateNotification);
router.delete("/notifications/:id", StockNotificationController.softDeleteNotification);
router.patch("/notifications/:id/restore", StockNotificationController.restoreNotification);

export default router;



