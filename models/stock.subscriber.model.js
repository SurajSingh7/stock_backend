import mongoose from "mongoose";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";
import { ITEM_REQUEST_CHANNEL_ARRAY } from "../constants/stock.enums.js";

const { Schema } = mongoose;

/*
  subscribers — the customers items are issued to, as the requesting website
  describes them.

  That website owns the subscriber; this is only a registry of the ones that
  have asked for stock, refreshed from each request, so "what does ORD-101
  have" can be answered here without calling out. Order ID, username and
  service type are first-class; everything else the website sends lands in
  `extraFields` as it came — its columns change without this schema changing.

  Unique per channel, so the test simulator's ORD-101 and the real site's
  ORD-101 can never be mistaken for each other.
*/
const subscriberSchema = new Schema(
  {
    channel: { type: String, enum: ITEM_REQUEST_CHANNEL_ARRAY, required: true },
    orderId: { type: String, trim: true, required: true },
    // "ord-101 " and "ORD-101" are the same order.
    orderIdKey: { type: String, trim: true, uppercase: true, required: true },
    username: { type: String, trim: true, default: "" },
    // Broadband / Fiber / BPL … — whatever the website calls its services.
    serviceType: { type: String, trim: true, default: "" },
    extraFields: { type: Schema.Types.Mixed, default: {} },
    lastRequestAt: { type: Date, default: null },
  },
  { timestamps: true }
);

subscriberSchema.index({ channel: 1, orderIdKey: 1 }, { unique: true });
subscriberSchema.index({ username: 1 });

subscriberSchema.plugin(actorStampPlugin);

const StockSubscriberModel = mongoose.model("subscribers", subscriberSchema, "subscribers");

export default StockSubscriberModel;
