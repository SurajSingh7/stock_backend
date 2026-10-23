import mongoose from "mongoose";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";

const { Schema } = mongoose;

/*
  Alerts & Escalations — the one settings document (key "global").

  Holds what an admin switches on the Channels tab. Provider credentials are
  NOT here: secrets stay in .env (see helpers/alert.providers/), the database
  only says whether a channel may send.
*/
const channelSwitchSchema = new Schema(
  { enabled: { type: Boolean, default: false } },
  { _id: false }
);

const settingsSchema = new Schema(
  {
    key: { type: String, default: "global", unique: true },

    // Master switches. OFF = nothing on that channel leaves, anywhere in the
    // app; such messages are logged SKIPPED and never sent later.
    channels: {
      EMAIL: { type: channelSwitchSchema, default: () => ({ enabled: true }) },
      WHATSAPP: { type: channelSwitchSchema, default: () => ({ enabled: true }) },
      IN_APP: { type: channelSwitchSchema, default: () => ({ enabled: true }) },
    },

    // While testing: every message goes to these addresses instead of the
    // real ones. The real address is kept on the log row (sandboxedFrom).
    sandbox: {
      enabled: { type: Boolean, default: true },
      email: { type: String, trim: true, lowercase: true, default: "" },
      phone: { type: String, trim: true, default: "" },
    },

    // Escalation steps that fall due outside these hours wait for the next
    // opening. Times are India time (Asia/Kolkata, no DST), "HH:MM".
    officeHours: {
      enabled: { type: Boolean, default: false },
      days: { type: [Number], default: [1, 2, 3, 4, 5, 6] }, // 0 = Sunday
      start: { type: String, default: "09:00" },
      end: { type: String, default: "19:00" },
    },

    // Morning summary: one WhatsApp per person listing everything still
    // pending for them. `lastSentOn` (India date, YYYY-MM-DD) is claimed
    // atomically so it goes out once a day even with two workers.
    digest: {
      enabled: { type: Boolean, default: false },
      time: { type: String, default: "10:00" },
      lastSentOn: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

settingsSchema.plugin(actorStampPlugin);

const StockAlertSettingsModel = mongoose.model("alert_settings", settingsSchema, "alert_settings");

export default StockAlertSettingsModel;
