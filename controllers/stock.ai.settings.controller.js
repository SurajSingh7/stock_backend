import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockAiSettingsService from "../services/stock.ai.settings.service.js";

const log = getLogger(import.meta.url);

const handle = (label, fn) => async (req, res) => {
  try {
    successResponseHandler(res, await fn(req), `${label} successful`);
  } catch (error) {
    log.error(`Error: ${label}`, error);
    errorResponseHandler(res, error);
  }
};

export default class StockAiSettingsController {
  static get = handle("AI settings fetch", () => StockAiSettingsService.get());
  static update = handle("AI settings update", (req) => StockAiSettingsService.update(req.body, req.user));
  static test = handle("AI connection test", () => StockAiSettingsService.test());
  static usage = handle("AI usage fetch", () => StockAiSettingsService.usage());
}
