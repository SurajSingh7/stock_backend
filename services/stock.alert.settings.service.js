import StockAlertSettingsModel from "../models/stock.alert.settings.model.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import { getAlertProvider } from "../helpers/alert.providers/index.js";
import { ALERT_CHANNEL } from "../constants/stock.enums.js";
import { normalizePhone } from "./stock.alert.recipient.service.js";

const ENTITY_TYPE = "alert_settings";

// Read on every send — cached briefly so a burst of 50 messages is one query.
let cache = null;
let cacheAt = 0;
const CACHE_MS = 5000;

export default class StockAlertSettingsService {
  static async get({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cacheAt < CACHE_MS) return cache;
    let doc = await StockAlertSettingsModel.findOne({ key: "global" }).lean();
    if (!doc) {
      await StockAlertSettingsModel.updateOne({ key: "global" }, { $setOnInsert: { key: "global" } }, { upsert: true });
      doc = await StockAlertSettingsModel.findOne({ key: "global" }).lean();
    }
    cache = doc;
    cacheAt = Date.now();
    return doc;
  }

  static invalidate() {
    cache = null;
  }

  static async isChannelEnabled(channel) {
    const s = await StockAlertSettingsService.get();
    return !!s.channels?.[channel]?.enabled;
  }

  /** Channels tab: switches + whether each provider is set up and connected. */
  static async getOverview() {
    const settings = await StockAlertSettingsService.get({ fresh: true });
    const channels = [];
    for (const channel of [ALERT_CHANNEL.EMAIL, ALERT_CHANNEL.WHATSAPP, ALERT_CHANNEL.IN_APP]) {
      const provider = getAlertProvider(channel);
      let health = { configured: false, connected: false, detail: "Coming in a later phase" };
      if (provider) health = provider.health ? await provider.health() : provider.status();
      channels.push({
        channel,
        enabled: !!settings.channels?.[channel]?.enabled,
        provider: provider?.name || null,
        ...health,
      });
    }
    return { settings, channels };
  }

  static async update(body, actor) {
    const before = await StockAlertSettingsService.get({ fresh: true });
    const $set = {};

    if (body.channels) {
      for (const ch of Object.keys(body.channels)) {
        if (!Object.values(ALERT_CHANNEL).includes(ch)) throw new Error(`Invalid channel ${ch}`);
        if (body.channels[ch]?.enabled !== undefined) $set[`channels.${ch}.enabled`] = !!body.channels[ch].enabled;
      }
    }
    if (body.sandbox) {
      const { enabled, email, phone } = body.sandbox;
      if (enabled !== undefined) $set["sandbox.enabled"] = !!enabled;
      if (email !== undefined) $set["sandbox.email"] = String(email || "").trim().toLowerCase();
      if (phone !== undefined) {
        const n = phone ? normalizePhone(phone) : "";
        if (phone && !n) throw new Error("Invalid sandbox WhatsApp number — use digits with country code");
        $set["sandbox.phone"] = n;
      }
    }
    if (body.officeHours) {
      const { enabled, days, start, end } = body.officeHours;
      const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (enabled !== undefined) $set["officeHours.enabled"] = !!enabled;
      if (days !== undefined) {
        if (!Array.isArray(days) || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
          throw new Error("Invalid office days — use 0 (Sunday) to 6 (Saturday)");
        }
        $set["officeHours.days"] = [...new Set(days)].sort();
      }
      if (start !== undefined) {
        if (!hhmm.test(start)) throw new Error("Invalid office start time — use HH:MM");
        $set["officeHours.start"] = start;
      }
      if (end !== undefined) {
        if (!hhmm.test(end)) throw new Error("Invalid office end time — use HH:MM");
        $set["officeHours.end"] = end;
      }
    }
    if (body.digest) {
      const { enabled, time } = body.digest;
      if (enabled !== undefined) $set["digest.enabled"] = !!enabled;
      if (time !== undefined) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Invalid digest time — use HH:MM");
        $set["digest.time"] = time;
      }
    }

    const nextStart = $set["officeHours.start"] ?? before.officeHours?.start;
    const nextEnd = $set["officeHours.end"] ?? before.officeHours?.end;
    if (nextStart && nextEnd && nextStart >= nextEnd) throw new Error("Office end time must be after the start time");

    await StockAlertSettingsModel.updateOne({ key: "global" }, { $set });
    StockAlertSettingsService.invalidate();
    const after = await StockAlertSettingsService.get({ fresh: true });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: after._id, action: "UPDATE", actor, before, after,
    });
    return after;
  }
}
