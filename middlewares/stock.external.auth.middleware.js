import crypto from "crypto";
import { externalApiKey } from "../config/env.config.js";

/*
  Guards the external API (routes/external.routes.js) — called by the NOC /
  broadband website's SERVER with an `x-api-key` header. Never from a browser:
  a key in front-end code is a key everybody has.

  Refuses everything while EXTERNAL_API_KEY is unset, so a deployment without
  the key configured is closed, not open. Compared in constant time.
*/
export function verifyExternalApiKey(req, res, next) {
  const sent = String(req.headers["x-api-key"] || "");
  const ok =
    !!externalApiKey &&
    sent.length === externalApiKey.length &&
    crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(externalApiKey));
  if (!ok) return res.status(401).json({ success: false, message: "Unauthorized caller" });
  next();
}
