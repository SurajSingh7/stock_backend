import { createHttpClient, HttpError } from "../helpers/http.helper.js";
import { erpApiUrl } from "../config/env.config.js";
import { getLogger } from "../helpers/logger.helper.js";

const log = getLogger(import.meta.url);

/*
  The buyer entities (internal companies) a purchase order can be raised for.

  These live in the ERP, not here. The browser fetches the same list to build
  the dropdown — but a dropdown is not a check. Before this, addEntity stored
  whatever the client posted: name, GST number, address and stateCode included.
  Two of those are not cosmetic:

    stateCode decides the tax split — same state means CGST+SGST, different
      means IGST. A wrong code puts the wrong tax on the order.
    gstNumber and address are printed on the PO PDF that goes to the vendor.

  So the id is the only thing taken from the client; every field on the stored
  snapshot is read back from this list.

  Cached because the list is small (~24 rows), changes rarely, and is read on
  every entity assignment. The cache is also the fallback: if the ERP is
  briefly unreachable we keep working from the last good copy rather than
  blocking entity assignment across the company.
*/

const TTL_MS = 5 * 60 * 1000;
const PATH = "/config/internal/company/all?page=1&limit=1000&isActive=true";

let cache = { at: 0, byId: null };

const client = () => createHttpClient({ baseURL: erpApiUrl, timeout: 8000 });

// Field names verified against the live response, which is flat — name,
// address, state and stateCode are plain strings, not nested objects.
const normalise = (row) => ({
  entityId: String(row._id || ""),
  name: row.name || "",
  alias: row.alias || "",
  gstNumber: row.gstNumber || "",
  address: row.address || "",
  state: row.state || "",
  stateCode: String(row.stateCode || ""),
});

// The same two filters the dropdown applies. An entity nobody can pick is not
// one the server should accept either.
const isSelectable = (row) => row?._id && row.isActive !== false && row.isShownOnDropDown !== false;

async function load() {
  const fresh = cache.byId && Date.now() - cache.at < TTL_MS;
  if (fresh) return cache.byId;

  try {
    const json = await client().get(PATH);
    const rows = Array.isArray(json?.data) ? json.data : [];
    const byId = new Map(rows.filter(isSelectable).map((r) => [String(r._id), normalise(r)]));
    if (byId.size === 0) throw new HttpError("entity list came back empty", { url: PATH });
    cache = { at: Date.now(), byId };
    return byId;
  } catch (err) {
    if (cache.byId) {
      // Stale beats stuck: entity assignment is a daily operation and the list
      // barely changes, so a brief ERP outage should not stop the company.
      log.warn(`Internal entity list refresh failed (${err.message}) — using cached copy`);
      return cache.byId;
    }
    // Nothing cached and nothing fetched: refuse rather than accept whatever
    // the client sent, which is the hole this service exists to close.
    log.error(`Internal entity list unavailable: ${err.message}`);
    throw new Error("Entity list is unavailable right now — try again in a moment");
  }
}

export default class StockInternalEntityService {
  /*
    The trusted snapshot for an entity id, or null when the id is not a real,
    active internal company. Callers must treat null as a refusal.
  */
  static async resolve(entityId) {
    if (!entityId) return null;
    const byId = await load();
    return byId.get(String(entityId)) || null;
  }
}
