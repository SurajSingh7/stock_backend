import { internalApiKey } from "../config/env.config.js";

// Guards routes meant only for other trusted services to call (e.g. HRMS's
// admin UI fetching the warehouse list for its branch dropdown) — never
// meant to be hit by an end-user browser.
export function verifyInternalServiceKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!internalApiKey || key !== internalApiKey) {
    return res.status(401).json({ success: false, message: "Unauthorized caller" });
  }
  next();
}
