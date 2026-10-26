import { createHttpClient } from "../http.helper.js";
import { peopleApiUrl, peopleApiKey } from "../../config/env.config.js";
import { ASSIGNEE_KIND, ITEM_REQUEST_CHANNEL } from "../../constants/stock.enums.js";

/*
  The real people API — one search over HRMS employees and website
  subscribers.

  Its URL and response format are not known yet. When they are, the only
  things that should need to change are the request in `search` and the
  mapping in `normalize`; everything above this file works on the
  normalised shape:

    { kind: EMPLOYEE|SUBSCRIBER, externalId, name, phone, email,
      employeeCode,                       (employees)
      orderId, username, serviceType,     (subscribers)
      extraFields: { label: value } }     (anything else worth showing)
*/

const client = () =>
  createHttpClient({
    headers: peopleApiKey ? { "x-api-key": peopleApiKey } : {},
    timeout: 8000,
  });

const str = (v) => (v === undefined || v === null ? "" : String(v).trim());

// One record from the API → the normalised shape. GUESSED until the real
// response is seen — adjust the field names here.
export const normalize = (raw) => {
  const type = str(raw.type || raw.kind || raw.userType).toUpperCase();
  const isEmployee = type.startsWith("EMP") || type === "HRMS" || !!raw.employeeCode;
  const known = new Set(["id", "_id", "type", "kind", "userType", "name", "fullName", "phone", "mobile", "email", "employeeCode", "empCode", "orderId", "username", "serviceType", "service"]);
  const extraFields = {};
  Object.entries(raw).forEach(([k, v]) => {
    if (!known.has(k) && v !== null && v !== undefined && typeof v !== "object") extraFields[k] = v;
  });
  return {
    kind: isEmployee ? ASSIGNEE_KIND.EMPLOYEE : ASSIGNEE_KIND.SUBSCRIBER,
    externalId: str(raw.id ?? raw._id),
    name: str(raw.name || raw.fullName || raw.username),
    phone: str(raw.phone || raw.mobile),
    email: str(raw.email),
    employeeCode: str(raw.employeeCode || raw.empCode),
    orderId: str(raw.orderId),
    username: str(raw.username),
    serviceType: str(raw.serviceType || raw.service),
    extraFields,
  };
};

const listOf = (data) => (Array.isArray(data) ? data : data?.data || data?.results || data?.items || []);

const httpPeopleProvider = {
  name: "http",
  isTest: false,
  channel: ITEM_REQUEST_CHANNEL.EXTERNAL_API,

  async search(q, { kind = null, limit = 20 } = {}) {
    const params = new URLSearchParams({ q: String(q).trim(), limit: String(limit) });
    if (kind) params.set("type", kind);
    const data = await client().get(`${peopleApiUrl}${peopleApiUrl.includes("?") ? "&" : "?"}${params}`);
    return listOf(data)
      .map(normalize)
      .filter((p) => (!kind || p.kind === kind) && p.externalId)
      .slice(0, limit);
  },

  // No "get one" endpoint is known yet, so look the id up by searching for it.
  async get(kind, externalId) {
    const rows = await httpPeopleProvider.search(externalId, { kind, limit: 50 });
    return rows.find((p) => p.externalId === String(externalId)) || null;
  },
};

export default httpPeopleProvider;
