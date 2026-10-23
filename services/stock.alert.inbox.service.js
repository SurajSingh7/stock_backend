import mongoose from "mongoose";
import StockAlertInboxModel from "../models/stock.alert.inbox.model.js";
import StockAlertMessageModel from "../models/stock.alert.message.model.js";
import { pushToUser } from "../helpers/alert.inbox.hub.js";
import { ALERT_MESSAGE_STATUS } from "../constants/stock.enums.js";

/*
  The signed-in user's own bell. Every query is pinned to req.user's id —
  there is no way to read or mark someone else's notifications.
*/
const userIdOf = (user) => {
  const id = user?._id ?? user?.id;
  if (!id || !mongoose.isValidObjectId(id)) throw new Error("Unauthenticated user");
  return new mongoose.Types.ObjectId(String(id));
};

// The Message Log row turns READ too, so senders can see it was seen.
const markMessagesRead = (messageIds) =>
  messageIds.length
    ? StockAlertMessageModel.updateMany(
        { _id: { $in: messageIds }, status: { $ne: ALERT_MESSAGE_STATUS.READ } },
        {
          $set: { status: ALERT_MESSAGE_STATUS.READ, readAt: new Date() },
          $push: { log: { at: new Date(), event: "READ", detail: "Opened in the website bell" } },
        }
      )
    : null;

export default class StockAlertInboxService {
  static async list(user, { skip = 0, limit = 20, unread } = {}) {
    const filter = { userId: userIdOf(user) };
    if (unread === "true" || unread === true) filter.readAt = null;
    const [data, total, unreadCount] = await Promise.all([
      StockAlertInboxModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      StockAlertInboxModel.countDocuments(filter),
      StockAlertInboxModel.countDocuments({ userId: filter.userId, readAt: null }),
    ]);
    return { data, total, unreadCount };
  }

  static async unreadCount(user) {
    return { unread: await StockAlertInboxModel.countDocuments({ userId: userIdOf(user), readAt: null }) };
  }

  static async markRead(user, id) {
    const userId = userIdOf(user);
    const row = await StockAlertInboxModel.findOneAndUpdate(
      { _id: id, userId },
      [{ $set: { readAt: { $ifNull: ["$readAt", "$$NOW"] } } }],
      { new: true }
    ).lean();
    if (!row) throw new Error("Notification not found");
    if (row.messageId) await markMessagesRead([row.messageId]);
    pushToUser(userId, "read", { ids: [String(row._id)] });
    return row;
  }

  static async markAllRead(user) {
    const userId = userIdOf(user);
    const unread = await StockAlertInboxModel.find({ userId, readAt: null }).select("_id messageId").lean();
    if (!unread.length) return { updated: 0 };
    await StockAlertInboxModel.updateMany({ _id: { $in: unread.map((r) => r._id) } }, { $set: { readAt: new Date() } });
    await markMessagesRead(unread.map((r) => r.messageId).filter(Boolean));
    pushToUser(userId, "read", { all: true });
    return { updated: unread.length };
  }
}
