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
import StockBranchController from "../controllers/stock.branch.controller.js";
import StockGstRateController from "../controllers/stock.gst.rate.controller.js";
import StockFaultyItemController from "../controllers/stock.faulty.item.controller.js";
import StockLowStockController from "../controllers/stock.low.stock.controller.js";
import StockAiSettingsController from "../controllers/stock.ai.settings.controller.js";
import StockInvoiceController from "../controllers/stock.invoice.controller.js";
import { uploadInvoiceFile, uploadInvoiceForReading } from "../helpers/stock.invoice.upload.helper.js";
import StockTransferRequestController from "../controllers/stock.transfer.request.controller.js";
import StockOpeningStockController, { StockOpeningIssuedStockController } from "../controllers/stock.opening.stock.controller.js";
import StockPeopleDirectoryController from "../controllers/stock.people.directory.controller.js";
import StockItemRequestController from "../controllers/stock.item.request.controller.js";
import StockRepairController from "../controllers/stock.repair.controller.js";
import StockEmployeeItemController from "../controllers/stock.employee.item.controller.js";
import StockInventoryReportController from "../controllers/stock.inventory.report.controller.js";
import StockTestSimulatorController from "../controllers/stock.test.simulator.controller.js";
import { uploadOpeningStockSheet } from "../helpers/stock.opening.stock.excel.helper.js";
import StockAccessControlController from "../controllers/stock.access.control.controller.js";
import StockAuditLogController from "../controllers/stock.audit.log.controller.js";
import { authenticate, requireAdmin } from "../middlewares/stock.auth.middleware.js";
import StockInvoicePaymentController from "../controllers/stock.invoice.payment.controller.js";
import StockVendorLedgerController from "../controllers/stock.vendor.ledger.controller.js";
import StockReportController from "../controllers/stock.report.controller.js";
import { uploadPaymentProofs } from "../helpers/stock.payment.upload.helper.js";
import { requirePermission, requirePermissionForQueryModule } from "../middlewares/stock.permission.middleware.js";
import alertRoutes from "./v1.alert.routes.js";

const router = express.Router();

// ─── Alerts & Escalations (own router) ─────────────────────────────────────
router.use("/alerts", alertRoutes);

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
router.get("/vendors/:id/group", authenticate, requirePermission("vendors", "READ"), StockVendorController.getVendorGroup);
router.get("/vendors/:id", authenticate, requirePermission("vendors", "READ"), StockVendorController.getVendorById);
router.put("/vendors/:id", authenticate, requirePermission("vendors", "UPDATE"), StockVendorController.updateVendor);
router.delete("/vendors/:id", authenticate, requirePermission("vendors", "DELETE"), StockVendorController.softDeleteVendor);
router.patch("/vendors/:id/restore", authenticate, requirePermission("vendors", "RESTORE"), StockVendorController.restoreVendor);

// ─── Terms & Conditions ─────────────────────────────────────────────────────
router.post("/terms-conditions", authenticate, requirePermission("terms-conditions", "CREATE"), StockTermsConditionController.createTermsCondition);
router.get("/terms-conditions", authenticate, requirePermission("terms-conditions", "READ"), StockTermsConditionController.getAllTermsConditions);
router.get("/terms-conditions/resolve/:vendorId", authenticate, requirePermission("terms-conditions", "READ"), StockTermsConditionController.resolveForVendor);
router.get("/terms-conditions/:id", authenticate, requirePermission("terms-conditions", "READ"), StockTermsConditionController.getTermsConditionById);
router.put("/terms-conditions/:id", authenticate, requirePermission("terms-conditions", "UPDATE"), StockTermsConditionController.updateTermsCondition);
router.delete("/terms-conditions/:id", authenticate, requirePermission("terms-conditions", "DELETE"), StockTermsConditionController.softDeleteTermsCondition);
router.patch("/terms-conditions/:id/restore", authenticate, requirePermission("terms-conditions", "RESTORE"), StockTermsConditionController.restoreTermsCondition);

// ─── Inventory Items ──────────────────────────────────────────────────────────
// No POST: stock enters only through an invoice or an Opening Stock Entry, each
// of which stamps where the unit came from (see /opening-stock below).
router.get("/inventory-items", authenticate, requirePermission("inventory-items", "READ"), StockInventoryItemController.getAllInventoryItems);
router.get("/inventory-items/cards", authenticate, requirePermission("inventory-items", "READ"), StockInventoryItemController.getInventoryCards);
router.get("/inventory-items/product-summary", authenticate, requirePermission("inventory-items", "READ"), StockInventoryItemController.getProductInventorySummary);
router.get("/inventory-items/history/:defId", authenticate, requirePermission("inventory-items", "READ"), StockInventoryItemController.getReceivingHistory);
router.get("/inventory-items/summary/:defId", authenticate, requirePermission("inventory-items", "READ"), StockInventoryItemController.getStockSummary);
// Low Stock — same READ and branch scope as the inventory screens, so whoever
// sees a branch's stock sees (and is alerted about) what is low in it.
router.get("/low-stock", authenticate, requirePermission("inventory-items", "READ"), StockLowStockController.getList);
router.get("/inventory-items/:id/timeline", authenticate, requirePermission("inventory-items", "READ"), StockInventoryItemController.getItemTimeline);
router.get("/inventory-items/:id", authenticate, requirePermission("inventory-items", "READ"), StockInventoryItemController.getInventoryItemById);
router.put("/inventory-items/:id", authenticate, requirePermission("inventory-items", "UPDATE"), StockInventoryItemController.updateInventoryItem);
router.patch("/inventory-items/:id/status", authenticate, requirePermission("inventory-items", "UPDATE_STATUS"), StockInventoryItemController.updateItemStatus);
router.delete("/inventory-items/:id", authenticate, requirePermission("inventory-items", "DELETE"), StockInventoryItemController.softDeleteInventoryItem);
router.patch("/inventory-items/:id/restore", authenticate, requirePermission("inventory-items", "RESTORE"), StockInventoryItemController.restoreInventoryItem);

// ─── Quotations ────────────────────────────────────────────────────────────────
router.post("/quotations", authenticate, requirePermission("quotations", "CREATE"), StockQuotationController.createQuotation);
router.get("/quotations", authenticate, requirePermission("quotations", "READ"), StockQuotationController.getAllQuotations);
router.get("/quotations/status-summary", authenticate, requirePermission("quotations", "READ"), StockQuotationController.getStatusSummary);
// Warning on make/approve: this category already has orders still to arrive.
router.get("/quotations/pending-orders", authenticate, requirePermission("quotations", "READ"), StockQuotationController.getPendingOrders);
router.get("/quotations/vendors-for-category/:catId", authenticate, requirePermission("quotations", "READ"), StockQuotationController.getVendorsForCategory);
router.get("/quotations/:id", authenticate, requirePermission("quotations", "READ"), StockQuotationController.getQuotationById);
router.patch("/quotations/:id/review", authenticate, requirePermission("quotations", "REVIEW"), StockQuotationController.reviewQuotation);
router.delete("/quotations/:id", authenticate, requirePermission("quotations", "DELETE"), StockQuotationController.softDeleteQuotation);
router.patch("/quotations/:id/restore", authenticate, requirePermission("quotations", "RESTORE"), StockQuotationController.restoreQuotation);

// ─── Purchase Orders ─────────────────────────────────────────────────────────
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
router.get("/tracking-orders/board", authenticate, requirePermission("tracking-orders", "READ"), StockTrackingOrderController.getBoard);
router.patch("/tracking-orders/:id/entity", authenticate, requirePermission("tracking-orders", "ADD_ENTITY"), StockTrackingOrderController.addEntity);
router.patch("/tracking-orders/:id/not-required", authenticate, requirePermission("tracking-orders", "MARK_NOT_REQUIRED"), StockTrackingOrderController.markNotRequired);
router.patch("/tracking-orders/:id/required", authenticate, requirePermission("tracking-orders", "MARK_NOT_REQUIRED"), StockTrackingOrderController.markRequired);
// Closing early and undoing it carry SEPARATE permissions, unlike
// MARK_NOT_REQUIRED which covers both of its directions. Reopening reverses a
// decision someone already signed their name to, so it can be held by a
// different person.
router.patch("/tracking-orders/:id/short-close", authenticate, requirePermission("tracking-orders", "SHORT_CLOSE"), StockTrackingOrderController.shortCloseOrder);
router.patch("/tracking-orders/:id/reopen", authenticate, requirePermission("tracking-orders", "REOPEN"), StockTrackingOrderController.reopenOrder);
router.patch("/tracking-orders/:id/reset", authenticate, requirePermission("purchase-orders", "RESET_ORDER"), StockTrackingOrderController.resetOrder);
router.get("/not-required", authenticate, requirePermission("not-required", "READ"), StockTrackingOrderController.getNotRequired);
router.get("/tracking-orders/:id", authenticate, requirePermission("tracking-orders", "READ"), StockTrackingOrderController.getDetail);
// Add Invoice → upload: Claude reads the details off the file (model from AI Settings).
router.post(
  "/tracking-orders/:id/invoices/read",
  authenticate,
  requirePermission("invoices", "CREATE"),
  uploadInvoiceForReading.single("invoiceFile"),
  StockInvoiceController.readInvoiceFile
);
router.post(
  "/tracking-orders/:id/invoices",
  authenticate,
  requirePermission("invoices", "CREATE"),
  uploadInvoiceFile.single("invoiceFile"),
  StockInvoiceController.createInvoice
);


// ─── Invoices (goods receiving / Invoice Approval) ───────────────────────────
router.get("/invoices/board", authenticate, requirePermission("invoices", "READ"), StockInvoiceController.getBoard);

router.get("/invoices/:id", authenticate, requirePermission("invoices", "READ"), StockInvoiceController.getInvoiceById);
// Add Items — entered by whoever receives: Save as Draft / Submit.
router.put("/invoices/:id/items", authenticate, requirePermission("invoices", "CREATE"), StockInvoiceController.saveItems);
// ⋮ → Edit invoice / Delete: details as written on the vendor's invoice.
// Their own action so it can be granted to a few people only.
router.put(
  "/invoices/:id",
  authenticate,
  requirePermission("invoices", "EDIT_INVOICE"),
  uploadInvoiceFile.single("invoiceFile"),
  StockInvoiceController.updateInvoice
);
router.delete("/invoices/:id", authenticate, requirePermission("invoices", "EDIT_INVOICE"), StockInvoiceController.deleteInvoice);
// ⋮ → Partial submit ON/OFF, and the per-entry decisions it brings.
router.patch("/invoices/:id/partial", authenticate, requirePermission("invoices", "PARTIAL_SUBMIT"), StockInvoiceController.setPartialSubmit);
router.patch("/invoices/:id/entries/:entryId/approve", authenticate, requirePermission("invoices", "APPROVE"), StockInvoiceController.approveEntry);
router.patch("/invoices/:id/entries/:entryId/reject", authenticate, requirePermission("invoices", "REJECT"), StockInvoiceController.rejectEntry);
router.patch("/invoices/:id/approve", authenticate, requirePermission("invoices", "APPROVE"), StockInvoiceController.approveInvoice);
router.patch("/invoices/:id/reject", authenticate, requirePermission("invoices", "REJECT"), StockInvoiceController.rejectInvoice);

// ─── Invoice List · stock team (payment side) ────────────────────────────────
// A different module from "invoices" on purpose: this is the stock team's view
// of what is owed and when, and they hold no invoice-approval permissions. The
// nav entry for it (layouts/navbar/NavCategories.js, moduleKey "invoice-list")
// existed long before the module did, which is why it was invisible to
// everyone. Each write carries its own action because each is a different
// decision: moving a due date is not the same as claiming money back.
router.get("/invoice-list", authenticate, requirePermission("invoice-list", "READ"), StockInvoicePaymentController.getList);

// ─── Faulty Items · every unit a debit note claimed (read-only) ──────────────
router.get("/faulty-items", authenticate, requirePermission("faulty-items", "READ"), StockFaultyItemController.getList);
router.get("/faulty-items/by-vendor", authenticate, requirePermission("faulty-items", "READ"), StockFaultyItemController.getVendorSummary);
router.get("/faulty-items/:debitNoteId/lines/:lineIndex/units", authenticate, requirePermission("faulty-items", "READ"), StockFaultyItemController.getUnits);
// Read-only on misc charges (accounts' own). Debit notes are raised HERE and
// then reviewed on Payments and decided on Payment Approval.
router.get("/invoice-list/:id/adjustments", authenticate, requirePermission("invoice-list", "READ"), StockInvoicePaymentController.getAdjustments);
router.get("/invoice-list/:id/debit-notes", authenticate, requirePermission("invoice-list", "READ"), StockInvoicePaymentController.getDebitNotes);
router.get("/invoice-list/:id/debit-note-items", authenticate, requirePermission("invoice-list", "RAISE_DEBIT_NOTE"), StockInvoicePaymentController.getDebitNoteItemsForRaise);
router.post("/invoice-list/:id/debit-notes", authenticate, requirePermission("invoice-list", "RAISE_DEBIT_NOTE"), StockInvoicePaymentController.raiseDebitNote);
// :id below is the DEBIT NOTE.
router.patch("/invoice-list/debit-notes/:id/resubmit", authenticate, requirePermission("invoice-list", "RAISE_DEBIT_NOTE"), StockInvoicePaymentController.resubmitDebitNote);
router.patch("/invoice-list/debit-notes/:id/withdraw", authenticate, requirePermission("invoice-list", "RAISE_DEBIT_NOTE"), StockInvoicePaymentController.withdrawDebitNote);
router.patch("/invoice-list/:id/schedule", authenticate, requirePermission("invoice-list", "SCHEDULE_PAYMENT"), StockInvoicePaymentController.schedulePayment);

// ─── Payments · account team ─────────────────────────────────────────────────
// Same documents, different module: an admin can give accounts every branch
// here while the stock team stays on its own. MANAGE_ADJUSTMENT and
// ENTER_PAYMENT are separate from REQUEST_PAYMENT_APPROVAL so the person who
// raises a debit note need not be the one who releases the money.
router.get("/payments", authenticate, requirePermission("payments", "READ"), StockInvoicePaymentController.getPaymentsList);
router.get("/payments/:id/adjustments", authenticate, requirePermission("payments", "READ"), StockInvoicePaymentController.getAdjustmentsForAccounts);
router.get("/payments/:id/debit-note-items", authenticate, requirePermission("payments", "READ"), StockInvoicePaymentController.getDebitNoteItems);
router.get("/payments/:id/debit-notes", authenticate, requirePermission("payments", "READ"), StockInvoicePaymentController.getDebitNotesForAccounts);
router.get("/payments-debit-notes", authenticate, requirePermission("payments", "READ"), StockInvoicePaymentController.getReviewQueue);
router.patch("/payments/debit-notes/:id/review", authenticate, requirePermission("payments", "REVIEW_DEBIT_NOTE"), StockInvoicePaymentController.reviewDebitNote);
// TDS is accounts' alone; same weight as a misc charge, same action.
router.patch("/payments/:id/tds", authenticate, requirePermission("payments", "MANAGE_ADJUSTMENT"), StockInvoicePaymentController.updateTds);
// Misc = the invoice's extra charges, edited in place by accounts.
router.patch("/payments/:id/misc", authenticate, requirePermission("payments", "MANAGE_ADJUSTMENT"), StockInvoicePaymentController.updateMisc);
// Raised by accounts and in force at once — there is nobody left to ask.
router.post("/payments/:id/adjustments", authenticate, requirePermission("payments", "MANAGE_ADJUSTMENT"), StockInvoicePaymentController.createAdjustment);
// :id below is the ADJUSTMENT, not the invoice. Editing reverses the old one
// and applies the new one in a single transaction, stock included, so it is a
// write of the same weight as creating — same permission.
router.patch("/payments/adjustments/:id", authenticate, requirePermission("payments", "MANAGE_ADJUSTMENT"), StockInvoicePaymentController.updateAdjustment);
router.delete("/payments/adjustments/:id", authenticate, requirePermission("payments", "MANAGE_ADJUSTMENT"), StockInvoicePaymentController.deleteAdjustment);
router.patch("/payments/:id/send-for-approval", authenticate, requirePermission("payments", "REQUEST_PAYMENT_APPROVAL"), StockInvoicePaymentController.sendForApproval);
// Multipart: proof files ride along with the amount, so multer runs before the
// handler and the handler deletes what it wrote if the transaction aborts.
// Multipart: the JSON travels in `data`, and each split's proof files arrive as
// split_<index>_proofs so every bank leg keeps its own receipt.
router.post(
  "/payments/:id/record",
  authenticate,
  requirePermission("payments", "ENTER_PAYMENT"),
  uploadPaymentProofs,
  StockInvoicePaymentController.recordPayment
);

// ─── Payment Approval · approval team ────────────────────────────────────────
// Read-and-decide only. This team never touches adjustments or amounts — they
// approve a payable somebody else computed, which is why they get no action
// that can change one.
router.get("/payment-approval", authenticate, requirePermission("payment-approval", "READ"), StockInvoicePaymentController.getApprovalList);
// Read-only view of the adjustments behind a payable. No write counterpart:
// this team agrees to a number, it never changes one.
router.get("/payment-approval/:id/adjustments", authenticate, requirePermission("payment-approval", "READ"), StockInvoicePaymentController.getAdjustmentsForApproval);
router.patch("/payment-approval/:id/decide", authenticate, requirePermission("payment-approval", "APPROVE"), StockInvoicePaymentController.decideApproval);
router.get("/payment-approval/:id/debit-notes", authenticate, requirePermission("payment-approval", "READ"), StockInvoicePaymentController.getDebitNotesForApproval);
router.get("/payment-approval-debit-notes", authenticate, requirePermission("payment-approval", "READ"), StockInvoicePaymentController.getApprovalQueue);
router.patch("/payment-approval/debit-notes/:id/decide", authenticate, requirePermission("payment-approval", "APPROVE_DEBIT_NOTE"), StockInvoicePaymentController.decideDebitNote);

// ─── Vendor Ledger ───────────────────────────────────────────────────────────
// Read-only by design: every figure here already happened on an invoice, a
// debit note or a payment. A write action would be a second way to change a
// balance, and then two places to look when one is wrong.
//
// Its own module, not a corner of "payments": a ledger is what gets shown to a
// vendor and to management, which is a wider audience than the desk that
// records payments.
/*
  Reports. Four modules, four routes, each checked against its own key so the
  data scope can differ per report.

  /reports/billing and /reports/account-summary deliberately hit the same
  service method (getVendorSummary). They are the same figures with different
  columns and different default filters — the alternative was a second copy of
  that arithmetic, and then two answers to one question.
*/
router.get("/reports/billing", authenticate, requirePermission("billing-report", "READ"), StockReportController.getBilling);

// The invoices behind one vendor's row. Guarded by the report that links to
// them, so a drill-down never 403s on somebody who can see the row above it.
router.get("/reports/billing/:vendorId/invoices", authenticate, requirePermission("billing-report", "READ"), StockReportController.getBillingInvoices);
router.get("/reports/account-summary", authenticate, requirePermission("account-summary", "READ"), StockReportController.getAccountSummary);
router.get("/reports/account-summary/:vendorId/invoices", authenticate, requirePermission("account-summary", "READ"), StockReportController.getAccountSummaryInvoices);
// One route, four tabs: ?type=ALL|PAYMENT|DEBIT_NOTE|MISC
router.get("/reports/paid", authenticate, requirePermission("paid-report", "READ"), StockReportController.getPaid);
router.get("/reports/paid/:vendorId/payments", authenticate, requirePermission("paid-report", "READ"), StockReportController.getPaidPayments);
router.get("/reports/transactions", authenticate, requirePermission("transaction-register", "READ"), StockReportController.getTransactions);
router.get("/reports/invoice-breakup", authenticate, requirePermission("invoice-breakup", "READ"), StockReportController.getInvoiceBreakup);

router.get("/vendor-ledger/:vendorId", authenticate, requirePermission("vendor-ledger", "READ"), StockVendorLedgerController.getVendorLedger);
router.get("/vendor-ledger/:vendorId/invoices", authenticate, requirePermission("vendor-ledger", "READ"), StockVendorLedgerController.getVendorInvoices);
router.get("/vendor-ledger/:vendorId/month", authenticate, requirePermission("vendor-ledger", "READ"), StockVendorLedgerController.getMonthDetail);

// ─── Branches ───────────────────────────────────────────────────────────────
// Branch PICKER for any module's own screen — gated on that module's READ, not
// on branches:READ, so a screen does not have to hand out Master > Branch just
// to let someone name their branch. Registered before /branches/* so the two
// are never confused: this one answers "where may I work", /branches/active
// answers "what branches exist".
//
// Only for pickers asking "where may I work". A picker that ASSIGNS a record to
// a branch is asking something else and stays on the unscoped list — the vendor
// branch field is the case to remember: it renders for admins only, and its
// whole job is reassigning a vendor to ANOTHER branch.
router.get(
  "/scoped-branches",
  authenticate,
  requirePermissionForQueryModule(["invoices", "inventory-items", "item-requests", "repairs", "employee-items", "stock-reports"], "READ"),
  StockBranchController.getScopedBranches
);

// The UNSCOPED list — every active branch, behind Master > Branch. For screens
// that genuinely need them all (product definitions' per-branch thresholds) or
// for admin tooling. A picker that only needs the caller's own branches should
// use /scoped-branches above instead.
// /active BEFORE /:id — same static-before-dynamic rule as everywhere else.
router.get("/branches/active", authenticate, requirePermission("branches", "READ"), StockBranchController.getActiveBranches);
router.post("/branches", authenticate, requirePermission("branches", "CREATE"), StockBranchController.createBranch);
router.get("/branches", authenticate, requirePermission("branches", "READ"), StockBranchController.getAllBranches);
router.get("/branches/:id", authenticate, requirePermission("branches", "READ"), StockBranchController.getBranchById);
router.put("/branches/:id", authenticate, requirePermission("branches", "UPDATE"), StockBranchController.updateBranch);
router.delete("/branches/:id", authenticate, requirePermission("branches", "DELETE"), StockBranchController.softDeleteBranch);
router.patch("/branches/:id/restore", authenticate, requirePermission("branches", "RESTORE"), StockBranchController.restoreBranch);

// ─── GST Rates ──────────────────────────────────────────────────────────────
router.get("/gst-rates/active", authenticate, StockGstRateController.getActiveGstRates);
router.post("/gst-rates", authenticate, requirePermission("gst-rates", "CREATE"), StockGstRateController.createGstRate);
router.get("/gst-rates", authenticate, requirePermission("gst-rates", "READ"), StockGstRateController.getAllGstRates);
router.get("/gst-rates/:id", authenticate, requirePermission("gst-rates", "READ"), StockGstRateController.getGstRateById);
router.put("/gst-rates/:id", authenticate, requirePermission("gst-rates", "UPDATE"), StockGstRateController.updateGstRate);
router.delete("/gst-rates/:id", authenticate, requirePermission("gst-rates", "DELETE"), StockGstRateController.softDeleteGstRate);
router.patch("/gst-rates/:id/restore", authenticate, requirePermission("gst-rates", "RESTORE"), StockGstRateController.restoreGstRate);

// ─── AI Settings ──────────────────────────────────────────────────────────────
// Which Claude model reads invoices. The key stays in .env; nothing here exposes it.
router.get("/ai-settings", authenticate, requirePermission("ai-settings", "READ"), StockAiSettingsController.get);
router.put("/ai-settings", authenticate, requirePermission("ai-settings", "UPDATE"), StockAiSettingsController.update);
router.post("/ai-settings/test", authenticate, requirePermission("ai-settings", "TEST"), StockAiSettingsController.test);
router.get("/ai-settings/usage", authenticate, requirePermission("ai-settings", "READ"), StockAiSettingsController.usage);
// Add Invoice shows which model will read the file — anyone who may add an invoice.
router.get("/ai-settings/invoice-scan", authenticate, requirePermission("invoices", "CREATE"), StockAiSettingsController.get);

// ─── Opening Stock ─────────────────────────────────────────────────────────────
// Stock that was on hand before this system. Static paths before /:id.
router.get("/opening-stock/form-options", authenticate, requirePermission("opening-stock", "READ"), StockOpeningStockController.getFormOptions);
router.get("/opening-stock/products", authenticate, requirePermission("opening-stock", "READ"), StockOpeningStockController.searchProducts);
router.get("/opening-stock/template/:productId", authenticate, requirePermission("opening-stock", "CREATE"), StockOpeningStockController.downloadTemplate);
router.post(
  "/opening-stock/parse/:productId",
  authenticate,
  requirePermission("opening-stock", "CREATE"),
  uploadOpeningStockSheet.single("file"),
  StockOpeningStockController.parseUpload
);
router.get("/opening-stock", authenticate, requirePermission("opening-stock", "READ"), StockOpeningStockController.list);
router.post("/opening-stock", authenticate, requirePermission("opening-stock", "CREATE"), StockOpeningStockController.create);
router.get("/opening-stock/:id", authenticate, requirePermission("opening-stock", "READ"), StockOpeningStockController.getById);
router.put("/opening-stock/:id", authenticate, requirePermission("opening-stock", "UPDATE"), StockOpeningStockController.update);
router.delete("/opening-stock/:id", authenticate, requirePermission("opening-stock", "DELETE"), StockOpeningStockController.remove);
router.patch("/opening-stock/:id/post", authenticate, requirePermission("opening-stock", "POST"), StockOpeningStockController.post);

// ─── Opening Issued Stock ──────────────────────────────────────────────────────
// Stock already with one person (employee or subscriber) before this system —
// the same entries as above, kind ISSUED, on their own module.
router.get("/opening-issued-stock/form-options", authenticate, requirePermission("opening-issued-stock", "READ"), StockOpeningIssuedStockController.getFormOptions);
router.get("/opening-issued-stock/products", authenticate, requirePermission("opening-issued-stock", "READ"), StockOpeningIssuedStockController.searchProducts);
router.get("/opening-issued-stock", authenticate, requirePermission("opening-issued-stock", "READ"), StockOpeningIssuedStockController.list);
router.post("/opening-issued-stock", authenticate, requirePermission("opening-issued-stock", "CREATE"), StockOpeningIssuedStockController.create);
router.get("/opening-issued-stock/:id", authenticate, requirePermission("opening-issued-stock", "READ"), StockOpeningIssuedStockController.getById);
router.put("/opening-issued-stock/:id", authenticate, requirePermission("opening-issued-stock", "UPDATE"), StockOpeningIssuedStockController.update);
router.delete("/opening-issued-stock/:id", authenticate, requirePermission("opening-issued-stock", "DELETE"), StockOpeningIssuedStockController.remove);
router.patch("/opening-issued-stock/:id/post", authenticate, requirePermission("opening-issued-stock", "POST"), StockOpeningIssuedStockController.post);

// ─── People Directory ──────────────────────────────────────────────────────────
// Who stock can be with — one search over the people API plus hand-added
// people. Used from the screens named in ?module=, on their permissions.
router.get(
  "/people/search",
  authenticate,
  requirePermissionForQueryModule(["opening-issued-stock", "employee-items"], "READ"),
  StockPeopleDirectoryController.search
);
router.post(
  "/people/select",
  authenticate,
  requirePermissionForQueryModule(null, { "opening-issued-stock": "CREATE", "employee-items": "ASSIGN" }),
  StockPeopleDirectoryController.select
);
router.post(
  "/people",
  authenticate,
  requirePermissionForQueryModule(null, { "opening-issued-stock": "CREATE", "employee-items": "ASSIGN" }),
  StockPeopleDirectoryController.create
);

// ─── Item Requests (store side) ────────────────────────────────────────────────
// Raised by the NOC / broadband website (routes/external.routes.js) or the test
// simulator below; issued, short-closed or rejected here. Static paths first.
router.get("/item-requests/status-counts", authenticate, requirePermission("item-requests", "READ"), StockItemRequestController.statusCounts);
router.get("/item-requests/type-counts", authenticate, requirePermission("item-requests", "READ"), StockItemRequestController.typeCounts);
router.get("/item-requests/subscribers", authenticate, requirePermission("item-requests", "READ"), StockItemRequestController.subscribersWithItems);
router.get("/item-requests/subscribers/:subscriberId", authenticate, requirePermission("item-requests", "READ"), StockItemRequestController.subscriberItems);
router.get("/item-requests", authenticate, requirePermission("item-requests", "READ"), StockItemRequestController.list);
router.get("/item-requests/:id", authenticate, requirePermission("item-requests", "READ"), StockItemRequestController.getById);
router.get("/item-requests/:id/units", authenticate, requirePermission("item-requests", "ISSUE"), StockItemRequestController.availableUnits);
router.patch("/item-requests/:id/issue", authenticate, requirePermission("item-requests", "ISSUE"), StockItemRequestController.issue);
router.patch("/item-requests/:id/receive", authenticate, requirePermission("item-requests", "RECEIVE"), StockItemRequestController.receive);
// Replace one row: old back and/or new out — needs both rights.
router.patch("/item-requests/:id/swap", authenticate, requirePermission("item-requests", "RECEIVE"), requirePermission("item-requests", "ISSUE"), StockItemRequestController.swap);
router.patch("/item-requests/:id/short-close", authenticate, requirePermission("item-requests", "SHORT_CLOSE"), StockItemRequestController.shortClose);
// One line of a request closed short — the same right as closing all of it.
router.patch("/item-requests/:id/lines/:lineId/close", authenticate, requirePermission("item-requests", "SHORT_CLOSE"), StockItemRequestController.closeLine);
router.patch("/item-requests/:id/reject", authenticate, requirePermission("item-requests", "REJECT"), StockItemRequestController.reject);

// ─── Repair & Warranty ──────────────────────────────────────────────────────────
// What happens to our broken units — see services/stock.repair.service.js.
router.get("/repairs/counts", authenticate, requirePermission("repairs", "READ"), StockRepairController.counts);
router.get("/repairs/vendors", authenticate, requirePermission("repairs", "READ"), StockRepairController.vendors);
router.get("/repairs", authenticate, requirePermission("repairs", "READ"), StockRepairController.list);
router.patch("/repairs/:id/report-faulty", authenticate, requirePermission("repairs", "REPORT"), StockRepairController.reportFaulty);
router.patch("/repairs/:id/send-repair", authenticate, requirePermission("repairs", "MANAGE"), StockRepairController.sendForRepair);
router.patch("/repairs/:id/repair-result", authenticate, requirePermission("repairs", "MANAGE"), StockRepairController.repairResult);
router.patch("/repairs/:id/claim", authenticate, requirePermission("repairs", "MANAGE"), StockRepairController.sendClaim);
router.patch("/repairs/:id/claim-outcome", authenticate, requirePermission("repairs", "MANAGE"), StockRepairController.claimOutcome);
router.patch("/repairs/:id/mark-ok", authenticate, requirePermission("repairs", "MANAGE"), StockRepairController.markOk);
router.patch("/repairs/:id/scrap", authenticate, requirePermission("repairs", "SCRAP"), StockRepairController.scrap);

// ─── Employee Items ────────────────────────────────────────────────────────────
// Stock with our own people — see services/stock.employee.item.service.js.
router.get("/employee-items/available", authenticate, requirePermission("employee-items", "ASSIGN"), StockEmployeeItemController.available);
router.get("/employee-items/employees", authenticate, requirePermission("employee-items", "READ"), StockEmployeeItemController.employees);
router.get("/employee-items/items", authenticate, requirePermission("employee-items", "READ"), StockEmployeeItemController.employeeItems);
router.post("/employee-items/assign", authenticate, requirePermission("employee-items", "ASSIGN"), StockEmployeeItemController.assign);
router.post("/employee-items/return", authenticate, requirePermission("employee-items", "RETURN"), StockEmployeeItemController.returnItems);

// ─── Stock Reports (inventory, not billing) ────────────────────────────────────
router.get("/stock-reports/position", authenticate, requirePermission("stock-reports", "READ"), StockInventoryReportController.position);
router.get("/stock-reports/value", authenticate, requirePermission("stock-reports", "READ"), StockInventoryReportController.value);
router.get("/stock-reports/warranty", authenticate, requirePermission("stock-reports", "READ"), StockInventoryReportController.warranty);
router.get("/stock-reports/subscribers", authenticate, requirePermission("stock-reports", "READ"), StockInventoryReportController.subscribers);
router.get("/stock-reports/repairs", authenticate, requirePermission("stock-reports", "READ"), StockInventoryReportController.repairs);

// ─── 🧪 Request Simulator (TEST ONLY — remove when the real website is live) ───
// Plays the requesting website; see services/stock.test.simulator.service.js.
router.get("/test-simulator/meta", authenticate, requirePermission("test-simulator", "READ"), StockTestSimulatorController.meta);
router.get("/test-simulator/subscribers", authenticate, requirePermission("test-simulator", "READ"), StockTestSimulatorController.listSubscribers);
router.get("/test-simulator/subscribers/:subscriberId/items", authenticate, requirePermission("test-simulator", "READ"), StockTestSimulatorController.holdings);
router.post("/test-simulator/subscribers", authenticate, requirePermission("test-simulator", "CREATE"), StockTestSimulatorController.createSubscriber);
router.post("/test-simulator/subscribers/:subscriberId/requests", authenticate, requirePermission("test-simulator", "REQUEST"), StockTestSimulatorController.sendRequest);
router.get("/test-simulator/requests/:requestId", authenticate, requirePermission("test-simulator", "READ"), StockTestSimulatorController.getRequest);
router.put("/test-simulator/requests/:requestId", authenticate, requirePermission("test-simulator", "REQUEST"), StockTestSimulatorController.resendRequest);
router.post("/test-simulator/requests/:requestId/withdraw", authenticate, requirePermission("test-simulator", "REQUEST"), StockTestSimulatorController.withdrawRequest);

// ─── Inventory Transfer Requests ──────────────────────────────────────────────
router.post("/transfer-requests", authenticate, requirePermission("transfer-requests", "CREATE"), StockTransferRequestController.createTransferRequest);
router.get("/transfer-requests/board", authenticate, requirePermission("transfer-requests", "READ"), StockTransferRequestController.getBoard);
router.get("/transfer-requests/branches", authenticate, requirePermission("transfer-requests", "READ"), StockTransferRequestController.getFormBranches);
router.get("/transfer-requests/:id", authenticate, requirePermission("transfer-requests", "READ"), StockTransferRequestController.getTransferRequestById);
router.patch("/transfer-requests/:id/process", authenticate, requirePermission("transfer-requests", "PROCESS"), StockTransferRequestController.processTransferRequest);
router.patch("/transfer-requests/:id/reject", authenticate, requirePermission("transfer-requests", "REJECT"), StockTransferRequestController.rejectTransferRequest);


export default router;
