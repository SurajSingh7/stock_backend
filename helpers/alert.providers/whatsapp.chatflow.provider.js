import fs from "fs/promises";
import path from "path";

/*
  WhatsApp through chatflow (our own Baileys gateway, D:\@own\chatflow).

  .env:
    CHATFLOW_URL      e.g. http://localhost:5200   (the API lives under /v1)
    CHATFLOW_API_KEY  cf_live_…  — an API key made in chatflow → API Keys
    CHATFLOW_FROM     optional; our number (digits). Empty = the key's default

  chatflow takes a message into its own send queue and answers at once; it
  reaches WhatsApp later, at the number's pace. So a successful POST means
  "handed over" (SENDING here), and SENT / DELIVERED / READ arrive through
  fetchStatus(), which the sender polls.

  The message row's id goes up as `idempotencyKey`: if our call times out
  after chatflow already took the message, the retry gets the same message
  back instead of a second one.
*/
const env = (key) => (process.env[key] || "").trim();
const baseUrl = () => env("CHATFLOW_URL").replace(/\/+$/, "");
// chatflow matches the number exactly, country code included — a bare
// 10-digit Indian number in .env gets its 91 here.
const fromNumber = () => {
  const d = env("CHATFLOW_FROM").replace(/\D/g, "");
  return d.length === 10 ? `91${d}` : d;
};
const isConfigured = () => Boolean(baseUrl() && env("CHATFLOW_API_KEY"));

const STATUS_MAP = {
  queued: "SENDING",
  missed: "SENDING",
  sending: "SENDING",
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
  cancelled: "FAILED",
};

async function call(method, route, { json, form } = {}) {
  const headers = { Authorization: `Bearer ${env("CHATFLOW_API_KEY")}` };
  let body;
  if (json) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }
  let res;
  try {
    res = await fetch(`${baseUrl()}/v1${route}`, { method, headers, body, signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw new Error(`chatflow is not reachable (${err.cause?.code || err.name}) at ${baseUrl()}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `chatflow answered ${res.status}`;
    // 4xx = our request is wrong (number not on WhatsApp, group not allowed,
    // bad key) — retrying the same call cannot help. 429/5xx can.
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408;
    throw Object.assign(new Error(msg), { permanent, code: data?.error?.code });
  }
  return data;
}

const whatsappChatflowProvider = {
  name: "chatflow",

  status() {
    return isConfigured()
      ? { configured: true, detail: `chatflow at ${baseUrl()}` }
      : { configured: false, detail: "Set CHATFLOW_URL and CHATFLOW_API_KEY in .env" };
  },

  // Live check for the Channels tab: is our number connected?
  async health() {
    if (!isConfigured()) return { ...this.status(), connected: false };
    try {
      const { numbers = [] } = await call("GET", "/numbers");
      const from = fromNumber();
      if (!numbers.length) return { configured: true, connected: false, detail: "This API key has no WhatsApp number" };
      // A CHATFLOW_FROM the key can't use would fail every send — say so
      // instead of reporting the key's default number as connected.
      if (from && !numbers.some((n) => n.number === from)) {
        return {
          configured: true,
          connected: false,
          detail: `CHATFLOW_FROM ${from} is not a number of this API key (it has ${numbers.map((n) => n.number).join(", ")}). Fix CHATFLOW_FROM in .env or leave it empty.`,
        };
      }
      const number = (from && numbers.find((n) => n.number === from)) || numbers.find((n) => n.default) || numbers[0];
      return {
        configured: true,
        connected: !!number.connected,
        number: number.number,
        detail: number.connected ? `Connected · ${number.number}` : `Number ${number.number} is disconnected in chatflow`,
      };
    } catch (err) {
      return { configured: true, connected: false, detail: err.message };
    }
  },

  // WhatsApp groups this key may post to — for the group picker.
  async listGroups() {
    if (!isConfigured()) throw new Error("WhatsApp is not configured — set CHATFLOW_URL and CHATFLOW_API_KEY in .env");
    const query = fromNumber() ? `?from=${fromNumber()}` : "";
    const { groups = [] } = await call("GET", `/groups${query}`);
    return groups.map((g) => ({ id: g.id, name: g.name, from: g.from }));
  },

  async send(message) {
    if (!isConfigured()) {
      throw Object.assign(new Error("WhatsApp is not configured — set CHATFLOW_URL and CHATFLOW_API_KEY in .env"), {
        permanent: true,
      });
    }
    const fields = {
      to: message.to.address,
      text: message.body,
      idempotencyKey: String(message._id),
    };
    if (fromNumber()) fields.from = fromNumber();

    let data;
    const doc = (message.attachments || [])[0];
    if (doc?.path) {
      // A document (the PO PDF) goes as multipart, the text as its caption.
      const buffer = await fs.readFile(doc.path);
      const form = new FormData();
      Object.entries(fields).forEach(([k, v]) => form.append(k, v));
      form.append("type", "document");
      form.append("file", new Blob([buffer], { type: "application/pdf" }), doc.fileName || path.basename(doc.path));
      data = await call("POST", "/messages", { form });
    } else {
      data = await call("POST", "/messages", { json: fields });
    }
    return this.mapStatus(data);
  },

  async fetchStatus(providerMessageId) {
    const data = await call("GET", `/messages/${encodeURIComponent(providerMessageId)}`);
    return this.mapStatus(data);
  },

  mapStatus(data) {
    return {
      providerMessageId: data.id || "",
      status: STATUS_MAP[data.status] || "SENDING",
      sentAt: data.sentAt ? new Date(data.sentAt) : null,
      deliveredAt: data.deliveredAt ? new Date(data.deliveredAt) : null,
      readAt: data.readAt ? new Date(data.readAt) : null,
      error: data.error || null,
    };
  },
};

export default whatsappChatflowProvider;
