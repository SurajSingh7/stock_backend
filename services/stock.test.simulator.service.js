import mongoose from "mongoose";
import StockTestSimulatorSubscriberModel from "../models/stock.test.simulator.model.js";
import StockItemRequestService from "./stock.item.request.service.js";
import { AppError } from "../helpers/response.helper.js";
import { ITEM_REQUEST_CHANNEL } from "../constants/stock.enums.js";

/*
  🧪 TEST ONLY — Request Simulator.

  Plays the NOC / broadband website so the whole Item Request flow can be run
  end to end before the real site is connected: keep a few subscribers, raise
  requests for them, watch what the store issues, resend a rejected one.

  It calls StockItemRequestService exactly as the external API does — only the
  channel differs (TEST_SIMULATOR) — so nothing here is a second implementation
  that could drift from the real one.

  TO REMOVE once the real website is live:
    backend   models/stock.test.simulator.model.js
              services/stock.test.simulator.service.js
              controllers/stock.test.simulator.controller.js
              the "/test-simulator" block in routes/v1.stock.routes.js
              "test-simulator" in seeders/stock.module.seeder.js and
              config/data.scope.registry.js
    frontend  src/modules/test/requestSimulator, src/app/test/request-simulator,
              the "🧪 Test" entry in NavCategories.js
    data      collection test_simulator_subscribers, and item_requests /
              subscribers with channel TEST_SIMULATOR (units they issued stay
              ASSIGNED to those test subscribers — return them first)
*/

const CHANNEL = ITEM_REQUEST_CHANNEL.TEST_SIMULATOR;
export const TEST_SERVICE_TYPES = ["Broadband", "Fiber", "BPL"];
const text = (v, max = 200) => (v === undefined || v === null ? "" : String(v).trim().slice(0, max));
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// What the "website" sends about a subscriber with every request.
const snapshotOf = (s) => ({
  orderId: s.orderId,
  username: s.username,
  serviceType: s.serviceType,
  extraFields: {
    "Customer name": s.customerName,
    Mobile: s.mobile,
    Address: s.address,
    Plan: s.plan,
  },
});

export default class StockTestSimulatorService {
  static async listSubscribers({ search } = {}) {
    const filter = {};
    if (search) {
      const rx = { $regex: escapeRegex(String(search).trim()), $options: "i" };
      filter.$or = [{ orderId: rx }, { username: rx }, { customerName: rx }];
    }
    const subscribers = await StockTestSimulatorSubscriberModel.find(filter).sort({ createdAt: -1 }).limit(500).lean();
    const requests = await StockItemRequestService.listForRequester({ channel: CHANNEL });
    const byOrder = new Map();
    requests.forEach((r) => {
      const key = String(r.subscriber?.orderId || "").toUpperCase();
      if (!byOrder.has(key)) byOrder.set(key, []);
      byOrder.get(key).push(r);
    });
    return subscribers.map((s) => ({ ...s, requests: byOrder.get(s.orderIdKey) || [] }));
  }

  static async createSubscriber(body) {
    const orderId = text(body?.orderId, 100);
    const username = text(body?.username, 150);
    const serviceType = text(body?.serviceType, 60);
    if (!orderId) throw new AppError("Order ID is required", 400);
    if (!username) throw new AppError("Username is required", 400);
    if (!serviceType) throw new AppError("Service type is required", 400);
    if (await StockTestSimulatorSubscriberModel.exists({ orderIdKey: orderId.toUpperCase() }))
      throw new AppError(`Order ID ${orderId} already exists`, 409);
    const [doc] = await StockTestSimulatorSubscriberModel.create([
      {
        orderId,
        orderIdKey: orderId.toUpperCase(),
        username,
        serviceType,
        customerName: text(body.customerName),
        mobile: text(body.mobile, 20),
        address: text(body.address, 300),
        plan: text(body.plan, 100),
      },
    ]);
    return doc.toObject();
  }

  static async _subscriber(id, session = null) {
    if (!mongoose.isValidObjectId(id)) throw new Error("Test subscriber not found");
    const s = await StockTestSimulatorSubscriberModel.findById(id).session(session).lean();
    if (!s) throw new Error("Test subscriber not found");
    return s;
  }

  static async sendRequest(subscriberId, body, user, session) {
    const s = await StockTestSimulatorService._subscriber(subscriberId, session);
    return StockItemRequestService.createRequest(
      { ...body, subscriber: snapshotOf(s), requestedBy: { id: String(user?._id || ""), name: user?.name || "Test user" } },
      CHANNEL,
      session
    );
  }

  static withdrawRequest(requestId, body, user, session) {
    return StockItemRequestService.withdrawRequest(
      requestId,
      { reason: body?.reason, requestedBy: { id: String(user?._id || ""), name: user?.name || "Test user" } },
      CHANNEL,
      session
    );
  }

  static async resendRequest(requestId, body, user, session) {
    const current = await StockItemRequestService.getForRequester(requestId, CHANNEL);
    const s = await StockTestSimulatorSubscriberModel.findOne({ orderIdKey: String(current.subscriber.orderId).toUpperCase() })
      .session(session)
      .lean();
    return StockItemRequestService.resendRequest(
      requestId,
      {
        ...body,
        subscriber: s ? snapshotOf(s) : current.subscriber,
        requestedBy: { id: String(user?._id || ""), name: user?.name || "Test user" },
      },
      CHANNEL,
      session
    );
  }

  // What a test subscriber holds — for the Return / Replace pickers.
  static async holdings(subscriberId) {
    const s = await StockTestSimulatorService._subscriber(subscriberId);
    return StockItemRequestService.holdingsForRequester(CHANNEL, s.orderId);
  }

  static getRequest(requestId) {
    return StockItemRequestService.getForRequester(requestId, CHANNEL);
  }
}
