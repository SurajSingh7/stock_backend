import express from "express";
import StockAlertController from "../controllers/stock.alert.controller.js";
import { authenticate } from "../middlewares/stock.auth.middleware.js";
import { requirePermission } from "../middlewares/stock.permission.middleware.js";
import { getAlertEvent } from "../config/alert.event.catalog.js";

/*
  Alerts & Escalations — mounted at /api/v1/stock/alerts.

  One Access Control module per tab (alert-channels, alert-contacts, …) so a
  person can be given the Message Log without being able to edit rules.
  Static sub-paths sit above their /:id siblings.
*/
const router = express.Router();
const can = (module, action) => [authenticate, requirePermission(module, action)];

// Reference data — the event catalog is not sensitive, any signed-in user may read it.
router.get("/events", authenticate, StockAlertController.listEvents);
router.get("/whatsapp-groups", ...can("alert-contacts", "READ"), StockAlertController.listWhatsappGroups);

// The website bell — every signed-in user, their own rows only.
router.get("/inbox", authenticate, StockAlertController.myInbox);
router.get("/inbox/unread-count", authenticate, StockAlertController.myUnreadCount);
router.get("/inbox/stream", authenticate, StockAlertController.inboxStream);
router.patch("/inbox/read-all", authenticate, StockAlertController.markInboxAllRead);
router.patch("/inbox/:id/read", authenticate, StockAlertController.markInboxRead);

// Manual send dialogs — gated by the permission of the screen they open from
// (catalog `permission`), not by an alerts module.
const manualPermission = (req, res, next) => {
  const perm = getAlertEvent(req.params.eventKey)?.permission;
  if (!perm) return res.status(404).json({ success: false, message: "Unknown manual event" });
  return requirePermission(perm[0], perm[1])(req, res, next);
};
router.get("/manual/:eventKey/:recordId/preview", authenticate, manualPermission, StockAlertController.previewManual);

// Channels
router.get("/channels", ...can("alert-channels", "READ"), StockAlertController.getOverview);
router.put("/settings", ...can("alert-channels", "UPDATE"), StockAlertController.updateSettings);
router.post("/channels/:channel/test", ...can("alert-channels", "TEST"), StockAlertController.testChannel);
router.post("/digest/send", ...can("alert-channels", "TEST"), StockAlertController.sendDigestNow);

// Contacts & groups
router.get("/contacts", ...can("alert-contacts", "READ"), StockAlertController.listContacts);
router.post("/contacts", ...can("alert-contacts", "CREATE"), StockAlertController.createContact);
router.put("/contacts/:id", ...can("alert-contacts", "UPDATE"), StockAlertController.updateContact);
router.delete("/contacts/:id", ...can("alert-contacts", "DELETE"), StockAlertController.deleteContact);
router.get("/groups", ...can("alert-contacts", "READ"), StockAlertController.listGroups);
router.post("/groups", ...can("alert-contacts", "CREATE"), StockAlertController.createGroup);
router.put("/groups/:id", ...can("alert-contacts", "UPDATE"), StockAlertController.updateGroup);
router.delete("/groups/:id", ...can("alert-contacts", "DELETE"), StockAlertController.deleteGroup);

// Templates
router.get("/templates", ...can("alert-templates", "READ"), StockAlertController.listTemplates);
router.post("/templates/preview", ...can("alert-templates", "READ"), StockAlertController.previewTemplate);
router.post("/templates", ...can("alert-templates", "CREATE"), StockAlertController.createTemplate);
router.get("/templates/:id", ...can("alert-templates", "READ"), StockAlertController.getTemplate);
router.put("/templates/:id", ...can("alert-templates", "UPDATE"), StockAlertController.updateTemplate);
router.delete("/templates/:id", ...can("alert-templates", "DELETE"), StockAlertController.deleteTemplate);
router.post("/templates/:id/test", ...can("alert-templates", "TEST"), StockAlertController.testTemplate);

// Rules
router.get("/rules", ...can("alert-rules", "READ"), StockAlertController.listRules);
router.post("/rules", ...can("alert-rules", "CREATE"), StockAlertController.createRule);
router.get("/rules/:id", ...can("alert-rules", "READ"), StockAlertController.getRule);
router.put("/rules/:id", ...can("alert-rules", "UPDATE"), StockAlertController.updateRule);
router.patch("/rules/:id/enabled", ...can("alert-rules", "UPDATE"), StockAlertController.toggleRule);
router.delete("/rules/:id", ...can("alert-rules", "DELETE"), StockAlertController.deleteRule);

// Escalations
router.get("/escalations", ...can("alert-escalations", "READ"), StockAlertController.listEscalations);
router.patch("/escalations/:id/stop", ...can("alert-escalations", "STOP"), StockAlertController.stopEscalation);

// Message log
router.get("/messages", ...can("alert-log", "READ"), StockAlertController.listMessages);
router.get("/messages/:id", ...can("alert-log", "READ"), StockAlertController.getMessage);
router.post("/messages/:id/resend", ...can("alert-log", "RESEND"), StockAlertController.resendMessage);
router.patch("/messages/:id/cancel", ...can("alert-log", "CANCEL"), StockAlertController.cancelMessage);

export default router;
