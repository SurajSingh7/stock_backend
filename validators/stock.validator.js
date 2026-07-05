import {
  INPUT_TYPES_ARRAY,
  TRACKING_METHODS_ARRAY,
  ITEM_STATUS_ARRAY,
  CATEGORY_TYPES_ARRAY,
  UNIT_TYPES_ARRAY,
  GST_RATES_ARRAY,
} from "../constants/stock.enums.js";

// ─── Field Definition Validators ─────────────────────────────────────────────

export const validateCreateFieldDefinition = (body) => {
  const { code, label, inputType } = body;
  if (!code) throw new Error("code is required");
  if (!/^[a-z0-9_]+$/.test(code))
    throw new Error("code must be snake_case lowercase only (letters, numbers, underscores)");
  if (!label) throw new Error("label is required");
  if (!inputType) throw new Error("inputType is required");
  if (!INPUT_TYPES_ARRAY.includes(inputType))
    throw new Error(`inputType must be one of: ${INPUT_TYPES_ARRAY.join(", ")}`);
};

export const validateUpdateFieldDefinition = (body) => {
  if (body.code !== undefined) throw new Error("code is immutable and cannot be updated");
  const { label, inputType } = body;
  if (label !== undefined && !label.trim()) throw new Error("label cannot be empty");
  if (inputType !== undefined && !INPUT_TYPES_ARRAY.includes(inputType))
    throw new Error(`inputType must be one of: ${INPUT_TYPES_ARRAY.join(", ")}`);
};

// ─── Category Validators ──────────────────────────────────────────────────────

export const validateCreateCategory = (body) => {
  const { name, type } = body;
  if (!name || !name.trim()) throw new Error("name is required");
  if (!type) throw new Error("type is required");
  if (!CATEGORY_TYPES_ARRAY.includes(type))
    throw new Error(`type must be one of: ${CATEGORY_TYPES_ARRAY.join(", ")}`);
};

export const validateUpdateCategory = (body) => {
  if (body.type !== undefined) throw new Error("type is immutable and cannot be updated");
  if (!body.name || !body.name.trim()) throw new Error("name is required");
};

export const validateMoveCategory = (body) => {
  if (body.newParentId === undefined)
    throw new Error("newParentId is required (use null to make root)");
};

export const validateReorderCategories = (body) => {
  const { siblings } = body;
  if (!Array.isArray(siblings) || siblings.length === 0)
    throw new Error("siblings must be a non-empty array");
  siblings.forEach((s, i) => {
    if (!s._id) throw new Error(`siblings[${i}]._id is required`);
    if (s.sortOrder === undefined) throw new Error(`siblings[${i}].sortOrder is required`);
  });
};

// ─── Product Definition Validators ───────────────────────────────────────────

const validateProductDefinitionExtras = (body) => {
  const { unit, gstRate, stockAlertThreshold, companyUseOnly } = body;

  if (unit !== undefined && unit !== null && !UNIT_TYPES_ARRAY.includes(unit))
    throw new Error(`unit must be one of: ${UNIT_TYPES_ARRAY.join(", ")}`);

  if (gstRate !== undefined && gstRate !== null && !GST_RATES_ARRAY.includes(String(gstRate)))
    throw new Error(`gstRate must be one of: ${GST_RATES_ARRAY.join(", ")}`);

  if (
    stockAlertThreshold !== undefined &&
    stockAlertThreshold !== null &&
    (typeof stockAlertThreshold !== "number" || stockAlertThreshold < 0)
  )
    throw new Error("stockAlertThreshold must be a non-negative number");

  if (companyUseOnly !== undefined && typeof companyUseOnly !== "boolean")
    throw new Error("companyUseOnly must be a boolean");
};

export const validateCreateProductDefinition = (body) => {
  const { categoryId, name, trackingMethod, selectedFields } = body;
  if (!categoryId) throw new Error("categoryId is required");
  if (!name || !name.trim()) throw new Error("name is required");
  if (!trackingMethod) throw new Error("trackingMethod is required");
  if (!TRACKING_METHODS_ARRAY.includes(trackingMethod))
    throw new Error(`trackingMethod must be one of: ${TRACKING_METHODS_ARRAY.join(", ")}`);
  if (!Array.isArray(selectedFields) || selectedFields.length === 0)
    throw new Error("selectedFields must be a non-empty array");
  selectedFields.forEach((f, i) => {
    if (!f.fieldDefId) throw new Error(`selectedFields[${i}].fieldDefId is required`);
    if (f.order === undefined) throw new Error(`selectedFields[${i}].order is required`);
  });

  validateProductDefinitionExtras(body);
};

export const validateUpdateProductDefinition = (body) => {
  if (body.categoryId !== undefined) throw new Error("categoryId cannot be changed after creation");
  if (body.trackingMethod !== undefined && !TRACKING_METHODS_ARRAY.includes(body.trackingMethod))
    throw new Error(`trackingMethod must be one of: ${TRACKING_METHODS_ARRAY.join(", ")}`);
  if (body.selectedFields !== undefined) {
    if (!Array.isArray(body.selectedFields) || body.selectedFields.length === 0)
      throw new Error("selectedFields must be a non-empty array");
    body.selectedFields.forEach((f, i) => {
      if (!f.fieldDefId) throw new Error(`selectedFields[${i}].fieldDefId is required`);
      if (f.order === undefined) throw new Error(`selectedFields[${i}].order is required`);
    });
  }

  validateProductDefinitionExtras(body);
};

// ─── Inventory Item Validators ────────────────────────────────────────────────

export const validateCreateInventoryItem = (body) => {
  const { productDefinitionId, receivedAt } = body;
  if (!productDefinitionId) throw new Error("productDefinitionId is required");
  if (!receivedAt) throw new Error("receivedAt is required");
};

export const validateBulkCreateInventoryItems = (body) => {
  const { productDefinitionId, items, receivedAt } = body;
  if (!productDefinitionId) throw new Error("productDefinitionId is required");
  if (!receivedAt) throw new Error("receivedAt is required");
  if (!Array.isArray(items) || items.length === 0)
    throw new Error("items must be a non-empty array");
};

export const validateUpdateItemStatus = (body) => {
  const { status } = body;
  if (!status) throw new Error("status is required");
  if (!ITEM_STATUS_ARRAY.includes(status))
    throw new Error(`status must be one of: ${ITEM_STATUS_ARRAY.join(", ")}`);
};