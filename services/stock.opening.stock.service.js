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
  OPENING_STOCK_STATUS,
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
*/

const MODULE_KEY = "opening-stock";
const ENTITY_TYPE = "opening-stock";
const TEXT_MAX = 300;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const assertDataScope = (entry, dataAccess) => {
  if (!isWithinDataScope(entry, dataAccess, MODULE_KEY)) throw new Error("Opening stock entry not found");
};

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

const toText = (v) => (v === undefined || v === null ? "" : String(v).trim().slice(0, TEXT_MAX));

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
  static _buildLine(input, { products, vendors }, where) {
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

    const condition = ITEM_CONDITION_ARRAY.includes(String(input.condition || "").toUpperCase())
      ? String(input.condition).toUpperCase()
      : ITEM_CONDITION.USED;
    const heldBy = toText(input.heldBy);

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
      // A unit that is with someone right now is, by definition, in use.
      condition: heldBy ? ITEM_CONDITION.USED : condition,
      heldBy,
      lastUsedBy: toText(input.lastUsedBy),
      historyRemarks: toText(input.historyRemarks),
    };
  }

  static async _buildLines(inputs, session) {
    const products = await loadProducts(inputs.map((l) => l?.productDefinitionId), session);
    const vendors = await loadVendors(inputs.map((l) => l?.vendorId), session);
    return inputs.map((l, i) => StockOpeningStockService._buildLine(l, { products, vendors }, `Line ${i + 1}: `));
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

  static async list({ skip, limit, status, branchId, search }, dataAccess) {
    const filter = { isActive: true };
    if (status && Object.values(OPENING_STOCK_STATUS).includes(status)) filter.status = status;
    if (branchId && mongoose.isValidObjectId(branchId)) filter.branchId = branchId;
    if (search) filter.entryNumber = { $regex: escapeRegex(search), $options: "i" };
    applyDataScope(filter, dataAccess, MODULE_KEY);

    const [rows, total] = await Promise.all([
      StockOpeningStockModel.find(filter)
        .select("entryNumber branchId entryDate remarks status postedAt postedBy createdBy createdAt lines.quantity lines.trackingMethod lines.heldBy")
        .populate({ path: "branchId", select: "name code" })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StockOpeningStockModel.countDocuments(filter),
    ]);

    const data = rows.map(({ lines = [], ...r }) => ({
      ...r,
      lineCount: lines.length,
      unitCount: lines.filter((l) => l.trackingMethod === TRACKING_METHODS.INDIVIDUAL).length,
      reservedCount: lines.filter((l) => l.heldBy).length,
    }));
    return { data, total };
  }

  static async getById(id, dataAccess) {
    const entry = await StockOpeningStockModel.findOne({ _id: id, isActive: true })
      .populate({ path: "branchId", select: "name code" })
      .lean();
    if (!entry) throw new Error("Opening stock entry not found");
    assertDataScope({ ...entry, branchId: entry.branchId?._id }, dataAccess);
    return StockOpeningStockService._withIssues(entry);
  }

  static async create(body, user, session, dataAccess) {
    const branchId = await StockBranchService.assertBranchInScope(body.branchId, dataAccess, session);
    const lines = await StockOpeningStockService._buildLines(body.lines || [], session);
    const entryNumber = await nextDocumentNumber({ model: StockOpeningStockModel, field: "entryNumber", prefix: "OS", session });

    const [entry] = await StockOpeningStockModel.create(
      [
        {
          entryNumber,
          branchId,
          entryDate: toDate(body.entryDate, "Entry date") || toDate(new Date(), "Entry date"),
          remarks: toText(body.remarks),
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

  static async _loadDraft(id, session, dataAccess) {
    const entry = await StockOpeningStockModel.findOne({ _id: id, isActive: true }).session(session);
    if (!entry) throw new Error("Opening stock entry not found");
    assertDataScope(entry, dataAccess);
    if (entry.status !== OPENING_STOCK_STATUS.DRAFT) throw new AppError("Only a draft entry can be changed — this one is already posted", 400);
    return entry;
  }

  static async update(id, body, user, session, dataAccess) {
    const entry = await StockOpeningStockService._loadDraft(id, session, dataAccess);
    const before = entry.toObject();

    if (body.branchId !== undefined) entry.branchId = await StockBranchService.assertBranchInScope(body.branchId, dataAccess, session);
    if (body.entryDate !== undefined) entry.entryDate = toDate(body.entryDate, "Entry date") || entry.entryDate;
    if (body.remarks !== undefined) entry.remarks = toText(body.remarks);
    if (body.lines !== undefined) entry.lines = await StockOpeningStockService._buildLines(body.lines, session);

    await entry.save({ session });
    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE, entityId: entry._id, action: "UPDATE", actor: user, before, after: entry.toObject(),
    });
    return StockOpeningStockService._withIssues(entry, session);
  }

  static async remove(id, user, session, dataAccess) {
    const entry = await StockOpeningStockService._loadDraft(id, session, dataAccess);
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

  static async post(id, user, session, dataAccess) {
    const entry = await StockOpeningStockService._loadDraft(id, session, dataAccess);
    if (!entry.lines.length) throw new AppError("Add at least one item before posting", 400);
    const before = entry.toObject();

    const issues = await StockOpeningStockService._issues(before.lines, session);
    if (issues.length) {
      const sample = issues.slice(0, 3).map((r) => `line ${r.index + 1}: ${r.messages[0]}`).join("; ");
      throw new AppError(`${issues.length} line(s) need fixing before posting — ${sample}`, 400);
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
        status: line.heldBy ? ITEM_STATUS.RESERVED : ITEM_STATUS.AVAILABLE,
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
        legacy: { lastUsedBy: line.lastUsedBy || "", remarks: line.historyRemarks || "" },
        heldByNote: line.heldBy || "",
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
    entry.postedBy = {
      userId: user?._id || user?.id || null,
      employeeCode: user?.employeeCode || "",
      name: user?.name || "",
    };
    await entry.save({ session });

    await StockItemMovementService.recordReceived(
      items,
      { type: ITEM_MOVEMENT_REF.OPENING_STOCK, refId: entry._id, refNumber: entry.entryNumber },
      session,
      { at: entry.entryDate }
    );
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
            vendorId,
            purchaseDate: values.purchaseDate,
            purchaseCost: values.purchaseCost,
            warrantyMonths: values.warrantyMonths,
            warrantyEndDate: values.warrantyEndDate,
            heldBy: values.heldBy,
            lastUsedBy: values.lastUsedBy,
            historyRemarks: values.historyRemarks,
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
