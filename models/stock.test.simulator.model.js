import mongoose from "mongoose";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";

const { Schema } = mongoose;

/*
  🧪 TEST ONLY — Request Simulator.

  Stands in for the NOC / broadband website's own subscriber table until the
  real site calls the external API. Nothing outside the simulator reads it.
  Remove together with the rest of the simulator (see the header of
  services/stock.test.simulator.service.js).
*/
const testSubscriberSchema = new Schema(
  {
    orderId: { type: String, trim: true, required: true },
    orderIdKey: { type: String, trim: true, uppercase: true, required: true },
    username: { type: String, trim: true, required: true },
    serviceType: { type: String, trim: true, required: true },
    // The "many other fields" a real subscriber row has.
    customerName: { type: String, trim: true, default: "" },
    mobile: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },
    plan: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

testSubscriberSchema.index({ orderIdKey: 1 }, { unique: true });

testSubscriberSchema.plugin(actorStampPlugin);

const StockTestSimulatorSubscriberModel = mongoose.model(
  "test_simulator_subscribers",
  testSubscriberSchema,
  "test_simulator_subscribers"
);

export default StockTestSimulatorSubscriberModel;
