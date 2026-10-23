import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import { listAlertEvents } from "../config/alert.event.catalog.js";
import { getAlertProvider } from "../helpers/alert.providers/index.js";
import StockAlertSettingsService from "../services/stock.alert.settings.service.js";
import { StockAlertContactService, StockAlertGroupService } from "../services/stock.alert.contact.service.js";
import StockAlertTemplateService from "../services/stock.alert.template.service.js";
import StockAlertRuleService from "../services/stock.alert.rule.service.js";
import { StockAlertMessageService, StockAlertEscalationService } from "../services/stock.alert.message.service.js";
import StockAlertDigestService from "../services/stock.alert.digest.service.js";
import StockAlertManualService from "../services/stock.alert.manual.service.js";
import StockAlertInboxService from "../services/stock.alert.inbox.service.js";
import { addInboxClient } from "../helpers/alert.inbox.hub.js";
import { ALERT_CHANNEL } from "../constants/stock.enums.js";

const log = getLogger(import.meta.url);

// One wrapper for every handler: same envelope, same logging.
const handle = (label, fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out && out.__paged) {
      const { page, limit } = paginate(req.query);
      const body = paginateReturn(out.data, out.total, page, limit);
      // successResponseHandler keeps only data + pagination, so extras ride on pagination.
      if (out.extra) Object.assign(body.pagination, out.extra);
      return successResponseHandler(res, body, `${label} fetched successfully`);
    }
    return successResponseHandler(res, out, `${label} successful`);
  } catch (error) {
    log.error(`${label} failed`, error.message);
    return errorResponseHandler(res, error);
  }
};

const paged = (result, extra) => ({ __paged: true, data: result.data, total: result.total, extra });
const listQuery = (req) => {
  const { skip, limit } = paginate(req.query);
  return { ...req.query, skip, limit, showInactive: req.query.showInactive === "true" };
};

export default class StockAlertController {
  // Reference data
  static listEvents = handle("Events", () => listAlertEvents());

  static listWhatsappGroups = handle("WhatsApp groups", async () => {
    const provider = getAlertProvider(ALERT_CHANNEL.WHATSAPP);
    if (!provider?.listGroups) throw new Error("This WhatsApp provider cannot list groups");
    return provider.listGroups();
  });

  // Channels / settings
  static getOverview = handle("Channels", () => StockAlertSettingsService.getOverview());
  static updateSettings = handle("Settings update", (req) => StockAlertSettingsService.update(req.body || {}, req.user));
  static testChannel = handle("Channel test", (req) =>
    StockAlertMessageService.sendChannelTest(req.params.channel, req.body || {}, req.user)
  );

  // The signed-in user's bell
  static myInbox = handle("Notifications", async (req) => {
    const { skip, limit } = paginate(req.query);
    const r = await StockAlertInboxService.list(req.user, { skip, limit, unread: req.query.unread });
    return paged(r, { unread: r.unreadCount });
  });
  static myUnreadCount = handle("Unread count", (req) => StockAlertInboxService.unreadCount(req.user));
  static markInboxRead = handle("Mark read", (req) => StockAlertInboxService.markRead(req.user, req.params.id));
  static markInboxAllRead = handle("Mark all read", (req) => StockAlertInboxService.markAllRead(req.user));

  // Live stream: stays open, pushes "notification" / "read" events.
  static inboxStream(req, res) {
    const userId = req.user?._id ?? req.user?.id;
    if (!userId) return res.status(401).end();
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    res.write("retry: 10000\n\n");
    const remove = addInboxClient(userId, res);
    req.on("close", remove);
    return undefined;
  }

  // What a manual send dialog starts with (PO → vendor).
  static previewManual = handle("Manual preview", async (req) => {
    const { _ctx, _attachDocument, ...out } = await StockAlertManualService.prepare(req.params.eventKey, req.params.recordId);
    return out;
  });

  // Morning summary, right now (does not touch today's scheduled one).
  static sendDigestNow = handle("Summary", (req) => StockAlertDigestService.send({ actor: req.user }));

  // Contacts
  static listContacts = handle("Contacts", async (req) => paged(await StockAlertContactService.list(listQuery(req))));
  static createContact = handle("Contact create", (req) => StockAlertContactService.create(req.body || {}, req.user));
  static updateContact = handle("Contact update", (req) => StockAlertContactService.update(req.params.id, req.body || {}, req.user));
  static deleteContact = handle("Contact delete", (req) => StockAlertContactService.remove(req.params.id, req.user));

  // Groups
  static listGroups = handle("Groups", async (req) => paged(await StockAlertGroupService.list(listQuery(req))));
  static createGroup = handle("Group create", (req) => StockAlertGroupService.create(req.body || {}, req.user));
  static updateGroup = handle("Group update", (req) => StockAlertGroupService.update(req.params.id, req.body || {}, req.user));
  static deleteGroup = handle("Group delete", (req) => StockAlertGroupService.remove(req.params.id, req.user));

  // Templates
  static listTemplates = handle("Templates", async (req) => paged(await StockAlertTemplateService.list(listQuery(req))));
  static getTemplate = handle("Template", (req) => StockAlertTemplateService.getById(req.params.id));
  static createTemplate = handle("Template create", (req) => StockAlertTemplateService.create(req.body || {}, req.user));
  static updateTemplate = handle("Template update", (req) => StockAlertTemplateService.update(req.params.id, req.body || {}, req.user));
  static deleteTemplate = handle("Template delete", (req) => StockAlertTemplateService.remove(req.params.id, req.user));
  static previewTemplate = handle("Template preview", (req) => StockAlertTemplateService.preview(req.body || {}));
  static testTemplate = handle("Template test", (req) => StockAlertMessageService.sendTest(req.params.id, req.body || {}, req.user));

  // Rules
  static listRules = handle("Rules", async (req) => paged(await StockAlertRuleService.list(listQuery(req))));
  static getRule = handle("Rule", (req) => StockAlertRuleService.getById(req.params.id));
  static createRule = handle("Rule create", (req) => StockAlertRuleService.create(req.body || {}, req.user));
  static updateRule = handle("Rule update", (req) => StockAlertRuleService.update(req.params.id, req.body || {}, req.user));
  static toggleRule = handle("Rule switch", (req) => StockAlertRuleService.setEnabled(req.params.id, req.body?.enabled, req.user));
  static deleteRule = handle("Rule delete", (req) => StockAlertRuleService.remove(req.params.id, req.user));

  // Escalations
  static listEscalations = handle("Escalations", async (req) => paged(await StockAlertEscalationService.list(listQuery(req))));
  static stopEscalation = handle("Escalation stop", (req) => StockAlertEscalationService.stop(req.params.id, req.body?.reason, req.user));

  // Message log
  static listMessages = handle("Messages", async (req) => {
    const r = await StockAlertMessageService.list(listQuery(req));
    return paged(r, { counts: r.counts });
  });
  static getMessage = handle("Message", (req) => StockAlertMessageService.getById(req.params.id));
  static resendMessage = handle("Resend", (req) => StockAlertMessageService.resend(req.params.id, req.user));
  static cancelMessage = handle("Cancel", (req) => StockAlertMessageService.cancel(req.params.id, req.user));
}
