import mongoose from "mongoose";
import StockDirectoryPersonModel from "../models/stock.directory.person.model.js";
import StockSubscriberModel from "../models/stock.subscriber.model.js";
import { getPeopleProvider } from "../helpers/people.providers/index.js";
import { getLogger } from "../helpers/logger.helper.js";
import { AppError } from "../helpers/response.helper.js";
import { ASSIGNEE_KIND, ASSIGNEE_KIND_ARRAY, PERSON_SOURCE } from "../constants/stock.enums.js";

/*
  People Directory — one search for "who has this stock": employees and
  subscribers, from the people API (see helpers/people.providers), plus anyone
  typed in by hand because the API does not have them yet.

  Picking someone from the API stores them here (`select`), so stock records
  point at a row that does not disappear when the API is slow, down, or
  forgets them. A hand-typed person is the same kind of row, source MANUAL.

  Not branch-scoped: a person is not anyone's branch's. The screens that use
  it (Opening Issued Stock, Employee Items) are guarded by their own module.
*/

const log = getLogger(import.meta.url);
const MIN_QUERY = 2;
const LIMIT = 20;
const text = (v, max = 200) => (v === undefined || v === null ? "" : String(v).trim().slice(0, max));
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const kindOf = (v, { required = false } = {}) => {
  const k = String(v || "").trim().toUpperCase();
  if (!k && !required) return null;
  if (!ASSIGNEE_KIND_ARRAY.includes(k)) throw new AppError("Choose Employee or Subscriber", 400);
  return k;
};

// The one identity a person has, however they arrived — see the model.
export const personKeyOf = ({ kind, employeeCode, orderId, channel }) =>
  kind === ASSIGNEE_KIND.EMPLOYEE
    ? `EMP:${String(employeeCode || "").trim().toUpperCase()}`
    : `SUB:${channel}:${String(orderId || "").trim().toUpperCase()}`;

const cleanExtra = (obj) => {
  const out = {};
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    Object.entries(obj)
      .slice(0, 30)
      .forEach(([k, v]) => {
        const key = text(k, 60);
        const val = typeof v === "number" || typeof v === "boolean" ? v : text(v, 300);
        if (key && val !== "") out[key] = val;
      });
  }
  return out;
};

// A provider record → a directory row's fields.
const fromProvider = (p, channel) => ({
  kind: p.kind,
  source: PERSON_SOURCE.EXTERNAL,
  externalId: text(p.externalId, 100),
  name: text(p.name, 150),
  phone: text(p.phone, 30),
  email: text(p.email, 150),
  employeeCode: p.kind === ASSIGNEE_KIND.EMPLOYEE ? text(p.employeeCode, 50) : "",
  channel: p.kind === ASSIGNEE_KIND.SUBSCRIBER ? channel : null,
  orderId: p.kind === ASSIGNEE_KIND.SUBSCRIBER ? text(p.orderId, 100) : "",
  username: p.kind === ASSIGNEE_KIND.SUBSCRIBER ? text(p.username, 150) : "",
  serviceType: p.kind === ASSIGNEE_KIND.SUBSCRIBER ? text(p.serviceType, 60) : "",
  extraFields: cleanExtra(p.extraFields),
});

// What a search result / picked person looks like to the screens.
const view = (row) => ({
  personId: row._id || null,
  key: row.key,
  kind: row.kind,
  source: row.source,
  externalId: row.externalId || "",
  name: row.name || "",
  phone: row.phone || "",
  email: row.email || "",
  employeeCode: row.employeeCode || "",
  channel: row.channel || null,
  orderId: row.orderId || "",
  username: row.username || "",
  serviceType: row.serviceType || "",
  extraFields: row.extraFields || {},
});

export default class StockPeopleDirectoryService {
  static providerInfo() {
    const p = getPeopleProvider();
    return { name: p.name, isTest: p.isTest };
  }

  /*
    One box: name, employee code, order ID, username, phone. The API's answers
    and the directory's own rows, merged by person — someone already picked
    keeps their directory id, with the API's fresher details on top.
  */
  static async search({ q, kind } = {}) {
    const query = text(q, 100);
    const k = kindOf(kind);
    const provider = StockPeopleDirectoryService.providerInfo();
    if (query.length < MIN_QUERY) return { results: [], provider, warning: "" };

    const rx = { $regex: escapeRegex(query), $options: "i" };
    const local = await StockDirectoryPersonModel.find({
      isActive: true,
      ...(k ? { kind: k } : {}),
      $or: [{ name: rx }, { employeeCode: rx }, { orderId: rx }, { username: rx }, { phone: rx }],
    })
      .sort({ name: 1 })
      .limit(LIMIT)
      .lean();

    let external = [];
    let warning = "";
    const source = getPeopleProvider();
    try {
      external = await source.search(query, { kind: k, limit: LIMIT });
    } catch (err) {
      log.error("People API search failed", err);
      warning = "The people list could not be searched right now — showing only people already in the directory.";
    }

    const byKey = new Map(local.map((r) => [r.key, view(r)]));
    for (const p of external) {
      const row = fromProvider(p, source.channel);
      if (row.kind === ASSIGNEE_KIND.EMPLOYEE ? !row.employeeCode : !row.orderId) continue; // unusable record
      const key = personKeyOf(row);
      const known = byKey.get(key);
      byKey.set(key, { ...view({ ...row, key }), personId: known?.personId || null, source: known?.source || row.source });
    }
    return { results: [...byKey.values()].slice(0, LIMIT * 2), provider, warning };
  }

  /*
    The person the screen picked. A directory row is used as it is; an API
    result is fetched again from the API (never trusted from the browser) and
    stored, or refreshed if they were picked before.
    body: { personId } | { kind, externalId }
  */
  static async select(body) {
    if (body?.personId) return view(await StockPeopleDirectoryService.getActive(body.personId));

    const kind = kindOf(body?.kind, { required: true });
    const externalId = text(body?.externalId, 100);
    if (!externalId) throw new AppError("Choose a person from the search", 400);
    const source = getPeopleProvider();
    let found;
    try {
      found = await source.get(kind, externalId);
    } catch (err) {
      log.error("People API lookup failed", err);
      throw new AppError("The people list could not be reached — try again, or add the person by hand", 502);
    }
    if (!found) throw new AppError("That person is no longer in the people list — search again", 404);

    const row = fromProvider({ ...found, kind }, source.channel);
    const key = personKeyOf(row);
    const person = await StockDirectoryPersonModel.findOneAndUpdate(
      { key },
      // A hand-typed row the API now knows becomes the API's.
      { $set: { ...row, isActive: true }, $setOnInsert: { key } },
      { new: true, upsert: true }
    ).lean();
    return view(person);
  }

  /*
    Someone the API does not have. Employee: name + employee code. Subscriber:
    order ID + name or username + service type. The rest is optional.
  */
  static async createManual(body) {
    const kind = kindOf(body?.kind, { required: true });
    const source = getPeopleProvider();
    const row = {
      kind,
      source: PERSON_SOURCE.MANUAL,
      name: text(body.name, 150),
      phone: text(body.phone, 30),
      email: text(body.email, 150),
      extraFields: cleanExtra(body.extraFields),
    };
    if (kind === ASSIGNEE_KIND.EMPLOYEE) {
      row.employeeCode = text(body.employeeCode, 50);
      if (!row.name) throw new AppError("Name is required", 400);
      if (!row.employeeCode) throw new AppError("Employee code is required", 400);
    } else {
      row.channel = source.channel;
      row.orderId = text(body.orderId, 100);
      row.username = text(body.username, 150);
      row.serviceType = text(body.serviceType, 60);
      if (!row.orderId) throw new AppError("Order ID is required", 400);
      if (!row.name && !row.username) throw new AppError("Name or username is required", 400);
      if (!row.serviceType) throw new AppError("Service type is required", 400);
      if (!row.name) row.name = row.username;
    }
    row.key = personKeyOf(row);
    const label = kind === ASSIGNEE_KIND.EMPLOYEE ? `Employee code ${row.employeeCode}` : `Order ID ${row.orderId}`;

    const existing = await StockDirectoryPersonModel.findOne({ key: row.key }).lean();
    if (existing) throw new AppError(`${label} is already in the directory (${existing.name}) — pick them from the search`, 409);
    // Typing in someone the API already has would split them in two.
    try {
      const hits = await source.search(kind === ASSIGNEE_KIND.EMPLOYEE ? row.employeeCode : row.orderId, { kind, limit: LIMIT });
      const same = hits.find((p) => personKeyOf(fromProvider(p, source.channel)) === row.key);
      if (same) throw new AppError(`${label} is in the people list (${same.name}) — pick them from the search`, 409);
    } catch (err) {
      if (err instanceof AppError) throw err;
      log.error("People API check before manual add failed", err); // the API being down must not block this
    }

    const [person] = await StockDirectoryPersonModel.create([row]);
    return view(person.toObject());
  }

  static async getActive(id, session = null) {
    if (!mongoose.isValidObjectId(id)) throw new AppError("Choose who has these items", 400);
    const person = await StockDirectoryPersonModel.findOne({ _id: id, isActive: true }).session(session).lean();
    if (!person) throw new AppError("That person is no longer in the directory — choose them again", 400);
    return person;
  }

  // The snapshot an entry keeps of its person (Opening Issued Stock).
  static snapshotOf(person) {
    return {
      personId: person._id,
      kind: person.kind,
      name: person.name || "",
      employeeCode: person.employeeCode || "",
      orderId: person.orderId || "",
      username: person.username || "",
      serviceType: person.serviceType || "",
      phone: person.phone || "",
      email: person.email || "",
    };
  }

  /*
    A subscriber's row in the stock-side subscriber registry, created if this
    is the first stock against them — the website asks "what does ORD-101
    hold" through that registry. Details already there came from the website
    itself and are kept.
  */
  static async ensureSubscriber(person, session) {
    if (person.kind !== ASSIGNEE_KIND.SUBSCRIBER) return null;
    const orderIdKey = person.orderId.trim().toUpperCase();
    const subscriber = await StockSubscriberModel.findOneAndUpdate(
      { channel: person.channel, orderIdKey },
      {
        $setOnInsert: {
          channel: person.channel,
          orderIdKey,
          orderId: person.orderId,
          username: person.username || person.name,
          serviceType: person.serviceType,
          extraFields: { ...(person.name && person.name !== person.username ? { Name: person.name } : {}), ...(person.phone ? { Mobile: person.phone } : {}) },
        },
      },
      { new: true, upsert: true, session }
    ).lean();
    if (String(person.subscriberId || "") !== String(subscriber._id))
      await StockDirectoryPersonModel.updateOne({ _id: person._id }, { $set: { subscriberId: subscriber._id } }, { session });
    return subscriber;
  }

  // `assignedTo` for a unit that is with this person.
  static assigneeOf(person, { subscriberId = null, assignedAt, note = "" }) {
    const base = { kind: person.kind, personId: person._id, phone: person.phone || "", note, assignedAt };
    return person.kind === ASSIGNEE_KIND.EMPLOYEE
      ? { ...base, employeeName: person.name, employeeCode: person.employeeCode }
      : { ...base, subscriberId, orderId: person.orderId, username: person.username || person.name, serviceType: person.serviceType };
  }
}
