import emailSmtpProvider from "./email.smtp.provider.js";
import whatsappChatflowProvider from "./whatsapp.chatflow.provider.js";
import inappInboxProvider from "./inapp.inbox.provider.js";
import { ALERT_CHANNEL } from "../../constants/stock.enums.js";

/*
  Which provider carries each channel.

  The engine only ever says "send this WhatsApp message"; this file decides
  who does it. Switching WhatsApp from chatflow to Meta Cloud API or a BSP
  (Gupshup, Interakt, AiSensy …) is: add `whatsapp.<name>.provider.js` with
  the same shape, register it below, set ALERT_WHATSAPP_PROVIDER=<name>.
  Rules, templates and the log are untouched.

  A provider exposes:
    name                          stored on each log row
    status()                      { configured, detail } — no network
    health()          optional    live check for the Channels tab
    send(message)                 → { providerMessageId, status, … }
                                  throws; err.permanent = don't retry
    fetchStatus(id)   optional    → { status, deliveredAt, readAt, error }
    listGroups()      optional    WhatsApp groups for the group picker
*/
const REGISTRY = {
  [ALERT_CHANNEL.EMAIL]: { smtp: emailSmtpProvider },
  [ALERT_CHANNEL.WHATSAPP]: { chatflow: whatsappChatflowProvider },
  [ALERT_CHANNEL.IN_APP]: { inbox: inappInboxProvider },
};

const DEFAULTS = {
  [ALERT_CHANNEL.EMAIL]: "smtp",
  [ALERT_CHANNEL.WHATSAPP]: "chatflow",
  [ALERT_CHANNEL.IN_APP]: "inbox",
};

const configuredName = (channel) =>
  (process.env[`ALERT_${channel}_PROVIDER`] || "").trim().toLowerCase() || DEFAULTS[channel];

/** The provider for a channel, or null when that channel has none. */
export const getAlertProvider = (channel) => {
  const byName = REGISTRY[channel];
  if (!byName) return null;
  const provider = byName[configuredName(channel)];
  if (!provider) {
    throw new Error(
      `Unknown ${channel} provider "${configuredName(channel)}" in ALERT_${channel}_PROVIDER — known: ${Object.keys(byName).join(", ")}`
    );
  }
  return provider;
};
