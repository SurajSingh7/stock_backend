import {
  INPUT_TYPES_ARRAY,
  TRACKING_METHODS_ARRAY,
  ITEM_STATUS_ARRAY,
  CATEGORY_TYPES_ARRAY,
  UNIT_TYPES_ARRAY,
  GST_RATES_ARRAY,
  CATEGORY_APPROVAL_STATUS_ARRAY,
  TERMS_STATUS_ARRAY,
  NOTIFICATION_CHANNEL_ARRAY,
  NOTIFICATION_CHANNEL,
  BRANCH_ROLE_ARRAY,
} from "../constants/stock.enums.js";

const stripTags = (html) => String(html || "").replace(/<[^>]*>/g, "").trim();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = (e) => EMAIL_RE.test(String(e || "").trim());


// ─── Field Definition Validators ─────────────────────────────────────────────

const validateApplicableTrackingMethods = (applicableTrackingMethods) => {
  if (applicableTrackingMethods === undefined) return;
  if (!Array.isArray(applicableTrackingMethods) || applicableTrackingMethods.length === 0)
    throw new Error("applicableTrackingMethods must be a non-empty array");
  applicableTrackingMethods.forEach((m) => {
    if (!TRACKING_METHODS_ARRAY.includes(m))
      throw new Error(`applicableTrackingMethods must contain only: ${TRACKING_METHODS_ARRAY.join(", ")}`);
  });
};

export const validateCreateFieldDefinition = (body) => {
  const { code, label, inputType, applicableTrackingMethods } = body;
  if (!code) throw new Error("code is required");
  if (!/^[a-z0-9_]+$/.test(code))
    throw new Error("code must be snake_case lowercase only (letters, numbers, underscores)");
  if (!label) throw new Error("label is required");
  if (!inputType) throw new Error("inputType is required");
  if (!INPUT_TYPES_ARRAY.includes(inputType))
    throw new Error(`inputType must be one of: ${INPUT_TYPES_ARRAY.join(", ")}`);
  validateApplicableTrackingMethods(applicableTrackingMethods);
};

export const validateUpdateFieldDefinition = (body) => {
  if (body.code !== undefined) throw new Error("code is immutable and cannot be updated");
  const { label, inputType, applicableTrackingMethods } = body;
  if (label !== undefined && !label.trim()) throw new Error("label cannot be empty");
  if (inputType !== undefined && !INPUT_TYPES_ARRAY.includes(inputType))
    throw new Error(`inputType must be one of: ${INPUT_TYPES_ARRAY.join(", ")}`);
  validateApplicableTrackingMethods(applicableTrackingMethods);
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

// Thresholds are counts of stock, so fractions are meaningless. 0 IS allowed
// and means "only alert once this branch is completely out".
const assertThresholdValue = (value, label) => {
  if (value === undefined || value === null) throw new Error(`${label} is required`);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative whole number`);
};

const validateProductDefinitionExtras = (body) => {
  const { unit, gstRate, warrantyYears, defaultStockAlertThreshold, branchThresholds } = body;

  // Independent of trackingMethod — the client always picks both explicitly
  // (e.g. Group+Pieces for bottles, Individual+Meter for a serialized reel
  // are both valid combinations). Required, same as warrantyYears below.
  if (!unit) throw new Error("unit is required");
  if (!UNIT_TYPES_ARRAY.includes(unit))
    throw new Error(`unit must be one of: ${UNIT_TYPES_ARRAY.join(", ")}`);

  if (gstRate !== undefined && gstRate !== null && !GST_RATES_ARRAY.includes(String(gstRate)))
    throw new Error(`gstRate must be one of: ${GST_RATES_ARRAY.join(", ")}`);

  // Shape only. That every ACTIVE branch is actually covered needs the
  // branch collection, so it lives in the service
  // (assertBranchThresholdsComplete) — validators here stay DB-free.
  assertThresholdValue(defaultStockAlertThreshold, "defaultStockAlertThreshold");

  if (!Array.isArray(branchThresholds) || branchThresholds.length === 0)
    throw new Error("branchThresholds is required — set a stock alert threshold for every branch");

  const seenBranchIds = new Set();
  branchThresholds.forEach((row, i) => {
    if (!row || !row.branchId) throw new Error(`branchThresholds[${i}].branchId is required`);
    const key = String(row.branchId);
    if (seenBranchIds.has(key))
      throw new Error("branchThresholds must be unique per branch — the same branch is listed twice");
    seenBranchIds.add(key);
    assertThresholdValue(row.threshold, `branchThresholds[${i}].threshold`);
  });

  if (warrantyYears === undefined || warrantyYears === null)
    throw new Error("warrantyYears is required");
  if (
    typeof warrantyYears !== "number" ||
    !Number.isInteger(warrantyYears) ||
    warrantyYears < 1
  )
    throw new Error("warrantyYears must be a positive integer");
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
    // Soft guard only — the authoritative warrantyYears is resolved
    // server-side in buildItems() from the vendor assignment/product default,
    // this just rejects an obviously bad client-sent value if one is present.
    if (item.warrantyYears !== undefined && !isPositiveNumber(item.warrantyYears)) {
      throw new Error(`${where}: warrantyYears must be greater than 0`);
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
  // buyerEntity is no longer sent by the client — createPurchaseOrder derives
  // it server-side from the Tracking Order (see StockPurchaseOrderService).
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

// ─── Tracking Order Validators ───────────────────────────────────────────────

export const validateAddEntity = (body) => {
  const { entityId, alias, state, stateCode } = body || {};
  if (!entityId) throw new Error("entityId is required");
  if (!alias || !String(alias).trim()) throw new Error("Entity is required");
  if (!state || !String(state).trim()) throw new Error("State is required");
  if (!stateCode || !String(stateCode).trim()) throw new Error("State code is required");
};

export const validateMarkNotRequired = (body) => {
  if (!body?.reason || !String(body.reason).trim()) throw new Error("A reason is required");
};

// ─── Branch Validators ─────────────────────────────────────────────────────

export const validateCreateBranch = (body) => {
  const { name, code, branchRole } = body || {};
  if (!name || !String(name).trim()) throw new Error("name is required");
  if (!code || !String(code).trim()) throw new Error("code is required");
  if (branchRole !== undefined && branchRole !== null && !BRANCH_ROLE_ARRAY.includes(branchRole))
    throw new Error(`branchRole must be one of: ${BRANCH_ROLE_ARRAY.join(", ")}`);
};

export const validateUpdateBranch = (body) => {
  const { name, code, branchRole } = body || {};
  if (name !== undefined && !String(name).trim()) throw new Error("name cannot be empty");
  if (code !== undefined && !String(code).trim()) throw new Error("code cannot be empty");
  if (branchRole !== undefined && branchRole !== null && !BRANCH_ROLE_ARRAY.includes(branchRole))
    throw new Error(`branchRole must be one of: ${BRANCH_ROLE_ARRAY.join(", ")}`);
};

// ─── Inventory Transfer Request Validators ───────────────────────────────────

export const validateCreateTransferRequest = (body) => {
  if (!body || typeof body !== "object") throw new Error("Request body is required");
  const { requestingBranchId, sourceBranchId, lines } = body;

  if (!requestingBranchId) throw new Error("requestingBranchId is required");
  if (!sourceBranchId) throw new Error("sourceBranchId is required");
  if (String(requestingBranchId) === String(sourceBranchId))
    throw new Error("Requesting branch and source branch must be different");

  if (!Array.isArray(lines) || lines.length === 0)
    throw new Error("At least one product line is required");
  lines.forEach((l, idx) => {
    const where = `Line ${idx + 1}`;
    if (!isNonEmptyString(l?.productDefinitionId))
      throw new Error(`${where}: productDefinitionId is required`);
    if (!isPositiveNumber(l?.requestedQty))
      throw new Error(`${where}: requested quantity must be greater than 0`);
  });
};

export const validateProcessTransferRequest = (body) => {
  if (!body || typeof body !== "object") throw new Error("Request body is required");
  const { lines } = body;
  if (!Array.isArray(lines) || lines.length === 0) throw new Error("lines is required");

  let anyTransferred = false;
  lines.forEach((l, idx) => {
    const where = `Line ${idx + 1}`;
    if (!isNonEmptyString(l?.lineId)) throw new Error(`${where}: lineId is required`);
    if (typeof l?.transferQty !== "number" || l.transferQty < 0)
      throw new Error(`${where}: transfer quantity must be 0 or greater`);
    if (l.transferQty > 0) anyTransferred = true;
    if (l.inventoryItemIds !== undefined && !Array.isArray(l.inventoryItemIds))
      throw new Error(`${where}: inventoryItemIds must be an array`);
  });
  if (!anyTransferred)
    throw new Error("At least one line must have a transfer quantity greater than 0 — use reject instead");
};

export const validateRejectTransferRequest = (body) => {
  if (!body?.reason || !String(body.reason).trim()) throw new Error("A reason is required");
};

// ─── Invoice (goods receiving) Validators ────────────────────────────────────

export const validateCreateInvoice = (body) => {
  if (!body || typeof body !== "object") throw new Error("Request body is required");

  const { invoiceNumber, invoiceDate, branchId, lines, extraCharges } = body;
  if (!invoiceNumber || !String(invoiceNumber).trim()) throw new Error("Invoice number is required");
  if (!invoiceDate) throw new Error("Invoice date is required");
  // The branch is the invoice's branch — the service checks it is one the
  // receiver may use; here we only insist it was sent at all.
  if (!isNonEmptyString(branchId)) throw new Error("Receiving branch is required");

  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("At least one product line must be received");
  }
  lines.forEach((line, idx) => {
    const where = `Line ${idx + 1}`;
    if (!isNonEmptyString(line.quotationItemId)) {
      throw new Error(`${where}: quotationItemId is required`);
    }
    if (!isNonNegativeNumber(line.receivedQuantity)) {
      throw new Error(`${where}: received quantity must be 0 or greater`);
    }
    if (line.focQuantity !== undefined && !isNonNegativeNumber(line.focQuantity)) {
      throw new Error(`${where}: FOC quantity must be 0 or greater`);
    }
    if ((line.receivedQuantity || 0) <= 0 && (line.focQuantity || 0) <= 0) {
      throw new Error(`${where}: received or FOC quantity must be greater than 0`);
    }
    if (line.rows !== undefined && !Array.isArray(line.rows)) {
      throw new Error(`${where}: rows must be an array`);
    }
    if (line.rating !== undefined && line.rating !== null) {
      const r = line.rating.rating;
      if (r !== undefined && r !== null && (typeof r !== "number" || r < 0 || r > 5)) {
        throw new Error(`${where}: rating must be between 0 and 5`);
      }
    }
  });

  if (extraCharges !== undefined) {
    if (!Array.isArray(extraCharges)) throw new Error("extraCharges must be an array");
    extraCharges.forEach((c, idx) => {
      if (!isNonNegativeNumber(c.amount)) {
        throw new Error(`Extra charge ${idx + 1}: amount must be 0 or greater`);
      }
    });
  }
};

export const validateUpdateInvoice = (body) => validateCreateInvoice(body);

export const validateRejectInvoice = (body) => {
  if (!body?.reason || !String(body.reason).trim()) throw new Error("A reason is required");
};

// ─── Notification Validators ─────────────────────────────────────────────────

export const validateCreateNotification = (body) => {
  const { name, channel, isDefault, applicableVendors, ccEmails } = body || {};

  if (!name || !String(name).trim()) throw new Error("name is required");
  if (!channel || !NOTIFICATION_CHANNEL_ARRAY.includes(channel)) {
    throw new Error(`channel must be one of: ${NOTIFICATION_CHANNEL_ARRAY.join(", ")}`);
  }

  if (!isDefault) {
    if (!Array.isArray(applicableVendors) || applicableVendors.length === 0) {
      throw new Error("applicableVendors is required when Default is No");
    }
  }

  if (channel === NOTIFICATION_CHANNEL.EMAIL && ccEmails !== undefined) {
    if (!Array.isArray(ccEmails)) throw new Error("ccEmails must be an array");
    ccEmails.forEach((e) => {
      if (!isValidEmail(e)) throw new Error(`Invalid CC email: ${e}`);
    });
  }
};

export const validateUpdateNotification = (body) => {
  const { name, channel, isDefault, applicableVendors, ccEmails } = body || {};

  if (name !== undefined && !String(name).trim()) throw new Error("name cannot be empty");
  if (channel !== undefined && !NOTIFICATION_CHANNEL_ARRAY.includes(channel)) {
    throw new Error(`channel must be one of: ${NOTIFICATION_CHANNEL_ARRAY.join(", ")}`);
  }

  if (isDefault === false) {
    if (!Array.isArray(applicableVendors) || applicableVendors.length === 0) {
      throw new Error("applicableVendors is required when Default is No");
    }
  }

  const effectiveChannel = channel || NOTIFICATION_CHANNEL.EMAIL;
  if (effectiveChannel === NOTIFICATION_CHANNEL.EMAIL && ccEmails !== undefined) {
    if (!Array.isArray(ccEmails)) throw new Error("ccEmails must be an array");
    ccEmails.forEach((e) => {
      if (!isValidEmail(e)) throw new Error(`Invalid CC email: ${e}`);
    });
  }
};

// ─── Send Mail (Purchase Order) Validator ────────────────────────────────────

export const validateSendMail = (body) => {
  const { sendEmail, to, cc } = body || {};
  if (sendEmail) {
    if (!to || !isValidEmail(to)) throw new Error("A valid To email is required");
    if (cc !== undefined) {
      if (!Array.isArray(cc)) throw new Error("cc must be an array");
      cc.forEach((e) => {
        if (!isValidEmail(e)) throw new Error(`Invalid CC email: ${e}`);
      });
    }
  }
};