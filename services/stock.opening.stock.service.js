import mongoose from "mongoose";
import StockOpeningStockModel from "../models/stock.opening.stock.model.js";
import StockProductDefinitionModel from "../models/stock.product.definition.model.js";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import StockVendorModel from "../models/stock.vendor.model.js";
import StockCategoryModel from "../models/stock.category.model.js";
import StockCategoryService from "./stock.category.service.js";
import StockBranchService from "./stock.branch.service.js";
import StockItemIdentityService from "./stock.item.identity.service.js";
import StockItemMovementService from "./stock.item.movement.service.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import StockPeopleDirectoryService from "./stock.people.directory.service.js";
import { actorSnapshot } from "../models/plugins/actor.stamp.plugin.js";
import { nextDocumentNumber } from "../helpers/document.number.helper.js";
import { applyDataScope, isWithinDataScope } from "../helpers/data.scope.helper.js";
import { AppError } from "../helpers/response.helper.js";
import { warrantyEndDate, isValidWarrantyMonths, WARRANTY_MONTHS_MAX } from "../helpers/stock.warranty.helper.js";
import { buildOpeningStockTemplate, readOpeningStockSheet } from "../helpers/stock.opening.stock.excel.helper.js";
import {
  TRACKING_METHODS,
  ITEM_STATUS,
  ITEM_APPROVAL_STATUS,
  ITEM_SOURCE,
  ITEM_CONDITION,
  ITEM_CONDITION_ARRAY,
  ITEM_MOVEMENT_REF,
  ITEM_MOVEMENT_TYPE,
  ASSIGNEE_KIND,
  OPENING_STOCK_STATUS,
  OPENING_STOCK_STATE,
  OPENING_STOCK_KIND,
} from "../constants/stock.enums.js";

/*
  Opening Stock Entry — getting the stock that was already on hand into the
  system, with whatever is known about it.

  Two kinds of problem, handled differently on purpose:

    Malformed input (a date that is not a date, an unknown product, a negative
    cost) is refused outright — there is nothing sensible to store.

    Incomplete input (no serial yet, a serial already in stock, warranty given
    twice) is SAVED, and comes back as `issues` on the draft. Typing 300 rows
    and losing them because row 212 repeats a serial would be the worst
    possible behaviour; the draft keeps the work, shows exactly which rows need
    attention, and Post refuses until there are none.

  Posting is the only step that touches stock: one inventory item per line,
  stamped OPENING_STOCK, plus its first timeline row.

  Two kinds of entry share all of this (see OPENING_STOCK_KIND), each its own
  screen and module:
    STORE   Opening Stock — in the store; Working / Faulty / Beyond Repair
    ISSUED  Opening Issued Stock — already with ONE person from the People
            Directory; every line is a working, used unit, and posting makes
            it ASSIGNED to them as if it had been issued here
*/

const ENTITY_TYPE = "opening-stock";
const TEXT_MAX = 300;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const KIND = {
  [OPENING_STOCK_KIND.STORE]: { moduleKey: "opening-stock", prefix: "OS" },
  [OPENING_STOCK_KIND.ISSUED]: { moduleKey: "opening-issued-stock", prefix: "OI" },
};
const kindOf = (kind) => (kind === OPENING_STOCK_KIND.ISSUED ? OPENING_STOCK_KIND.ISSUED : OPENING_STOCK_KIND.STORE);
const isIssued = (entry) => entry.kind === OPENING_STOCK_KIND.ISSUED;
// Entries from before ISSUED existed have no `kind` and are STORE.
const kindFilter = (kind) => (kind === OPENING_STOCK_KIND.ISSUED ? OPENING_STOCK_KIND.ISSUED : { $ne: OPENING_STOCK_KIND.ISSUED });

// Wrong kind is "not found" too — an issued entry is not reachable through
// the Opening Stock screen's module, and the other way round.
const assertDataScope = (entry, dataAccess, kind) => {
  if (kindOf(entry.kind) !== kind || !isWithinDataScope(entry, dataAccess, KIND[kind].moduleKey))
    throw new Error("Opening stock entry not found");
};

const who = (p) =>
  p.kind === ASSIGNEE_KIND.EMPLOYEE
    ? `${p.name}${p.employeeCode ? ` (${p.employeeCode})` : ""}`
    : `${p.orderId}${p.username || p.name ? ` · ${p.username || p.name}` : ""}`;

/* ── Coercion ─────────────────────────────────────────────────────────────── */

// Dates arrive as "YYYY-MM-DD" from the form, Date objects or "DD-MM-YYYY"
// from Excel. All become UTC midnight. Old stock can be old, so only an
// impossible year is refused — not a merely distant one.
const utcDate = (y, m, d, label) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  // 31-02-2024 would otherwise quietly become 2 March.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
    throw new AppError(`${label} is not a valid date`, 400);
  return date;
};

const toDate = (v, label) => {
  if (v === undefined || v === null || v === "") return null;
  let d;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new AppError(`${label} is not a valid date`, 400);
    d = new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  } else {
    const s = String(v).trim();
    let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(T.*)?$/))) d = utcDate(+m[1], +m[2], +m[3], label);
    else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) d = utcDate(+m[3], +m[2], +m[1], label);
    else throw new AppError(`${label} is not a valid date (use DD-MM-YYYY)`, 400);
  }
  const year = d.getUTCFullYear();
  if (year < 1990 || year > new Date().getUTCFullYear() + 15) throw new AppError(`${label} looks wrong — check the year`, 400);
  return d;
};

const toNumber = (v, label, { integer = false, positive = false } = {}) => {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  if (!Number.isFinite(n) || n < 0 || (positive && n === 0)) throw new AppError(`${label} must be a ${positive ? "positive" : "non-negative"} number`, 400);
  if (integer && !Number.isInteger(n)) throw new AppError(`${label} must be a whole number`, 400);
  return n;
};

const toText = (v, max = TEXT_MAX) => (v === undefined || v === null ? "" : String(v).trim().slice(0, max));

// "Faulty (Repairable)", "beyond repair", "BEYOND_REPAIR" … → the enum value.
// Blank means WORKING; anything else unrecognised is refused.
const toWorkingState = (v) => {
  const s = String(v ?? "").trim().toUpperCase().replace(/[^A-Z]+/g, "_").replace(/^_|_$/g, "");
  if (!s || s === "WORKING") return OPENING_STOCK_STATE.WORKING;
  if (s.startsWith("FAULTY")) return OPENING_STOCK_STATE.FAULTY;
  if (s.startsWith("BEYOND") || s === "DEAD" || s === "BER") return OPENING_STOCK_STATE.BEYOND_REPAIR;
  throw new AppError(`Working state "${v}" is not valid — use Working, Faulty (Repairable) or Beyond Repair (Dead)`, 400);
};

// What a posted line becomes.
const postedStatus = (line) => {
  if (line.workingState === OPENING_STOCK_STATE.FAULTY) return ITEM_STATUS.FAULTY;
  if (line.workingState === OPENING_STOCK_STATE.BEYOND_REPAIR) return ITEM_STATUS.SCRAPPED;
  return ITEM_STATUS.AVAILABLE;
};

const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// A product field value, typed by the field's input type. Excel hands numbers
// back as numbers even in a Text column now and then; text fields keep them as
// text so "00123" style serials stay what was typed.
const coerceFieldValue = (field, raw, where) => {
  if (raw === undefined || raw === null || raw === "") return undefined;
  switch (field.inputType) {
    case "number":
    case "decimal": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) throw new AppError(`${where}${field.label} must be a number`, 400);
      return n;
    }
    case "boolean": {
      const s = String(raw).trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(s) || raw === true) return true;
      if (["false", "no", "n", "0"].includes(s) || raw === false) return false;
      throw new AppError(`${where}${field.label} must be yes or no`, 400);
    }
    case "date":
    case "datetime":
      return ymd(toDate(raw, `${where}${field.label}`));
    default:
      return raw instanceof Date ? ymd(raw) : String(raw).trim();
  }
};

/* ── Products ─────────────────────────────────────────────────────────────── */

// The fields a line of this product carries, in the product's order, each
// with whether it is required and whether it is a unique identifier.
const fieldsOf = (def) =>
  [...(def.selectedFields || [])]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .filter((sf) => sf.fieldDefId && sf.fieldDefId.isActive !== false)
    .map((sf) => ({
      code: sf.fieldDefId.code,
      label: sf.fieldDefId.label,
      inputType: sf.fieldDefId.inputType,
      optionsSource: sf.fieldDefId.optionsSource || null,
      required: !!sf.isRequired,
      isUnique: !!sf.fieldDefId.isUnique && def.trackingMethod === TRACKING_METHODS.INDIVIDUAL,
    }));

const loadProducts = async (ids, session = null) => {
  const valid = [...new Set(ids.map(String))].filter((id) => mongoose.isValidObjectId(id));
  const defs = await StockProductDefinitionModel.find({ _id: { $in: valid }, isActive: true })
    .populate({ path: "selectedFields.fieldDefId", select: "code label inputType optionsSource isUnique isActive" })
    .session(session)
    .lean();
  return new Map(defs.map((d) => [String(d._id), { def: d, fields: fieldsOf(d) }]));
};

const loadVendors = async (ids, session = null) => {
  const valid = [...new Set(ids.filter(Boolean).map(String))].filter((id) => mongoose.isValidObjectId(id));
  if (!valid.length) return new Map();
  const vendors = await StockVendorModel.find({ _id: { $in: valid }, isActive: true }).select("name").session(session).lean();
  return new Map(vendors.map((v) => [String(v._id), v]));
};

export default class StockOpeningStockService {
  /* ---------------------------------------------------------------------- */
  /* Building lines                                                         */
  /* ---------------------------------------------------------------------- */

  // One input line → the stored shape. Throws only on MALFORMED input.
  // `issued`: an Opening Issued Stock line — someone is using it, so it is a
  // working, used unit whatever was sent.
  static _buildLine(input, { products, vendors }, where, { issued = false } = {}) {
    const product = products.get(String(input?.productDefinitionId || ""));
    if (!product) throw new AppError(`${where}product not found`, 400);
    const { def, fields } = product;
    const isQuantity = def.trackingMethod === TRACKING_METHODS.QUANTITY;

    // Only this product's own fields are kept — a stray key from another
    // product's form must not ride along onto the unit.
    const fieldValues = {};
    for (const f of fields) {
      const v = coerceFieldValue(f, input.fieldValues?.[f.code], where);
      if (v !== undefined) fieldValues[f.code] = v;
    }

    let vendorId = null;
    let vendorName = "";
    if (input.vendorId) {
      const vendor = vendors.get(String(input.vendorId));
      if (!vendor) throw new AppError(`${where}vendor not found`, 400);
      vendorId = vendor._id;
      vendorName = vendor.name;
    }

    const warrantyMonths = toNumber(input.warrantyMonths, `${where}Warranty months`, { integer: true });
    if (warrantyMonths !== null && !isValidWarrantyMonths(warrantyMonths))
      throw new AppError(`${where}Warranty months must be between 1 and ${WARRANTY_MONTHS_MAX}`, 400);

    const condition =
      !issued && ITEM_CONDITION_ARRAY.includes(String(input.condition || "").toUpperCase())
        ? String(input.condition).toUpperCase()
        : ITEM_CONDITION.USED;
    const workingState = issued ? OPENING_STOCK_STATE.WORKING : toWorkingState(input.workingState);

    return {
      ...(input._id && mongoose.isValidObjectId(input._id) ? { _id: input._id } : {}),
      productDefinitionId: def._id,
      productName: def.name,
      trackingMethod: def.trackingMethod,
      unit: def.unit || null,
      fieldValues,
      quantity: isQuantity ? toNumber(input.quantity, `${where}Quantity`, { positive: true }) : null,
      vendorId,
      vendorName,
      purchaseDate: toDate(input.purchaseDate, `${where}Purchase date`),
      purchaseCost: toNumber(input.purchaseCost, `${where}Purchase cost`),
      warrantyMonths,
      warrantyEndDate: toDate(input.warrantyEndDate, `${where}Warranty end date`),
      condition,
      workingState,
      faultNote: workingState === OPENING_STOCK_STATE.WORKING ? "" : toText(input.faultNote, 500),
    };
  }

  static async _buildLines(inputs, session, kind = OPENING_STOCK_KIND.STORE) {
    const products = await loadProducts(inputs.map((l) => l?.productDefinitionId), session);
    const vendors = await loadVendors(inputs.map((l) => l?.vendorId), session);
    const issued = kind === OPENING_STOCK_KIND.ISSUED;
    return inputs.map((l, i) => StockOpeningStockService._buildLine(l, { products, vendors }, `Line ${i + 1}: `, { issued }));
  }

  /*
    ISSUED only — who the entry's stock is with, and since when. The person is
    looked up in the directory, never taken from the request.
  */
  static async _issuedFields(body, entryDate, session) {
    const out = {};
    if (body.personId !== undefined) {
      const person = await StockPeopleDirectoryService.getActive(body.personId, session);
      out.issuedTo = StockPeopleDirectoryService.snapshotOf(person);
    }
    if (body.issuedSince !== undefined) {
      const since = toDate(body.issuedSince, "Issued since");
      if (since && entryDate && since > entryDate) throw new AppError("Issued since can't be after the entry date", 400);
      out.issuedSince = since;
    }
    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* Issues — what still has to be fixed before the entry can be posted     */
  /* ---------------------------------------------------------------------- */

  /**
   * @returns [{ index, messages: [string] }] — only lines that have any.
   */
  static async _issues(lines, session = null) {
    const products = await loadProducts(lines.map((l) => l.productDefinitionId), session);
    const messages = lines.map(() => []);
    const keysByLine = lines.map(() => []);

    lines.forEach((line, i) => {
      const product = products.get(String(line.productDefinitionId));
      if (!product) {
        messages[i].push("Product is no longer active");
        return;
      }
      const { fields } = product;
      for (const f of fields) {
        const v = line.fieldValues?.[f.code];
        if (f.required && (v === undefined || v === null || v === "")) messages[i].push(`${f.label} is required`);
      }
      if (line.trackingMethod === TRACKING_METHODS.QUANTITY && !(line.quantity > 0)) messages[i].push("Quantity is required");

      const uniqueFields = fields.filter((f) => f.isUnique);
      if (uniqueFields.length) {
        const keys = StockItemIdentityService.identifiersOf(line.fieldValues, uniqueFields);
        if (!keys.length) messages[i].push(`${uniqueFields.map((f) => f.label).join(" or ")} is required`);
        keysByLine[i] = keys;
      }

      if (line.warrantyMonths && line.warrantyEndDate) messages[i].push("Give warranty months OR an end date, not both");
      if (line.warrantyMonths && !line.purchaseDate) messages[i].push("Purchase date is needed to count warranty months");

      const working = !line.workingState || line.workingState === OPENING_STOCK_STATE.WORKING;
      if (!working && !line.faultNote) messages[i].push("Describe the fault");
    });

    // Repeated inside this entry.
    const labelByCode = await StockItemIdentityService.labelByCode(session);
    const firstLineOf = new Map();
    keysByLine.forEach((keys, i) =>
      keys.forEach((k) => {
        if (firstLineOf.has(k)) {
          const [code, value] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
          messages[i].push(`${labelByCode.get(code) || code} "${value}" is also on line ${firstLineOf.get(k) + 1}`);
        } else firstLineOf.set(k, i);
      })
    );

    // Already in stock.
    const allKeys = [...firstLineOf.keys()];
    if (allKeys.length) {
      const clashes = await StockInventoryItemModel.find({ identifiers: { $in: allKeys } })
        .select("identifiers branchId")
        .populate({ path: "branchId", select: "name" })
        .session(session)
        .lean();
      const whereByKey = new Map();
      clashes.forEach((it) => (it.identifiers || []).forEach((k) => whereByKey.set(k, it.branchId?.name || "")));
      keysByLine.forEach((keys, i) =>
        keys.forEach((k) => {
          if (!whereByKey.has(k)) return;
          const [code, value] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
          const at = whereByKey.get(k);
          messages[i].push(`${labelByCode.get(code) || code} "${value}" already exists in stock${at ? ` (${at})` : ""}`);
        })
      );
    }

    return messages.map((m, index) => ({ index, messages: m })).filter((r) => r.messages.length);
  }

  static async _withIssues(entry, session = null) {
    const plain = typeof entry.toObject === "function" ? entry.toObject() : entry;
    const issues = plain.status === OPENING_STOCK_STATUS.DRAFT ? await StockOpeningStockService._issues(plain.lines, session) : [];
    return { ...plain, issues };
  }

  /* ---------------------------------------------------------------------- */
  /* Form bootstrap                                                         */
  /* ---------------------------------------------------------------------- */

  // Branches the caller may enter stock for, and every active vendor — old
  // stock may have been bought from any of them. Served on this module so the
  // screen does not need Master > Branch or Vendor permissions.
  static async getFormOptions(dataAccess) {
    const { branches, defaultBranchId } = await StockBranchService.getScopedBranchPicker(dataAccess);
    const vendors = await StockVendorModel.find({ isActive: true }).select("name vendorCode").sort({ name: 1 }).lean();
    return {
      branches: branches.map((b) => ({ _id: b._id, name: b.name, code: b.code })),
      defaultBranchId,
      vendors: vendors.map((v) => ({ _id: v._id, name: v.name, vendorCode: v.vendorCode || "" })),
    };
  }

  // The product picker: name search, each with the fields its lines need.
  static async searchProducts({ search = "", productIds = [] } = {}) {
    const filter = { isActive: true };
    if (productIds.length) filter._id = { $in: productIds.filter((id) => mongoose.isValidObjectId(id)) };
    else if (search) filter.name = { $regex: escapeRegex(search), $options: "i" };
    const defs = await StockProductDefinitionModel.find(filter)
      .populate({ path: "selectedFields.fieldDefId", select: "code label inputType optionsSource isUnique isActive" })
      .sort({ name: 1 })
      .limit(productIds.length ? productIds.length : 50)
      .lean();

    const categories = await StockCategoryModel.find({ _id: { $in: defs.map((d) => d.categoryId) } }).select("path").lean();
    const pathById = new Map(categories.map((c) => [String(c._id), c.path]));
    const display = new Map();
    const out = [];
    for (const d of defs) {
      const key = String(d.categoryId);
      if (!display.has(key)) display.set(key, pathById.get(key) ? await StockCategoryService.buildDisplayPath(pathById.get(key)) : "");
      out.push({
        _id: d._id,
        name: d.name,
        trackingMethod: d.trackingMethod,
        unit: d.unit,
        warrantyMonths: d.warrantyMonths ?? null,
        categoryPath: display.get(key),
        fields: fieldsOf(d),
      });
    }
    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* CRUD                                                                   */
  /* ---------------------------------------------------------------------- */

  // counts: entries per status under the other filters, for the status chips.
  static async list({ skip, limit, status, branchId, search, from, to, kind }, dataAccess) {
    const k = kindOf(kind);
    const base = { isActive: true, kind: kindFilter(k) };
    if (branchId && mongoose.isValidObjectId(branchId)) base.branchId = new mongoose.Types.ObjectId(branchId);
    if (from || to) {
      base.entryDate = {};
      if (from) base.entryDate.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23, 59, 59, 999); base.entryDate.$lte = d; }
    }
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: "i" };
      base.$or =
        k === OPENING_STOCK_KIND.ISSUED
          ? [{ entryNumber: rx }, { "issuedTo.name": rx }, { "issuedTo.employeeCode": rx }, { "issuedTo.orderId": rx }, { "issuedTo.username": rx }]
          : [{ entryNumber: rx }];
    }
    // applyDataScope casts its own ids, so base is safe in $match below.
    applyDataScope(base, dataAccess, KIND[k].moduleKey);
    const filter = status && Object.values(OPENING_STOCK_STATUS).includes(status) ? { ...base, status } : base;

    const [rows, total, byStatus] = await Promise.all([
      StockOpeningStockModel.find(filter)
        .select("entryNumber kind branchId entryDate remarks status issuedTo issuedSince postedAt postedBy createdBy createdAt lines.productDefinitionId lines.productName lines.unit lines.quantity lines.trackingMethod lines.workingState")
        .populate({ path: "branchId", select: "name code" })
        // The branch each person belonged to, for the Created By / Posted By details.
        .populate({ path: "createdBy.branchId", model: "branches", select: "name" })
        .populate({ path: "postedBy.branchId", model: "branches", select: "name" })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StockOpeningStockModel.countDocuments(filter),
      StockOpeningStockModel.aggregate([{ $match: base }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    const counts = Object.fromEntries([["ALL", 0], ...Object.values(OPENING_STOCK_STATUS).map((st) => [st, 0])]);
    byStatus.forEach((c) => { counts[c._id] = c.n; counts.ALL += c.n; });

    /*
      What each entry holds, without its lines:
        products   one row per product — a unit line counts 1, a batch its quantity
        quantity   the same summed per unit of measure (pieces and metres never added)
        condition  lines that are working / faulty / beyond repair (store entries)
    */
    const amount = (l) => (l.trackingMethod === TRACKING_METHODS.INDIVIDUAL ? 1 : Number(l.quantity) || 0);
    const data = rows.map(({ lines = [], ...r }) => {
      const byProduct = new Map();
      const byUnit = new Map();
      for (const l of lines) {
        const key = String(l.productDefinitionId);
        const p = byProduct.get(key) || { productDefinitionId: l.productDefinitionId, name: l.productName, unit: l.unit || null, quantity: 0 };
        p.quantity = round3(p.quantity + amount(l));
        byProduct.set(key, p);
        const u = l.unit || "pieces";
        byUnit.set(u, round3((byUnit.get(u) || 0) + amount(l)));
      }
      const state = (st) => lines.filter((l) => (l.workingState || OPENING_STOCK_STATE.WORKING) === st).length;
      return {
        ...r,
        products: [...byProduct.values()].sort((a, b) => a.name.localeCompare(b.name)),
        quantity: [...byUnit.entries()].map(([unit, qty]) => ({ unit, quantity: qty })),
        condition: {
          working: state(OPENING_STOCK_STATE.WORKING),
          faulty: state(OPENING_STOCK_STATE.FAULTY),
          beyondRepair: state(OPENING_STOCK_STATE.BEYOND_REPAIR),
        },
      };
    });
    return { data, total, counts };
  }

  static async getById(id, kind, dataAccess) {
    const entry = await StockOpeningStockModel.findOne({ _id: id, isActive: true })
      .populate({ path: "branchId", select: "name code" })
      .lean();
    if (!entry) throw new Error("Opening stock entry not found");
    assertDataScope({ ...entry, branchId: entry.branchId?._id }, dataAccess, kindOf(kind));
    return StockOpeningStockService._withIssues(entry);
  }

  static async create(body, kind, user, session, dataAccess) {
    const k = kindOf(kind);
    const branchId = await StockBranchService.assertBranchInScope(body.branchId, dataAccess, session);
    const lines = await StockOpeningStockService._buildLines(body.lines || [], session, k);
    const entryDate = toDate(body.entryDate, "Entry date") || toDate(new Date(), "Entry date");
    let issued = {};
    if (k === OPENING_STOCK_KIND.ISSUED) {
      if (!body.personId) throw new AppError("Choose who has these items", 400);
      issued = await StockOpeningStockService._issuedFields(body, entryDate, session);
    }
    const entryNumber = await nextDocumentNumber({ model: StockOpeningStockModel, field: "entryNumber", prefix: KIND[k].prefix, session });

    const [entry] = await StockOpeningStockModel.create(
      [
        {
          entryNumber,
          kind: k,
          branchId,
          entryDate,
          remarks: toText(body.remarks),
          ...issued,
          lines,
        },
      ],
      { session }
    );
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: entry._id, action: "CREATE", actor: user, before: null, after: entry.toObject(),
    });
    return StockOpeningStockService._withIssues(entry, session);
  }

  static async _loadDraft(id, kind, session, dataAccess) {
    const entry = await StockOpeningStockModel.findOne({ _id: id, isActive: true }).session(session);
    if (!entry) throw new Error("Opening stock entry not found");
    assertDataScope(entry, dataAccess, kindOf(kind));
    if (entry.status !== OPENING_STOCK_STATUS.DRAFT) throw new AppError("Only a draft entry can be changed — this one is already posted", 400);
    return entry;
  }

  static async update(id, body, kind, user, session, dataAccess) {
    const entry = await StockOpeningStockService._loadDraft(id, kind, session, dataAccess);
    const before = entry.toObject();

    if (body.branchId !== undefined) entry.branchId = await StockBranchService.assertBranchInScope(body.branchId, dataAccess, session);
    if (body.entryDate !== undefined) entry.entryDate = toDate(body.entryDate, "Entry date") || entry.entryDate;
    if (body.remarks !== undefined) entry.remarks = toText(body.remarks);
    if (body.lines !== undefined) entry.lines = await StockOpeningStockService._buildLines(body.lines, session, kindOf(entry.kind));
    if (isIssued(entry)) {
      if (body.personId === null || body.personId === "") throw new AppError("Choose who has these items", 400);
      entry.set(await StockOpeningStockService._issuedFields(body, entry.entryDate, session));
      if (entry.issuedSince && entry.issuedSince > entry.entryDate) throw new AppError("Issued since can't be after the entry date", 400);
    }

    await entry.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: entry._id, action: "UPDATE", actor: user, before, after: entry.toObject(),
    });
    return StockOpeningStockService._withIssues(entry, session);
  }

  static async remove(id, kind, user, session, dataAccess) {
    const entry = await StockOpeningStockService._loadDraft(id, kind, session, dataAccess);
    const before = entry.toObject();
    entry.isActive = false;
    entry.deletedAt = new Date();
    entry.deletedBy = actorSnapshot(user);
    await entry.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: entry._id, action: "DELETE", actor: user, before, after: entry.toObject(),
    });
    return { _id: entry._id };
  }

  /* ---------------------------------------------------------------------- */
  /* Post — the one step that creates stock                                 */
  /* ---------------------------------------------------------------------- */

  static async post(id, kind, user, session, dataAccess) {
    const entry = await StockOpeningStockService._loadDraft(id, kind, session, dataAccess);
    if (!entry.lines.length) throw new AppError("Add at least one item before posting", 400);
    const before = entry.toObject();

    const issues = await StockOpeningStockService._issues(before.lines, session);
    if (issues.length) {
      const sample = issues.slice(0, 3).map((r) => `line ${r.index + 1}: ${r.messages[0]}`).join("; ");
      throw new AppError(`${issues.length} line(s) need fixing before posting — ${sample}`, 400);
    }

    /*
      ISSUED: the person as the directory has them now (the snapshot is
      refreshed), and — for a subscriber — their row in the subscriber
      registry, so the website sees these units when it asks what they hold.
    */
    let assignedTo = null;
    let person = null;
    if (isIssued(entry)) {
      if (!entry.issuedTo?.personId) throw new AppError("Choose who has these items before posting", 400);
      person = await StockPeopleDirectoryService.getActive(entry.issuedTo.personId, session);
      const subscriber = await StockPeopleDirectoryService.ensureSubscriber(person, session);
      entry.issuedTo = StockPeopleDirectoryService.snapshotOf(person);
      assignedTo = {
        ...StockPeopleDirectoryService.assigneeOf(person, {
          subscriberId: subscriber?._id || null,
          assignedAt: entry.issuedSince || entry.entryDate,
          note: `Opening issued stock ${entry.entryNumber}`,
        }),
        requestNumber: entry.entryNumber,
      };
    }

    const products = await loadProducts(before.lines.map((l) => l.productDefinitionId), session);
    const source = { type: ITEM_SOURCE.OPENING_STOCK, refId: entry._id, refNumber: entry.entryNumber };
    const docs = before.lines.map((line) => {
      const { fields } = products.get(String(line.productDefinitionId));
      const keys = StockItemIdentityService.identifiersOf(line.fieldValues, fields.filter((f) => f.isUnique));
      return {
        productDefinitionId: line.productDefinitionId,
        vendorId: line.vendorId || null,
        branchId: entry.branchId,
        status: assignedTo ? ITEM_STATUS.ASSIGNED : postedStatus(line),
        approvalStatus: ITEM_APPROVAL_STATUS.APPROVED,
        fieldValues: line.fieldValues || {},
        identifiers: keys.length ? keys : undefined,
        quantity: line.trackingMethod === TRACKING_METHODS.QUANTITY ? line.quantity : null,
        source,
        condition: line.condition,
        purchaseCost: line.purchaseCost ?? null,
        purchaseDate: line.purchaseDate || null,
        warranty: {
          startDate: line.purchaseDate || null,
          months: line.warrantyMonths ?? null,
          endDate: line.warrantyEndDate || warrantyEndDate(line.purchaseDate, line.warrantyMonths),
        },
        assignedTo,
        // Faulty → straight into Repair & Warranty; beyond repair → on record only.
        fault:
          line.workingState === OPENING_STOCK_STATE.FAULTY
            ? { reportedAt: entry.entryDate, note: line.faultNote, via: `Opening stock ${entry.entryNumber}`, requestNumber: "" }
            : null,
        scrapNote: line.workingState === OPENING_STOCK_STATE.BEYOND_REPAIR ? line.faultNote : "",
        receivedAt: entry.entryDate,
        receivedBy: user?._id || user?.id || null,
      };
    });

    // The unique index is the last word: a serial posted by someone else in
    // the last few seconds fails the whole entry here, with nothing written.
    const items = await StockInventoryItemModel.insertMany(docs, { session });
    items.forEach((item, i) => (entry.lines[i].inventoryItemId = item._id));

    entry.status = OPENING_STOCK_STATUS.POSTED;
    entry.postedAt = new Date();
    entry.postedBy = actorSnapshot(user);
    await entry.save({ session });

    const ref = { type: ITEM_MOVEMENT_REF.OPENING_STOCK, refId: entry._id, refNumber: entry.entryNumber };
    // An issued unit's timeline reads like one issued here: received into
    // stock, then handed to the person — both on the entry date, the second
    // saying since when they really have had it.
    await StockItemMovementService.recordReceived(
      person ? items.map((it) => ({ ...it.toObject(), status: ITEM_STATUS.AVAILABLE })) : items,
      ref,
      session,
      { at: entry.entryDate }
    );
    if (person) {
      const since = entry.issuedSince ? ` since ${ymd(entry.issuedSince).split("-").reverse().join("-")}` : "";
      await StockItemMovementService.record(
        items.map((it) => ({
          inventoryItemId: it._id,
          productDefinitionId: it.productDefinitionId,
          type: person.kind === ASSIGNEE_KIND.EMPLOYEE ? ITEM_MOVEMENT_TYPE.ASSIGNED : ITEM_MOVEMENT_TYPE.ISSUED,
          at: entry.entryDate,
          quantity: it.quantity ?? null,
          fromBranchId: it.branchId,
          status: ITEM_STATUS.ASSIGNED,
          ref,
          note: `${person.kind === ASSIGNEE_KIND.EMPLOYEE ? "Assigned" : "Issued"} to ${who(person)}${since} — entered as opening issued stock`,
        })),
        session
      );
    }
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: entry._id, action: "POST", actor: user, before, after: entry.toObject(),
    });
    return StockOpeningStockService._withIssues(entry, session);
  }

  /* ---------------------------------------------------------------------- */
  /* Excel                                                                  */
  /* ---------------------------------------------------------------------- */

  static async buildTemplate(productId) {
    const [product] = await StockOpeningStockService.searchProducts({ productIds: [productId] });
    if (!product) throw new Error("Product definition not found");
    const vendors = await StockVendorModel.find({ isActive: true }).select("name").sort({ name: 1 }).lean();
    const buffer = await buildOpeningStockTemplate({ product, fields: product.fields, vendors });
    const safe = product.name.replace(/[^\w.-]+/g, "_").slice(0, 60);
    return { buffer, filename: `opening-stock-${safe}.xlsx` };
  }

  /*
    Reads a filled template into lines, WITHOUT saving anything. Rows that are
    malformed come back in `rowErrors` and are not offered as lines; rows that
    are merely incomplete come back as lines with `issues`, exactly as they
    would on a saved draft. The screen previews both, then adds the lines to
    the entry being edited.
  */
  static async parseUpload(productId, file) {
    if (!file?.buffer) throw new AppError("Upload the filled template", 400);
    const { productId: templateProductId, rows } = await readOpeningStockSheet(file.buffer);
    const [product] = await StockOpeningStockService.searchProducts({ productIds: [productId] });
    if (!product) throw new Error("Product definition not found");
    if (String(templateProductId) !== String(product._id)) {
      const [other] = await StockOpeningStockService.searchProducts({ productIds: [templateProductId] });
      throw new AppError(`Invalid file: this template is for "${other?.name || "another product"}", not "${product.name}"`, 400);
    }
    if (!rows.length) throw new AppError("The file has no filled rows", 400);

    const vendorDocs = await StockVendorModel.find({ isActive: true }).select("name").lean();
    const vendorByName = new Map(vendorDocs.map((v) => [v.name.trim().toLowerCase(), v]));
    const ctx = {
      products: await loadProducts([product._id]),
      vendors: new Map(vendorDocs.map((v) => [String(v._id), v])),
    };

    const lines = [];
    const rowErrors = [];
    for (const { rowNumber, values } of rows) {
      try {
        let vendorId = null;
        if (values.vendor) {
          const v = vendorByName.get(String(values.vendor).trim().toLowerCase());
          if (!v) throw new AppError(`Vendor "${values.vendor}" not found — use the exact name from the list`, 400);
          vendorId = v._id;
        }
        const fieldValues = {};
        Object.entries(values).forEach(([k, v]) => {
          if (k.startsWith("f:")) fieldValues[k.slice(2)] = v;
        });
        const line = StockOpeningStockService._buildLine(
          {
            productDefinitionId: product._id,
            fieldValues,
            quantity: values.quantity,
            condition: values.condition,
            workingState: values.workingState,
            faultNote: values.faultNote,
            vendorId,
            purchaseDate: values.purchaseDate,
            purchaseCost: values.purchaseCost,
            warrantyMonths: values.warrantyMonths,
            warrantyEndDate: values.warrantyEndDate,
          },
          ctx,
          ""
        );
        lines.push({ ...line, rowNumber });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        rowErrors.push({ rowNumber, message: err.message });
      }
    }

    const issues = (await StockOpeningStockService._issues(lines)).map((r) => ({
      rowNumber: lines[r.index].rowNumber,
      messages: r.messages,
    }));
    return { product, lines, rowErrors, issues };
  }
}
