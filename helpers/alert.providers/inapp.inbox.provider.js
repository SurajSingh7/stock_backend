import mongoose from "mongoose";
import StockAlertInboxModel from "../../models/stock.alert.inbox.model.js";
import { pushToUser } from "../alert.inbox.hub.js";

/*
  In-App (the website bell). "Sending" = writing the user's inbox row and
  pushing it to any tab they have open. Delivered the moment it is written;
  READ arrives when the user opens it (StockAlertInboxService.markRead).
*/
const inappInboxProvider = {
  name: "inbox",

  status() {
    return { configured: true, connected: true, detail: "Website bell — built in" };
  },

  async send(message) {
    if (!mongoose.isValidObjectId(message.to?.address)) {
      throw Object.assign(new Error("This person is not linked to a login"), { permanent: true });
    }
    const row = await StockAlertInboxModel.create({
      userId: message.to.address,
      title: message.subject || String(message.body || "").split("\n")[0].slice(0, 120),
      body: message.body,
      link: message.link || "",
      eventKey: message.eventKey,
      recordType: message.recordType,
      recordRef: message.recordRef,
      recordId: message.recordId,
      messageId: message._id,
    });
    pushToUser(row.userId, "notification", {
      _id: row._id,
      title: row.title,
      body: row.body,
      link: row.link,
      recordRef: row.recordRef,
      createdAt: row.createdAt,
    });
    return { providerMessageId: String(row._id), status: "DELIVERED", deliveredAt: new Date() };
  },
};

export default inappInboxProvider;
