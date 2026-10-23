import StockFieldDefinitionModel from "../models/stock.field.definition.model.js";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
// Registered for the populates below — this service must not depend on some
// other import having loaded them first.
import "../models/stock.branch.model.js";
import "../models/stock.product.definition.model.js";
import { AppError } from "../helpers/response.helper.js";
import { TRACKING_METHODS, ITEM_APPROVAL_STATUS } from "../constants/stock.enums.js";

/*
  Telling one physical unit from another.

  A field definition marked isUnique (serial no, MAC, IMEI…) names exactly one
  unit. Two rules follow, both for individual-tracked products only — a
  quantity batch is many units sharing one set of values, and its paid and FOC
  halves deliberately carry the same ones:

    1. Every unit carries at least one of its product's unique fields.
    2. No two live units share a unique value.

  Rule 2 is held by the database, not just checked here: each unit stores its
  unique values as normalised "code:VALUE" keys in `identifiers`, under a
  unique index. The lookup below exists to name the clash in words a store
  keeper can act on — the index is what makes two simultaneous entries of the
  same serial impossible.

  "Live" = not soft-deleted and not on a rejected receipt. Those two paths
  remove the keys (see releaseIdentifiers); a restore puts them back.
*/

export const normaliseIdentifierValue = (value) => String(value ?? "").trim().toUpperCase();
export const identifierKey = (code, value) => `${code}:${normaliseIdentifierValue(value)}`;
const codeOfKey = (key) => key.slice(0, key.indexOf(":"));
const valueOfKey = (key) => key.slice(key.indexOf(":") + 1);

export default class StockItemIdentityService {
  // The unique fields this product's units are told apart by — [] for a
  // quantity-tracked product, or one whose fields include none.
  static async uniqueFieldsFor(productDef, session = null) {
    if (productDef?.trackingMethod !== TRACKING_METHODS.INDIVIDUAL) return [];
    const ids = (productDef.selectedFields || []).map((sf) => sf.fieldDefId?._id ?? sf.fieldDefId).filter(Boolean);
    if (!ids.length) return [];
    return StockFieldDefinitionModel.find({ _id: { $in: ids }, isActive: true, isUnique: true })
      .select("code label")
      .session(session)
      .lean();
  }

  static identifiersOf(fieldValues, uniqueFields) {
    const keys = new Set();
    for (const f of uniqueFields) {
      const v = normaliseIdentifierValue(fieldValues?.[f.code]);
      if (v) keys.add(identifierKey(f.code, v));
    }
    return [...keys];
  }

  // Rule 1. `where` prefixes the message ("Row 4: ").
  static assertHasIdentifier(fieldValues, uniqueFields, where = "") {
    if (!uniqueFields.length) return;
    if (StockItemIdentityService.identifiersOf(fieldValues, uniqueFields).length) return;
    throw new AppError(`${where}${uniqueFields.map((f) => f.label).join(" or ")} is required`, 400);
  }

  /*
    Rule 2, inside one batch being saved together. `rows` is
    [{ where, keys }] — returns the first clash as "Row 2 and Row 7".
  */
  static assertNoDuplicatesWithin(rows, labelByCode = new Map()) {
    const seen = new Map();
    for (const row of rows) {
      for (const key of row.keys) {
        if (seen.has(key)) {
          const label = labelByCode.get(codeOfKey(key)) || codeOfKey(key);
          throw new AppError(`${label} "${valueOfKey(key)}" is entered twice — ${seen.get(key)} and ${row.where}`, 409);
        }
        seen.set(key, row.where);
      }
    }
  }

  // Rule 2, against what is already in stock.
  static async assertIdentifiersFree(keys, { session = null, excludeItemIds = [], labelByCode = new Map() } = {}) {
    if (!keys.length) return;
    const filter = { identifiers: { $in: keys } };
    if (excludeItemIds.length) filter._id = { $nin: excludeItemIds };
    const clashes = await StockInventoryItemModel.find(filter)
      .select("identifiers productDefinitionId branchId")
      .populate({ path: "productDefinitionId", select: "name" })
      .populate({ path: "branchId", select: "name" })
      .limit(10)
      .session(session)
      .lean();
    if (!clashes.length) return;

    const wanted = new Set(keys);
    const parts = [];
    for (const item of clashes) {
      for (const key of item.identifiers || []) {
        if (!wanted.has(key)) continue;
        const label = labelByCode.get(codeOfKey(key)) || codeOfKey(key);
        const where = [item.productDefinitionId?.name, item.branchId?.name].filter(Boolean).join(", ");
        parts.push(`${label} "${valueOfKey(key)}"${where ? ` (${where})` : ""}`);
      }
    }
    throw new AppError(`Already exists in stock: ${parts.join("; ")}`, 409);
  }

  // Code → label for every unique field, for messages that span products.
  static async labelByCode(session = null) {
    const fields = await StockFieldDefinitionModel.find({ isUnique: true }).select("code label").session(session).lean();
    return new Map(fields.map((f) => [f.code, f.label]));
  }

  /*
    A field was just marked unique, or unmarked. Brings every live individual
    unit's keys in line, inside the caller's transaction. Turning it ON over
    data that already holds duplicates fails on the unique index — and that is
    the right answer: the admin is told which values clash instead of the flag
    quietly not meaning what it says.

    bulkWrite on purpose: it is not one of the hooked write methods, so these
    rows keep their updatedBy — this is index upkeep, not anybody's edit.
  */
  static async rebuildForField(code, isUnique, session = null) {
    const path = `fieldValues.${code}`;
    const items = await StockInventoryItemModel.find({
      quantity: null,
      isActive: true,
      approvalStatus: { $ne: ITEM_APPROVAL_STATUS.REJECTED },
      [path]: { $exists: true, $nin: [null, ""] },
    })
      .select(`identifiers ${path}`)
      .session(session)
      .lean();

    const prefix = `${code}:`;
    if (isUnique) {
      const keys = items.map((it) => identifierKey(code, it.fieldValues?.[code]));
      const seen = new Set();
      const dupes = new Set();
      keys.forEach((k) => (seen.has(k) ? dupes.add(valueOfKey(k)) : seen.add(k)));
      if (dupes.size) {
        throw new AppError(
          `Can't mark this field unique — these values are already on more than one unit: ${[...dupes].slice(0, 10).join(", ")}`,
          409
        );
      }
    }

    const ops = items.map((it) => {
      const others = (it.identifiers || []).filter((k) => !k.startsWith(prefix));
      const next = isUnique ? [...others, identifierKey(code, it.fieldValues?.[code])] : others;
      return {
        updateOne: {
          filter: { _id: it._id },
          update: next.length ? { $set: { identifiers: next } } : { $unset: { identifiers: 1 } },
        },
      };
    });
    if (ops.length) await StockInventoryItemModel.bulkWrite(ops, { session });
    return ops.length;
  }
}
