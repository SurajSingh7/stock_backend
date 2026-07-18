import {
  INPUT_TYPES_ARRAY,
  TRACKING_METHODS_ARRAY,
  ITEM_STATUS_ARRAY,
  CATEGORY_TYPES_ARRAY,
  UNIT_TYPES_ARRAY,
  GST_RATES_ARRAY,
  CATEGORY_APPROVAL_STATUS_ARRAY,
  TERMS_STATUS_ARRAY,
} from "../constants/stock.enums.js";

const stripTags = (html) => String(html || "").replace(/<[^>]*>/g, "").trim();


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
  const { unit, gstRate, stockAlertThreshold } = body;

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

// ─── Vendor Validators ────────────────────────────────────────────────────────

export const validateCreateVendor = (body) => {
  const { name, paymentTerms, contacts, address, bankAccounts, gst } = body || {};

  if (!name || !String(name).trim()) throw new Error("name is required");
  if (!paymentTerms || !String(paymentTerms).trim()) {
    throw new Error("paymentTerms is required");
  }

  if (!Array.isArray(contacts) || contacts.length === 0) {
    throw new Error("At least one contact is required");
  }
  const primaryContact = contacts.find((c) => c?.label === "PRIMARY");
  if (!primaryContact) throw new Error("PRIMARY contact is required");
  contacts.forEach((c) => {
    const label = c?.label || "Contact";
    if (!c?.name || !String(c.name).trim()) throw new Error(`${label}: name is required`);
    if (!c?.email || !String(c.email).trim()) throw new Error(`${label}: email is required`);
    if (!c?.phone || !String(c.phone).trim()) throw new Error(`${label}: phone is required`);
  });

  if (!address || !address.fullAddress || !String(address.fullAddress).trim()) {
    throw new Error("address.fullAddress is required");
  }
  if (!address.area || !String(address.area).trim()) throw new Error("address.area is required");
  if (!address.city || !String(address.city).trim()) throw new Error("address.city is required");
  if (!address.pinCode || !String(address.pinCode).trim()) {
    throw new Error("address.pinCode is required");
  }

  if (!Array.isArray(bankAccounts) || bankAccounts.length === 0) {
    throw new Error("At least one bank account is required");
  }
  const primaryBank = bankAccounts.find((b) => b?.label === "PRIMARY");
  if (!primaryBank) throw new Error("PRIMARY bank account is required");
  bankAccounts.forEach((b) => {
    const label = b?.label || "Bank account";
    if (!b?.ifsc || !String(b.ifsc).trim()) throw new Error(`${label}: ifsc is required`);
    if (!b?.accountNumber || !String(b.accountNumber).trim()) {
      throw new Error(`${label}: accountNumber is required`);
    }
  });

  if (gst && gst.isAvailable) {
    if (!gst.gstNumber || !String(gst.gstNumber).trim()) {
      throw new Error("gst.gstNumber is required when GST is available");
    }
  }
};

export const validateUpdateVendor = (body) => {
  if (Object.prototype.hasOwnProperty.call(body || {}, "vendorCode")) {
    throw new Error("vendorCode cannot be updated once set");
  }
  validateCreateVendor(body);
};

// ─── Quotation Validators ─────────────────────────────────────────────────────

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const isPositiveNumber = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const isNonNegativeNumber = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

export const validateCreateQuotation = (body) => {
  if (!body || typeof body !== "object") throw new Error("Request body is required");

  const { items } = body;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("At least one product must be selected");
  }

  items.forEach((item, idx) => {
    const where = `Item ${idx + 1}`;
    if (!isNonEmptyString(item.productDefinitionId)) {
      throw new Error(`${where}: productDefinitionId is required`);
    }
    if (!isNonEmptyString(item.vendorId)) throw new Error(`${where}: vendorId is required`);
    if (!isNonEmptyString(item.categoryId)) throw new Error(`${where}: categoryId is required`);
    if (!isPositiveNumber(item.quantity)) {
      throw new Error(`${where}: quantity must be greater than 0`);
    }
    if (!isNonNegativeNumber(item.unitPrice)) {
      throw new Error(`${where}: price must be 0 or greater`);
    }
  });
};

/*
  Approval submit — one decision per category, all at once. Shape check only;
  the service enforces "every category decided" and "selection belongs to the
  category" against the actual quotation.

  decisions: [
    { categoryId, status: "APPROVED",
      selection: { productDefinitionId, vendorId }, remarks? },
    { categoryId, status: "REJECTED", remarks? }
  ]
*/
export const validateReviewQuotation = (body) => {
  if (!body || typeof body !== "object") throw new Error("Request body is required");

  const { decisions } = body;
  if (!Array.isArray(decisions) || decisions.length === 0) {
    throw new Error("decisions must be a non-empty array");
  }

  const seen = new Set();
  decisions.forEach((d, idx) => {
    const where = `Decision ${idx + 1}`;
    if (!isNonEmptyString(d.categoryId)) throw new Error(`${where}: categoryId is required`);
    if (seen.has(d.categoryId)) throw new Error("Each category can be decided only once");
    seen.add(d.categoryId);

    if (!CATEGORY_APPROVAL_STATUS_ARRAY.includes(d.status)) {
      throw new Error(
        `${where}: status must be one of: ${CATEGORY_APPROVAL_STATUS_ARRAY.join(", ")}`
      );
    }
    if (d.remarks !== undefined && typeof d.remarks !== "string") {
      throw new Error(`${where}: remarks must be a string`);
    }

    if (d.status === "APPROVED") {
      const sel = d.selection;
      // Exactly one product + one vendor per approved category (current rule).
      if (!sel || typeof sel !== "object" || Array.isArray(sel)) {
        throw new Error(`${where}: an approved category needs one product + vendor selection`);
      }
      if (!isNonEmptyString(sel.productDefinitionId)) {
        throw new Error(`${where}: selection.productDefinitionId is required`);
      }
      if (!isNonEmptyString(sel.vendorId)) {
        throw new Error(`${where}: selection.vendorId is required`);
      }
    }
  });
};


export const validateCreatePurchaseOrder = (body) => {
  if (!body || typeof body !== "object") throw new Error("Request body is required");
  if (!body.sourceQuotationId || typeof body.sourceQuotationId !== "string")
    throw new Error("sourceQuotationId is required");
  if (!body.vendorId || typeof body.vendorId !== "string")
    throw new Error("vendorId is required");
  if (!Array.isArray(body.quotationItemIds) || body.quotationItemIds.length === 0)
    throw new Error("Select at least one item for the PO");
  if (!body.buyerEntity || typeof body.buyerEntity !== "object")
    throw new Error("Entity (buyer) is required");
  if (!body.buyerEntity.stateCode)
    throw new Error("Entity state code is required (for GST split)");
  if (!body.requester || !String(body.requester).trim())
    throw new Error("Requester is required");
  if (body.skippedItems !== undefined) {
    if (!Array.isArray(body.skippedItems)) throw new Error("skippedItems must be an array");
    body.skippedItems.forEach((s, i) => {
      if (!s || !s.itemId) throw new Error(`skippedItems[${i}].itemId is required`);
      if (!s.reason || !String(s.reason).trim())
        throw new Error(`A reason is required for every skipped item`);
    });
  }
};

export const validateDisableVendor = (body) => {
  if (!body?.vendorId) throw new Error("vendorId is required");
  if (!body?.reason || !String(body.reason).trim()) throw new Error("A reason is required");
};

export const validateRejectPurchaseOrder = (body) => {
  if (body && body.rejectedReason !== undefined && typeof body.rejectedReason !== "string") {
    throw new Error("rejectedReason must be a string");
  }
};

// ─── Terms & Conditions Validators ───────────────────────────────────────────

export const validateCreateTermsCondition = (body) => {
  const { termName, isDefault, applicableVendors, termsContent, status } = body || {};

  if (!termName || !String(termName).trim()) throw new Error("termName is required");
  if (!stripTags(termsContent)) throw new Error("termsContent is required");

  if (!isDefault) {
    if (!Array.isArray(applicableVendors) || applicableVendors.length === 0) {
      throw new Error("applicableVendors is required when Default is No");
    }
  }

  if (status !== undefined && !TERMS_STATUS_ARRAY.includes(status)) {
    throw new Error(`status must be one of: ${TERMS_STATUS_ARRAY.join(", ")}`);
  }
};

export const validateUpdateTermsCondition = (body) => {
  const { termName, isDefault, applicableVendors, termsContent, status } = body || {};

  if (termName !== undefined && !String(termName).trim()) throw new Error("termName cannot be empty");
  if (termsContent !== undefined && !stripTags(termsContent)) {
    throw new Error("termsContent cannot be empty");
  }

  if (isDefault === false) {
    if (!Array.isArray(applicableVendors) || applicableVendors.length === 0) {
      throw new Error("applicableVendors is required when Default is No");
    }
  }

  if (status !== undefined && !TERMS_STATUS_ARRAY.includes(status)) {
    throw new Error(`status must be one of: ${TERMS_STATUS_ARRAY.join(", ")}`);
  }
};