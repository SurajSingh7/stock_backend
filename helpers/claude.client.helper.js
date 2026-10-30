import Anthropic from "@anthropic-ai/sdk";

/*
  The one Anthropic client. The key comes from the server's .env
  (ANTHROPIC_API_KEY) and is never sent to the browser or stored in the DB.
  Created on first use so a missing key fails the AI feature, not the boot.
*/
let client = null;

export const hasClaudeKey = () => !!String(process.env.ANTHROPIC_API_KEY || "").trim();

export const getClaudeClient = () => {
  if (!hasClaudeKey()) throw new Error("ANTHROPIC_API_KEY is not set in the server .env — AI scan is unavailable");
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY.trim(), timeout: 120_000, maxRetries: 2 });
  return client;
};

/** A plain sentence for the screen, from whatever the SDK threw. */
export const claudeErrorMessage = (err) => {
  if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key was rejected — check ANTHROPIC_API_KEY";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key is not allowed to use the selected model";
  if (err instanceof Anthropic.NotFoundError) return "The selected model was not found for this API key";
  if (err instanceof Anthropic.RateLimitError) return "Claude is rate-limited right now — try again in a minute";
  if (err instanceof Anthropic.BadRequestError) return `Claude could not process this request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach Claude — check the server's internet connection";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ""}: ${err.message}`.trim();
  return err?.message || "AI scan failed";
};
