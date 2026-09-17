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
import StockBranchController from "../controllers/stock.branch.controller.js";
import StockGstRateController from "../controllers/stock.gst.rate.controller.js";
import StockInvoiceController from "../controllers/stock.invoice.controller.js";
import { uploadInvoiceFile } from "../helpers/stock.invoice.upload.helper.js";
import StockTransferRequestController from "../controllers/stock.transfer.request.controller.js";
import StockAccessControlController from "../controllers/stock.access.control.controller.js";
import StockAuditLogController from "../controllers/stock.audit.log.controller.js";
import { authenticate, requireAdmin } from "../middlewares/stock.auth.middleware.js";
import { requirePermission } from "../middlewares/stock.permission.middleware.js";

const router = express.Router();

// ─── Auth (diagnostic) ─────────────────────────────────────────────────────────
router.get("/me", authenticate, (req, res) => res.json({ success: true, data: req.user }));

// ─── Access Control ─────────────────────────────────────────────────────────
// Management endpoints (grant/override/scope/delegate) are admin-only.
// /my-permissions is the one exception — any authenticated user reads their
// own effective permissions from here (this is what the frontend's
// usePermissions() hook is meant to call).
router.get("/access-control/modules", authenticate, requireAdmin, StockAccessControlController.getAllModules);
router.get("/access-control/my-permissions", authenticate, StockAccessControlController.getMyPermissions);
router.get("/access-control/effective-permissions", authenticate, requireAdmin, StockAccessControlController.getEffectivePermissions);
router.post("/access-control/role-permissions", authenticate, requireAdmin, StockAccessControlController.setRolePermission);
router.get("/access-control/role-permissions", authenticate, requireAdmin, StockAccessControlController.getRolePermissions);
router.post("/access-control/user-overrides", authenticate, requireAdmin, StockAccessControlController.setUserOverride);
router.get("/access-control/user-overrides", authenticate, requireAdmin, StockAccessControlController.getUserOverrides);
// Data access — all three dimensions in one payload. Omit moduleId for the
// user's global configuration; pass one to override only that module.
router.get("/access-control/data-scopes", authenticate, requireAdmin, StockAccessControlController.getDataScopes);
router.post("/access-control/data-scopes", authenticate, requireAdmin, StockAccessControlController.setDataScope);
router.post("/access-control/data-scopes/clear-module", authenticate, requireAdmin, StockAccessControlController.clearModuleDataScope);

// Department restriction — narrows what a role granted, never widens it.
router.get("/access-control/department-restrictions", authenticate, requireAdmin, StockAccessControlController.getDepartmentRestrictions);
router.post("/access-control/department-restrictions", authenticate, requireAdmin, StockAccessControlController.setDepartmentRestriction);
router.post("/access-control/department-restrictions/clear", authenticate, requireAdmin, StockAccessControlController.clearDepartmentRestriction);
router.post("/access-control/delegate", authenticate, requireAdmin, StockAccessControlController.delegateAccess);

// ─── Audit Log ───────────────────────────────────────────────────────────────
// Admin-only for now — a per-record read (e.g. gated behind that entity's
// own READ permission instead) can be split out later if a non-admin needs
// to see a single record's history from its detail page.
router.get("/audit-log/entity", authenticate, requireAdmin, StockAuditLogController.getEntityHistory);
router.get("/audit-log/activity", authenticate, requireAdmin, StockAuditLogController.getActivityLog);

// ─── Field Definitions ────────────────────────────────────────────────────────
router.post("/field-definitions", authenticate, requirePermission("field-definitions", "CREATE"), StockFieldDefinitionController.createFieldDefinition);
router.get("/field-definitions", authenticate, requirePermission("field-definitions", "READ"), StockFieldDefinitionController.getAllFieldDefinitions);
router.get("/field-definitions/:id", authenticate, requirePermission("field-definitions", "READ"), StockFieldDefinitionController.getFieldDefinitionById);
router.put("/field-definitions/:id", authenticate, requirePermission("field-definitions", "UPDATE"), StockFieldDefinitionController.updateFieldDefinition);
router.delete("/field-definitions/:id", authenticate, requirePermission("field-definitions", "DELETE"), StockFieldDefinitionController.softDeleteFieldDefinition);
router.patch("/field-definitions/:id/restore", authenticate, requirePermission("field-definitions", "RESTORE"), StockFieldDefinitionController.restoreFieldDefinition);

// ─── Categories ───────────────────────────────────────────────────────────────
router.post("/categories", authenticate, requirePermission("categories", "CREATE"), StockCategoryController.createCategory);
router.get("/categories", authenticate, requirePermission("categories", "READ"), StockCategoryController.getCategoryTree);
router.get("/categories/flat", authenticate, requirePermission("categories", "READ"), StockCategoryController.getCategoriesFlat);
router.patch("/categories/reorder", authenticate, requirePermission("categories", "REORDER"), StockCategoryController.reorderCategories);
router.get("/categories/:id", authenticate, requirePermission("categories", "READ"), StockCategoryController.getCategoryById);
router.put("/categories/:id", authenticate, requirePermission("categories", "UPDATE"), StockCategoryController.updateCategory);
router.patch("/categories/:id/toggle-type", authenticate, requirePermission("categories", "TOGGLE_TYPE"), StockCategoryController.toggleCategoryType);
router.patch("/categories/:id/move", authenticate, requirePermission("categories", "MOVE"), StockCategoryController.moveCategory);
router.delete("/categories/:id", authenticate, requirePermission("categories", "DELETE"), StockCategoryController.softDeleteCategory);
router.patch("/categories/:id/restore", authenticate, requirePermission("categories", "RESTORE"), StockCategoryController.restoreCategory);

// ─── Product Definitions ──────────────────────────────────────────────────────
router.post(
  "/product-definitions",
  authenticate,
  requirePermission("product-definitions", "CREATE"),
  uploadProductImage.single("image"),
  StockProductDefinitionController.createProductDefinition
);
router.get("/product-definitions", authenticate, requirePermission("product-definitions", "READ"), StockProductDefinitionController.getAllProductDefinitions);
router.get("/product-definitions/by-category/:catId", authenticate, requirePermission("product-definitions", "READ"), StockProductDefinitionController.getProductDefinitionsByCategory);
router.get("/product-definitions/:id", authenticate, requirePermission("product-definitions", "READ"), StockProductDefinitionController.getProductDefinitionById);
router.put(
  "/product-definitions/:id",
  authenticate,
  requirePermission("product-definitions", "UPDATE"),
  uploadProductImage.single("image"),
  StockProductDefinitionController.updateProductDefinition
);
router.delete("/product-definitions/:id", authenticate, requirePermission("product-definitions", "DELETE"), StockProductDefinitionController.softDeleteProductDefinition);
router.patch("/product-definitions/:id/restore", authenticate, requirePermission("product-definitions", "RESTORE"), StockProductDefinitionController.restoreProductDefinition);

// ─── Vendor ──────────────────────────────────────────────────────────
router.post("/vendors", authenticate, requirePermission("vendors", "CREATE"), StockVendorController.createVendor);
router.get("/vendors", authenticate, requirePermission("vendors", "READ"), StockVendorController.getAllVendors);
router.get("/vendors/:id", authenticate, requirePermission("vendors", "READ"), StockVendorController.getVendorById);
router.put("/vendors/:id", authenticate, requirePermission("vendors", "UPDATE"), StockVendorController.updateVendor);
router.delete("/vendors/:id", authenticate, requirePermission("vendors", "DELETE"), StockVendorController.softDeleteVendor);
router.patch("/vendors/:id/restore", authenticate, requirePermission("vendors", "RESTORE"), StockVendorController.restoreVendor);

// ─── Terms & Conditions ─────────────────────────────────────────────────────
// /resolve/:vendorId BEFORE /:id — same static-before-dynamic rule as
// /categories/flat, /quotations/status-summary, etc.
router.post("/terms-conditions", authenticate, requirePermission("terms-conditions", "CREATE"), StockTermsConditionController.createTermsCondition);
router.get("/terms-conditions", authenticate, requirePermission("terms-conditions", "READ"), StockTermsConditionController.getAllTermsConditions);
router.get("/terms-conditions/resolve/:vendorId", authenticate, requirePermission("terms-conditions", "READ"), StockTermsConditionController.resolveForVendor);
router.get("/terms-conditions/:id", authenticate, requirePermission("terms-conditions", "READ"), StockTermsConditionController.getTermsConditionById);
router.put("/terms-conditions/:id", authenticate, requirePermission("terms-conditions", "UPDATE"), StockTermsConditionController.updateTermsCondition);
router.delete("/terms-conditions/:id", authenticate, requirePermission("terms-conditions", "DELETE"), StockTermsConditionController.softDeleteTermsCondition);
router.patch("/terms-conditions/:id/restore", authenticate, requirePermission("terms-conditions", "RESTORE"), StockTermsConditionController.restoreTermsCondition);

// ─── Inventory Items ──────────────────────────────────────────────────────────
router.post("/inventory-items/bulk", authenticate, requirePermission("inventory-items", "BULK_CREATE"), StockInventoryItemController.bulkCreateInventoryItems);
router.post("/inventory-items", authenticate, requirePermission("inventory-items", "CREATE"), StockInventoryItemController.createInventoryItem);
router.get("/inventory-items", authenticate, requirePermission("inventory-items", "READ"), StockInventoryItemController.getAllInventoryItems);
// Static segments before "/:id" — same rule as everywhere else in this file.
router.get("/inventory-items/cards", authenticate, requirePermission("inventory-items", "READ"), StockInventoryItemController.getInventoryCards);
router.get("/inventory-items/product-summary", authenticate, requirePermission("inventory-items", "READ"), StockInventoryItemController.getProductInventorySummary);
router.get("/inventory-items/history/:defId", authenticate, requirePermission("inventory-items", "READ"), StockInventoryItemController.getReceivingHistory);
router.get("/inventory-items/summary/:defId", authenticate, requirePermission("inventory-items", "READ"), StockInventoryItemController.getStockSummary);
router.get("/inventory-items/:id", authenticate, requirePermission("inventory-items", "READ"), StockInventoryItemController.getInventoryItemById);
router.put("/inventory-items/:id", authenticate, requirePermission("inventory-items", "UPDATE"), StockInventoryItemController.updateInventoryItem);
router.patch("/inventory-items/:id/status", authenticate, requirePermission("inventory-items", "UPDATE_STATUS"), StockInventoryItemController.updateItemStatus);
router.delete("/inventory-items/:id", authenticate, requirePermission("inventory-items", "DELETE"), StockInventoryItemController.softDeleteInventoryItem);
router.patch("/inventory-items/:id/restore", authenticate, requirePermission("inventory-items", "RESTORE"), StockInventoryItemController.restoreInventoryItem);

// ─── Quotations ────────────────────────────────────────────────────────────────
// Specific string paths are declared BEFORE "/:id" so Express doesn't treat them
// as an id (same pattern as /categories/flat).
router.post("/quotations", authenticate, requirePermission("quotations", "CREATE"), StockQuotationController.createQuotation);
router.get("/quotations", authenticate, requirePermission("quotations", "READ"), StockQuotationController.getAllQuotations);
router.get("/quotations/status-summary", authenticate, requirePermission("quotations", "READ"), StockQuotationController.getStatusSummary);
router.get("/quotations/vendors-for-category/:catId", authenticate, requirePermission("quotations", "READ"), StockQuotationController.getVendorsForCategory);
router.get("/quotations/:id", authenticate, requirePermission("quotations", "READ"), StockQuotationController.getQuotationById);
router.patch("/quotations/:id/review", authenticate, requirePermission("quotations", "REVIEW"), StockQuotationController.reviewQuotation);
router.delete("/quotations/:id", authenticate, requirePermission("quotations", "DELETE"), StockQuotationController.softDeleteQuotation);
router.patch("/quotations/:id/restore", authenticate, requirePermission("quotations", "RESTORE"), StockQuotationController.restoreQuotation);

// ─── Purchase Orders ─────────────────────────────────────────────────────────
// Specific paths BEFORE "/:id".
router.get("/purchase-orders/board", authenticate, requirePermission("purchase-orders", "READ"), StockPurchaseOrderController.getBoard);
router.post("/purchase-orders", authenticate, requirePermission("purchase-orders", "CREATE"), StockPurchaseOrderController.createPurchaseOrder);
router.get("/purchase-orders", authenticate, requirePermission("purchase-orders", "READ"), StockPurchaseOrderController.getAllPurchaseOrders);
router.get("/purchase-orders/:id/pdf", authenticate, requirePermission("purchase-orders", "READ"), StockPurchaseOrderController.getPurchaseOrderPdf);
router.get("/purchase-orders/:id", authenticate, requirePermission("purchase-orders", "READ"), StockPurchaseOrderController.getPurchaseOrderById);
router.put("/purchase-orders/:id", authenticate, requirePermission("purchase-orders", "UPDATE"), StockPurchaseOrderController.updatePurchaseOrder);
router.patch("/purchase-orders/:id/approve", authenticate, requirePermission("purchase-orders", "APPROVE"), StockPurchaseOrderController.approvePurchaseOrder);
router.patch("/purchase-orders/:id/reject", authenticate, requirePermission("purchase-orders", "REJECT"), StockPurchaseOrderController.rejectPurchaseOrder);
router.patch("/purchase-orders/:id/send-mail", authenticate, requirePermission("purchase-orders", "SEND_MAIL"), StockPurchaseOrderController.sendMail);
router.delete("/purchase-orders/:id", authenticate, requirePermission("purchase-orders", "DELETE"), StockPurchaseOrderController.softDeletePurchaseOrder);

// ─── Tracking Orders ──────────────────────────────────────────────────────────
// Static path BEFORE dynamic /:id-based ones.
router.get("/tracking-orders/board", authenticate, requirePermission("tracking-orders", "READ"), StockTrackingOrderController.getBoard);
router.patch("/tracking-orders/:id/entity", authenticate, requirePermission("tracking-orders", "ADD_ENTITY"), StockTrackingOrderController.addEntity);
router.patch("/tracking-orders/:id/not-required", authenticate, requirePermission("tracking-orders", "MARK_NOT_REQUIRED"), StockTrackingOrderController.markNotRequired);
// Undo of Not Required, so it carries the same permission.
router.patch("/tracking-orders/:id/required", authenticate, requirePermission("tracking-orders", "MARK_NOT_REQUIRED"), StockTrackingOrderController.markRequired);
// The accounts team's only way to change an order after it leaves Tracking:
// send the whole thing back to the start. Its own permission.
router.patch("/tracking-orders/:id/reset", authenticate, requirePermission("purchase-orders", "RESET_ORDER"), StockTrackingOrderController.resetOrder);
// Read-only register of every dropped line/vendor. Its own module so viewing
// the history is granted apart from the permissions that create the entries.
router.get("/not-required", authenticate, requirePermission("not-required", "READ"), StockTrackingOrderController.getNotRequired);
// Creates an Invoice record (controller lives under Invoices) — gated on the
// invoices module, not tracking-orders, since that's the entity being created.
router.post(
  "/tracking-orders/:id/invoices",
  authenticate,
  requirePermission("invoices", "CREATE"),
  uploadInvoiceFile.single("invoiceFile"),
  StockInvoiceController.createInvoice
);
router.get("/tracking-orders/:id", authenticate, requirePermission("tracking-orders", "READ"), StockTrackingOrderController.getDetail);

// ─── Invoices (goods receiving / Invoice Approval) ───────────────────────────
// /board BEFORE /:id — same static-before-dynamic rule as everywhere else.
router.get("/invoices/board", authenticate, requirePermission("invoices", "READ"), StockInvoiceController.getBoard);
// Branch picker for the goods-receiving form. Deliberately on the invoices
// module rather than /branches/active's `branches:READ` — receiving staff
// need to name their own branch without holding the branch-master permission.
router.get(
  "/invoices/receiving-branches",
  authenticate,
  requirePermission("invoices", "READ"),
  StockInvoiceController.getReceivingBranches
);
router.get("/invoices/:id", authenticate, requirePermission("invoices", "READ"), StockInvoiceController.getInvoiceById);
router.put(
  "/invoices/:id",
  authenticate,
  requirePermission("invoices", "UPDATE"),
  uploadInvoiceFile.single("invoiceFile"),
  StockInvoiceController.updateInvoice
);
router.patch("/invoices/:id/approve", authenticate, requirePermission("invoices", "APPROVE"), StockInvoiceController.approveInvoice);
router.patch("/invoices/:id/reject", authenticate, requirePermission("invoices", "REJECT"), StockInvoiceController.rejectInvoice);

// ─── Branches ───────────────────────────────────────────────────────────────
// /active BEFORE /:id — same static-before-dynamic rule as everywhere else.
router.get("/branches/active", authenticate, requirePermission("branches", "READ"), StockBranchController.getActiveBranches);
router.post("/branches", authenticate, requirePermission("branches", "CREATE"), StockBranchController.createBranch);
router.get("/branches", authenticate, requirePermission("branches", "READ"), StockBranchController.getAllBranches);
router.get("/branches/:id", authenticate, requirePermission("branches", "READ"), StockBranchController.getBranchById);
router.put("/branches/:id", authenticate, requirePermission("branches", "UPDATE"), StockBranchController.updateBranch);
router.delete("/branches/:id", authenticate, requirePermission("branches", "DELETE"), StockBranchController.softDeleteBranch);
router.patch("/branches/:id/restore", authenticate, requirePermission("branches", "RESTORE"), StockBranchController.restoreBranch);

// ─── GST Rates ──────────────────────────────────────────────────────────────
// /active BEFORE /:id — same static-before-dynamic rule as everywhere else.
//
// /active is authenticate-only on purpose: it is the feed behind every GST
// dropdown (product definition, quotation lines, purchase orders), and gating
// it on `gst-rates:READ` would force a purchaser to hold the Master > GST Rates
// management permission — and the nav entry it unlocks — just to pick a slab.
// Same reasoning as /invoices/receiving-branches above. Listed in
// scripts/check-route-permissions.js so the safety net expects it.
router.get("/gst-rates/active", authenticate, StockGstRateController.getActiveGstRates);
router.post("/gst-rates", authenticate, requirePermission("gst-rates", "CREATE"), StockGstRateController.createGstRate);
router.get("/gst-rates", authenticate, requirePermission("gst-rates", "READ"), StockGstRateController.getAllGstRates);
router.get("/gst-rates/:id", authenticate, requirePermission("gst-rates", "READ"), StockGstRateController.getGstRateById);
router.put("/gst-rates/:id", authenticate, requirePermission("gst-rates", "UPDATE"), StockGstRateController.updateGstRate);
router.delete("/gst-rates/:id", authenticate, requirePermission("gst-rates", "DELETE"), StockGstRateController.softDeleteGstRate);
router.patch("/gst-rates/:id/restore", authenticate, requirePermission("gst-rates", "RESTORE"), StockGstRateController.restoreGstRate);

// ─── Inventory Transfer Requests ──────────────────────────────────────────────
// /board BEFORE /:id — same static-before-dynamic rule as everywhere else.
router.post("/transfer-requests", authenticate, requirePermission("transfer-requests", "CREATE"), StockTransferRequestController.createTransferRequest);
router.get("/transfer-requests/board", authenticate, requirePermission("transfer-requests", "READ"), StockTransferRequestController.getBoard);
// Branch pickers for the transfer screens — on this module, not
// /branches/active's `branches:READ`. Static path, so above /:id.
router.get("/transfer-requests/branches", authenticate, requirePermission("transfer-requests", "READ"), StockTransferRequestController.getFormBranches);
router.get("/transfer-requests/:id", authenticate, requirePermission("transfer-requests", "READ"), StockTransferRequestController.getTransferRequestById);
router.patch("/transfer-requests/:id/process", authenticate, requirePermission("transfer-requests", "PROCESS"), StockTransferRequestController.processTransferRequest);
router.patch("/transfer-requests/:id/reject", authenticate, requirePermission("transfer-requests", "REJECT"), StockTransferRequestController.rejectTransferRequest);

// ─── Notification master ─────────────────────────────────────────────────────
// /resolve/:vendorId BEFORE /:id — same static-before-dynamic rule as terms-conditions.
router.post("/notifications", authenticate, requirePermission("notifications", "CREATE"), StockNotificationController.createNotification);
router.get("/notifications", authenticate, requirePermission("notifications", "READ"), StockNotificationController.getAllNotifications);
// Static path, so above /:id. Vendors still selectable for a notification
// on this channel — excludeNotificationId keeps an edit form showing its own.
router.get("/notifications/assignable-vendors", authenticate, requirePermission("notifications", "READ"), StockNotificationController.getAssignableVendors);
router.get("/notifications/resolve/:vendorId", authenticate, requirePermission("notifications", "READ"), StockNotificationController.resolveForVendor);
router.get("/notifications/:id", authenticate, requirePermission("notifications", "READ"), StockNotificationController.getNotificationById);
router.put("/notifications/:id", authenticate, requirePermission("notifications", "UPDATE"), StockNotificationController.updateNotification);
router.delete("/notifications/:id", authenticate, requirePermission("notifications", "DELETE"), StockNotificationController.softDeleteNotification);
router.patch("/notifications/:id/restore", authenticate, requirePermission("notifications", "RESTORE"), StockNotificationController.restoreNotification);

export default router;
