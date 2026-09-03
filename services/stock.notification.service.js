import StockNotificationModel from "../models/stock.notification.model.js";
import StockVendorModel from "../models/stock.vendor.model.js";
import { actorSnapshot } from "../models/plugins/actor.stamp.plugin.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import { NOTIFICATION_CHANNEL } from "../constants/stock.enums.js";

const ENTITY_TYPE = "notifications";

const escapeRegex = (str = "") => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export default class StockNotificationService {
  /**
   * A vendor may hold at most ONE non-default notification per channel.
   *
   * resolveForVendor() looks the vendor up with findOne().sort({ updatedAt: -1 }),
   * so two matches do not error — the newer one silently wins, and the admin has
   * no way to tell which template a PO will actually go out on. Exclusivity is
   * per channel on purpose: the same vendor legitimately has one EMAIL and one
   * WHATSAPP notification, and those resolve independently.
   */
  static async assertNoVendorOverlap(channel, vendorIds, excludeId, session) {
    const ids = (vendorIds || []).map(String);
    if (!ids.length) return;

    const filter = {
      isActive: true,
      isDefault: false,
      channel,
      applicableVendors: { $in: ids },
    };
    if (excludeId) filter._id = { $ne: excludeId };

    const clash = await StockNotificationModel.findOne(filter)
      .populate("applicableVendors", "name")
      .session(session ?? null)
      .lean();
    if (!clash) return;

    const taken = (clash.applicableVendors || [])
      .filter((v) => ids.includes(String(v._id)))
      .map((v) => v.name)
      .join(", ");
    throw new Error(
      `${taken || "A selected vendor"} already belongs to "${clash.name}" on this channel. ` +
        `Remove it there first, or pick a different vendor.`
    );
  }

  /**
   * Vendors this notification may still choose: active vendors minus the ones
   * already spoken for on this channel. When editing, the notification keeps
   * its OWN vendors in the list — otherwise its saved selection would vanish
   * from its own form.
   */
  static async getAssignableVendors({ channel, excludeNotificationId, search } = {}) {
    const filter = { isActive: true, isDefault: false, channel };
    if (excludeNotificationId) filter._id = { $ne: excludeNotificationId };

    const taken = await StockNotificationModel.find(filter).select("applicableVendors").lean();
    const takenIds = taken.flatMap((x) => (x.applicableVendors || []).map(String));

    const vendorFilter = { isActive: true };
    if (takenIds.length) vendorFilter._id = { $nin: takenIds };
    if (search) vendorFilter.name = { $regex: escapeRegex(search), $options: "i" };

    return StockVendorModel.find(vendorFilter).select("name").sort({ name: 1 }).limit(50).lean();
  }

  // ─── Create ──────────────────────────────────────────────────────────────

  static async createNotification(body, actor, session) {
    try {
      const { name, channel, note, ccEmails, isDefault, applicableVendors } = body;
      const wantsDefault = !!isDefault;

      // Only one ACTIVE default per channel — demote whatever currently
      // holds it for this channel rather than making the admin do it first.
      // Validated BEFORE the demote below: if this throws afterwards, another
      // notification has already lost its default and nothing put it back.
      if (!wantsDefault) {
        await StockNotificationService.assertNoVendorOverlap(
          channel,
          applicableVendors,
          null,
          session
        );
      }

      if (wantsDefault) {
        await StockNotificationModel.updateMany(
          { isActive: true, isDefault: true, channel },
          { $set: { isDefault: false } },
          { session }
        );
      }

      const [notification] = await StockNotificationModel.create(
        [
          {
            name: name.trim(),
            channel,
            note: (note || "").trim(),
            ccEmails: (ccEmails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean),
            isDefault: wantsDefault,
            applicableVendors: wantsDefault ? [] : applicableVendors || [],
          },
        ],
        { session }
      );
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: notification._id, action: "CREATE", actor, before: null, after: notification.toObject(),
      });
      return notification;
    } catch (error) {
      throw error;
    }
  }

  // ─── List ────────────────────────────────────────────────────────────────

  static async getAllNotifications({ skip, limit, search, channel, showInactive }) {
    try {
      const filter = showInactive ? {} : { isActive: true };
      if (search) filter.name = { $regex: escapeRegex(search.trim()), $options: "i" };
      if (channel) filter.channel = channel;

      const [data, total] = await Promise.all([
        StockNotificationModel.find(filter)
          .populate("applicableVendors", "name")
          .sort({ isDefault: -1, createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        StockNotificationModel.countDocuments(filter),
      ]);

      return { data, total };
    } catch (error) {
      throw error;
    }
  }

  // ─── Get one ─────────────────────────────────────────────────────────────

  static async getNotificationById(id) {
    try {
      const notification = await StockNotificationModel.findOne({ _id: id, isActive: true })
        .populate("applicableVendors", "name")
        .lean();
      if (!notification) throw new Error("Notification not found");
      return notification;
    } catch (error) {
      throw error;
    }
  }

  // ─── Update ──────────────────────────────────────────────────────────────

  static async updateNotification(id, body, actor, session) {
    try {
      const notification = await StockNotificationModel.findOne({ _id: id, isActive: true }).session(session);
      if (!notification) throw new Error("Notification not found");
      const before = notification.toObject();

      const { name, channel, note, ccEmails, isDefault, applicableVendors } = body;
      const nextChannel = channel !== undefined ? channel : notification.channel;
      const nextIsDefault = isDefault !== undefined ? !!isDefault : notification.isDefault;

      if (nextIsDefault && !(notification.isDefault && nextChannel === notification.channel)) {
        await StockNotificationModel.updateMany(
          { isActive: true, isDefault: true, channel: nextChannel, _id: { $ne: notification._id } },
          { $set: { isDefault: false } },
          { session }
        );
      }

      if (name !== undefined) notification.name = name.trim();
      if (channel !== undefined) notification.channel = channel;
      if (note !== undefined) notification.note = String(note).trim();
      if (ccEmails !== undefined) {
        notification.ccEmails = (ccEmails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
      }
      if (!nextIsDefault) {
        // excludeId is this record: its own vendors must not count as a clash
        // with itself.
        await StockNotificationService.assertNoVendorOverlap(
          nextChannel,
          applicableVendors,
          notification._id,
          session
        );
      }

      notification.isDefault = nextIsDefault;
      notification.applicableVendors = nextIsDefault ? [] : applicableVendors || [];

      await notification.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: notification._id, action: "UPDATE", actor, before, after: notification.toObject(),
      });
      return notification;
    } catch (error) {
      throw error;
    }
  }

  // ─── Soft delete ─────────────────────────────────────────────────────────

  static async softDeleteNotification(id, actor, session) {
    try {
      const notification = await StockNotificationModel.findOne({ _id: id, isActive: true }).session(session);
      if (!notification) throw new Error("Notification not found");
      const before = notification.toObject();

      notification.isActive = false;
      notification.deletedAt = new Date();
      notification.deletedBy = actorSnapshot(actor);
      await notification.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: notification._id, action: "DELETE", actor, before, after: notification.toObject(),
      });
      return notification;
    } catch (error) {
      throw error;
    }
  }

  // ─── Restore ─────────────────────────────────────────────────────────────

  static async restoreNotification(id, actor, session) {
    try {
      const notification = await StockNotificationModel.findOne({ _id: id }).session(session);
      if (!notification) throw new Error("Notification not found");
      if (notification.isActive) throw new Error("Notification is already active");
      const before = notification.toObject();

      if (notification.isDefault) {
        await StockNotificationModel.updateMany(
          { isActive: true, isDefault: true, channel: notification.channel, _id: { $ne: notification._id } },
          { $set: { isDefault: false } },
          { session }
        );
      }

      notification.isActive = true;
      notification.deletedAt = null;
      notification.deletedBy = null;
      await notification.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: notification._id, action: "RESTORE", actor, before, after: notification.toObject(),
      });
      return notification;
    } catch (error) {
      throw error;
    }
  }

  // ─── Resolve — used by PO Send Mail (vendor-assigned wins, else channel  ─
  // default, else null — caller decides what "nothing configured" means).

  static async resolveForVendor(vendorId, channel = NOTIFICATION_CHANNEL.EMAIL, session) {
    try {
      if (vendorId) {
        const vendorNotification = await StockNotificationModel.findOne({
          isActive: true,
          channel,
          isDefault: false,
          applicableVendors: vendorId,
        })
          .sort({ updatedAt: -1 })
          .session(session ?? null)
          .lean();

        if (vendorNotification) return { notification: vendorNotification, source: "VENDOR" };
      }

      const defaultNotification = await StockNotificationModel.findOne({
        isActive: true,
        channel,
        isDefault: true,
      })
        .session(session ?? null)
        .lean();

      if (defaultNotification) return { notification: defaultNotification, source: "DEFAULT" };

      return { notification: null, source: "NONE" };
    } catch (error) {
      throw error;
    }
  }
}
