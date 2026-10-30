import mongoose from "mongoose";
import { DEFAULT_AI_MODEL } from "../config/ai.models.js";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";

const { Schema } = mongoose;

/*
  Company-wide AI settings — one document (key "global"). The API key itself
  never lives here: it stays in the server's .env (ANTHROPIC_API_KEY).
*/
const aiSettingsSchema = new Schema(
  {
    key: { type: String, default: "global", unique: true },
    invoiceScan: {
      enabled: { type: Boolean, default: true },
      model: { type: String, trim: true, default: DEFAULT_AI_MODEL },
    },
  },
  { timestamps: true }
);

aiSettingsSchema.plugin(actorStampPlugin);

const StockAiSettingsModel = mongoose.model("ai_settings", aiSettingsSchema, "ai_settings");

export default StockAiSettingsModel;
