import {
  INPUT_TYPES_ARRAY,
  TRACKING_METHODS_ARRAY,
  ITEM_STATUS_ARRAY,
  CATEGORY_TYPES_ARRAY,
  UNIT_TYPES_ARRAY,
  CATEGORY_APPROVAL_STATUS_ARRAY,
  TERMS_STATUS_ARRAY,
  NOTIFICATION_CHANNEL_ARRAY,
  NOTIFICATION_CHANNEL,
  BRANCH_ROLE_ARRAY,
  ADJUSTMENT_TYPE_ARRAY,
  PAYMENT_MODE_ARRAY,
} from "../constants/stock.enums.js";
import { assertWarrantyMonths } from "../helpers/stock.warranty.helper.js";

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
  const { unit, gstRate, warrantyMonths, defaultStockAlertThreshold, branchThresholds } = body;

  // Independent of trackingMethod — the client always picks both explicitly
  // (e.g. Group+Pieces for bottles, Individual+Meter for a serialized reel
  // are both valid combinations). Required, same as warrantyMonths below.
  if (!unit) throw new Error("unit is required");
  if (!UNIT_TYPES_ARRAY.includes(unit))
    throw new Error(`unit must be one of: ${UNIT_TYPES_ARRAY.join(", ")}`);

  // Required: every product is billed, so it needs a slab. 0 is a legitimate
  // answer (exempt goods), which is why this is an explicit empty-check and
  // not a falsy one — `!gstRate` would reject 0.
  //
  // Shape only. That the number is an ACTIVE slab needs the gstrates
  // collection, so it lives in the service (StockGstRateService
  // .assertRateAllowed), same split as branchThresholds below.
  if (gstRate === undefined || gstRate === null || gstRate === "")
    throw new Error("gstRate is required");
  const rate = Number(gstRate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100)
    throw new Error("gstRate must be a number between 0 and 100");

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

  if (warrantyMonths === undefined || warrantyMonths === null)
    throw new Error("warrantyMonths is required");
  assertWarrantyMonths(warrantyMonths);
};

export const validateCreateProductDefinition = (body) => {
  const { categoryId, name, trackingMethod, selectedFields } = body;
  if (!categoryId) throw new Error("categoryId is required");
  if (!name || !name.trim()) throw new Error("name is required");
  if (!trackingMethod) throw new Error("trackingMethod is required");
  if (!TRACKING_METHODS_ARRAY.includes(trackingMethod))
    throw new Error(`trackingMethod must be one of: ${TRACKING_METHODS_ARRAY.join(", ")}`);
  // Shape only. Whether the list may be EMPTY depends on the tracking method
  // (Individual needs at least one, Group does not) — that rule lives in
  // StockProductDefinitionService.assertSelectedFieldsPresent, which is the
  // one place that knows the effective tracking method on an update too.
  if (!Array.isArray(selectedFields))
    throw new Error("selectedFields must be an array");
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
    // Empty is allowed here — see the note in validateCreateProductDefinition.
    if (!Array.isArray(body.selectedFields))
      throw new Error("selectedFields must be an array");
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

// Five letters, four digits, one letter — e.g. ABCDE1234F. Same shape the
// vendor form checks client-side, restated here because a validator that
// trusts the client is not a validator.
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export const validateCreateVendor = (body) => {
  const { name, paymentTerms, contacts, address, bankAccounts, gst, panNumber } = body || {};

  if (!name || !String(name).trim()) throw new Error("name is required");
  if (!paymentTerms || !String(paymentTerms).trim()) {
    throw new Error("paymentTerms is required");
  }

  // Required: a vendor is a legal payee, and PAN is what identifies one for
  // TDS and reporting. Uniqueness needs the collection, so that half lives in
  // StockVendorService.assertVendorNotDuplicate.
  if (!panNumber || !String(panNumber).trim()) throw new Error("panNumber is required");
  if (!PAN_RE.test(String(panNumber).trim().toUpperCase())) {
    throw new Error("panNumber must be a valid PAN (e.g. ABCDE1234F)");
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
    // Left optional: the schema defaults it to TO, so an older payload that
    // omits it still saves and the contact keeps receiving mail.
    if (c?.recipientType && !["TO", "CC", "NONE"].includes(String(c.recipientType).toUpperCase())) {
      throw new Error(`${label}: recipientType must be TO, CC or None`);
    }
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

  // Per-assignment warranty override. Optional — null falls back to the
  // product's own default — but a value that is sent must be a valid month
  // count, the same range the product default is held to.
  (body.assignedProducts || []).forEach((ap) =>
    (ap?.products || []).forEach((p) => {
      const months = p?.overrides?.warrantyMonths;
      if (months !== undefined && months !== null) {
        assertWarrantyMonths(months, "Assigned product warrantyMonths");
      }
    })
  );
};

export const validateUpdateVendor = (body) => {
  if (Object.prototype.hasOwnProperty.call(body || {}, "vendorCode")) {
    throw new Error("vendorCode cannot be updated once set");
  }
  validateCreateVendor(body);
};

// ─── Quotation Validators ─────────────────────────────────────────────────────

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

/*
  Mongo ids, checked for SHAPE before they reach the database.

  Without this a malformed id sails through to Mongoose, which throws a
  CastError that the response handler turns into "One of the values sent is not
  in a valid format" — a message that names neither the field nor what was
  wrong with it. Checked here, the error can say which field.
*/
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const isObjectId = (v) => typeof v === "string" && OBJECT_ID_RE.test(v.trim());
const assertObjectId = (v, label) => {
  if (!isNonEmptyString(v)) throw new Error(`${label} is required`);
  if (!isObjectId(v)) throw new Error(`${label} is not a valid id`);
};

/*
  A date the user picked. Rejects nonsense outright, and also a date that
  parses but cannot be meant — a PO dated 1900 or ten years out is a typo or a
  broken client, and it would otherwise be accepted in silence and printed on
  the document.
*/
const assertPickedDate = (v, label) => {
  if (v === undefined || v === null || v === "") return;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`${label} is not a valid date`);
  const year = d.getFullYear();
  const thisYear = new Date().getFullYear();
  if (year < thisYear - 5 || year > thisYear + 1) {
    throw new Error(`${label} looks wrong — check the year`);
  }
};
const isPositiveNumber = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const isNonNegativeNumber = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/*
  Create payload (a quotation is never updated). Shape only; everything that
  needs the database (product and vendor exist, vendor is in the caller's
  branch scope, vendor supplies the product, category, GST, default warranty,
  history) is resolved in StockQuotationService.buildItems.

  {
    notes?: string,
    products: [
      { productDefinitionId, quantity,            // one quantity per product —
        offers: [                                  // every vendor quotes it
          { vendorId, unitPrice, warrantyMonths? } // warrantyMonths: override
        ]                                          // for this quotation only
      }
    ]
  }
*/
export const validateQuotationPayload = (body) => {
  if (!body || typeof body !== "object") throw new Error("Request body is required");

  if (body.notes !== undefined && typeof body.notes !== "string") {
    throw new Error("notes must be a string");
  }

  const { products } = body;
  if (!Array.isArray(products) || products.length === 0) {
    throw new Error("At least one product must be selected");
  }

  const seenProducts = new Set();
  products.forEach((product, idx) => {
    const where = `Product ${idx + 1}`;
    if (!product || typeof product !== "object") throw new Error(`${where}: invalid entry`);
    if (!isNonEmptyString(product.productDefinitionId)) {
      throw new Error(`${where}: productDefinitionId is required`);
    }
    if (seenProducts.has(product.productDefinitionId)) {
      throw new Error(`${where}: the same product is listed twice`);
    }
    seenProducts.add(product.productDefinitionId);

    if (!Number.isInteger(product.quantity) || product.quantity < 1) {
      throw new Error(`${where}: quantity must be a whole number of at least 1`);
    }

    if (!Array.isArray(product.offers) || product.offers.length === 0) {
      throw new Error(`${where}: select at least one vendor`);
    }
    const seenVendors = new Set();
    product.offers.forEach((offer, j) => {
      const at = `${where}, vendor ${j + 1}`;
      if (!offer || typeof offer !== "object") throw new Error(`${at}: invalid entry`);
      if (!isNonEmptyString(offer.vendorId)) throw new Error(`${at}: vendorId is required`);
      if (seenVendors.has(offer.vendorId)) throw new Error(`${at}: the same vendor is listed twice`);
      seenVendors.add(offer.vendorId);
      if (!isPositiveNumber(offer.unitPrice)) throw new Error(`${at}: price must be greater than 0`);
      // Optional — absent/null means "the vendor's own warranty".
      if (offer.warrantyMonths !== undefined && offer.warrantyMonths !== null) {
        assertWarrantyMonths(offer.warrantyMonths, `${at}: warrantyMonths`);
      }
    });
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
  assertObjectId(body.sourceQuotationId, "sourceQuotationId");
  assertObjectId(body.vendorId, "vendorId");
  if (!Array.isArray(body.quotationItemIds) || body.quotationItemIds.length === 0)
    throw new Error("Select at least one item for the PO");
  body.quotationItemIds.forEach((id, i) => assertObjectId(id, `Item ${i + 1}`));
  if (body.termsConditionId !== undefined && body.termsConditionId !== null && body.termsConditionId !== "")
    assertObjectId(body.termsConditionId, "termsConditionId");
  assertPickedDate(body.poDate, "PO date");
  // buyerEntity is no longer sent by the client — createPurchaseOrder derives
  // it server-side from the Tracking Order (see StockPurchaseOrderService).
  // requester is no longer sent by the client either — createPurchaseOrder
  // stamps it from the authenticated session (see StockPurchaseOrderService).
  // skippedItems is gone. Leaving a line out of a PO is now a decision taken
  // (and reversible) on the tracking order via "Revise Order", not something
  // the PO create call records as a side effect on the approved quotation.
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

/*
  Only the id is checked, because only the id is used. addEntity reads the
  entity's name, GST number, address and state back from the ERP's own list —
  see StockInternalEntityService — so validating the other posted fields would
  be validating data the server then throws away.
*/
export const validateAddEntity = (body) => {
  assertObjectId(body?.entityId, "Entity");
};

/*
  Body for "Not Required" on the Tracking Orders page.

  excludedItemIds is the COMPLETE list of lines to leave out, not a delta, so
  an empty array is legitimate — that is how a line gets put back. The reason
  is still required for it, because "why did this order change" is the question
  the register exists to answer, and restoring a line is a change too.
*/
export const validateResetOrder = (body) => {
  if (!body || typeof body !== "object") throw new Error("Request body is required");
  if (!body.reason || !String(body.reason).trim()) throw new Error("A reason is required");
};

/*
  Short close and reopen both turn on one thing: WHY. Nothing else is sent —
  the order is identified by the URL and every quantity is read from the
  invoices server-side, so a reason is the whole body.
*/
/*
  Moving the payment clock. Only the date is accepted here — the window it has
  to fall inside is relative to the invoice, so that check belongs in the
  service where the invoice is loaded, not in a body validator.
*/
/*
  The rows an adjustment carries, shared by create and update.

  Only the SHAPE is checked here. What is actually claimable — which units are
  still in stock, whether the amount fits inside the payable — needs the
  invoice and lives in the service.

  No total is ever accepted: the server adds up what was picked. A total sent
  by a client is a total a client can edit.
*/
const assertAdjustmentRows = (body) => {
  if (body.lines !== undefined) {
    if (!Array.isArray(body.lines)) throw new Error("lines must be an array");
    body.lines.forEach((l, i) => {
      assertObjectId(l?.quotationItemId, `Line ${i + 1} product`);
      if (l.inventoryItemIds !== undefined) {
        if (!Array.isArray(l.inventoryItemIds)) throw new Error(`Line ${i + 1}: inventoryItemIds must be an array`);
        l.inventoryItemIds.forEach((id, k) => assertObjectId(id, `Line ${i + 1} unit ${k + 1}`));
      }
      if (l.quantity !== undefined && (Number.isNaN(Number(l.quantity)) || Number(l.quantity) < 0)) {
        throw new Error(`Line ${i + 1}: quantity must be 0 or more`);
      }
    });
  }

  if (body.extras !== undefined) {
    if (!Array.isArray(body.extras)) throw new Error("extras must be an array");
    body.extras.forEach((e, i) => {
      const amt = Number(e?.amount);
      if (Number.isNaN(amt) || amt < 0) throw new Error(`Extra row ${i + 1}: amount must be 0 or more`);
    });
  }

};

export const validateCreateAdjustment = (body) => {
  if (!body || typeof body !== "object") throw new Error("Request body is required");
  if (!ADJUSTMENT_TYPE_ARRAY.includes(body.type)) {
    throw new Error(`type must be one of: ${ADJUSTMENT_TYPE_ARRAY.join(", ")}`);
  }
  if (!body.reason || !String(body.reason).trim()) throw new Error("A reason is required");
  assertAdjustmentRows(body);

  // MISC has no items to claim against, so an amount row is the only thing
  // that can carry it. Caught here rather than as a bare "amount must be
  // greater than 0" after the service has done its work.
  if (body.type === "MISC" && !(body.extras || []).some((e) => Number(e?.amount) > 0)) {
    throw new Error("A misc charge needs at least one amount row");
  }
};

/*
  Editing one. Same shape as a create minus the type, which cannot change: a
  credit note does not become a misc charge, it gets withdrawn and a misc
  charge raised instead.
*/
export const validateUpdateAdjustment = (body) => {
  if (!body || typeof body !== "object") throw new Error("Request body is required");
  if (body.type !== undefined) throw new Error("An adjustment's type cannot be changed");
  assertAdjustmentRows(body);
};

/*
  The approval team's verdict.

  A rejection needs a reason; an approval does not. Rejecting means "something
  on this is wrong", and the person who has to fix it cannot act on silence.
*/
export const validatePaymentApprovalDecision = (body) => {
  if (!body || typeof body !== "object") throw new Error("Request body is required");
  if (!["APPROVED", "REJECTED"].includes(body.decision)) {
    throw new Error("decision must be APPROVED or REJECTED");
  }
  if (body.decision === "REJECTED" && !String(body.reason || "").trim()) {
    throw new Error("A reason is required to reject a payment approval");
  }
};

/*
  Recording a payment, in however many splits it arrived in.

  Arrives as multipart (the proof files ride along), so the JSON half comes in
  as a `data` string the controller parses before this sees it.

  remarks is deliberately OPTIONAL: accounts enter these in bulk and a
  mandatory note on a plain NEFT transfer becomes a field people fill with a
  full stop, which is worse than an empty one.

  Whether the total fits inside the balance needs the invoice, so that check
  lives in the service.
*/
export const validateRecordPayment = (body) => {
  if (!body || typeof body !== "object") throw new Error("Request body is required");

  if (!body.paidOn) throw new Error("A payment date is required");
  if (Number.isNaN(new Date(body.paidOn).getTime())) throw new Error("Invalid payment date");
  // A payment cannot have left in the future.
  if (new Date(body.paidOn) > new Date()) throw new Error("A payment date cannot be in the future");

  if (!Array.isArray(body.splits) || body.splits.length === 0) {
    throw new Error("At least one payment split is required");
  }
  body.splits.forEach((s, i) => {
    const amount = Number(s?.amount);
    if (Number.isNaN(amount) || amount <= 0) {
      throw new Error(`Split ${i + 1}: an amount greater than 0 is required`);
    }
    if (!PAYMENT_MODE_ARRAY.includes(s?.mode)) {
      throw new Error(`Split ${i + 1}: mode must be one of ${PAYMENT_MODE_ARRAY.join(", ")}`);
    }
  });

  /*
    The entered total has to match what the splits add up to.

    Checked because the screen shows both, and a form that saves a different
    figure from the one on screen is the kind of bug nobody finds until a bank
    statement will not reconcile.
  */
  if (body.total !== undefined) {
    const total = Number(body.total);
    const sum = body.splits.reduce((s, x) => s + (Number(x?.amount) || 0), 0);
    if (Math.abs(total - sum) > 0.01) {
      throw new Error(`The splits add up to ${sum}, which does not match the total of ${total}`);
    }
  }

  if (body.stateOverride !== undefined && body.stateOverride !== null) {
    if (!["PAID", "PARTIAL"].includes(body.stateOverride)) {
      throw new Error("A payment state can only be forced to Paid or Partial");
    }
  }
};

/*
  Scheduling a payment. Only the shape is checked here.

  `onDueDate: true` clears any override and needs no date with it — that is how
  a schedule is undone rather than merely moved again.

  Whether a date is ALLOWED — not in the past, and the invoice neither already
  payable nor in the approval flow — needs the invoice, so those checks live in
  the service where it is loaded rather than in a body validator.
*/
export const validateSchedulePayment = (body) => {
  if (!body || typeof body !== "object") throw new Error("Request body is required");
  if (body.onDueDate) return;
  if (!body.scheduledOn) throw new Error("A schedule date is required");
  if (Number.isNaN(new Date(body.scheduledOn).getTime())) {
    throw new Error("Invalid schedule date");
  }
};

export const validateClosureDecision = (body) => {
  if (!body || typeof body !== "object") throw new Error("Request body is required");
  if (!body.reason || !String(body.reason).trim()) throw new Error("A reason is required");
};

export const validateSetExclusions = (body) => {
  if (!body || typeof body !== "object") throw new Error("Request body is required");
  if (!body.reason || !String(body.reason).trim()) throw new Error("A reason is required");
  if (body.excludedItemIds !== undefined && !Array.isArray(body.excludedItemIds)) {
    throw new Error("excludedItemIds must be an array");
  }
  (body.excludedItemIds || []).forEach((id, i) => assertObjectId(id, `Line ${i + 1}`));
};

// ─── Branch Validators ─────────────────────────────────────────────────────

// The client picks the state from the shared Indian-state list and fills the
// GST state code from that same entry, so the two always travel together: a
// state with no code (or a code with no state) means the payload was hand-built
// rather than picked, and would break any later CGST/IGST comparison.
const assertBranchState = (state, stateCode) => {
  const hasState = state !== undefined && state !== null && String(state).trim() !== "";
  const hasCode = stateCode !== undefined && stateCode !== null && String(stateCode).trim() !== "";

  if (hasCode && !/^[0-9]{2}$/.test(String(stateCode).trim()))
    throw new Error("Invalid state code — it must be the 2-digit GST state code");
  if (hasState && !hasCode) throw new Error("State code is required when a state is selected");
  if (hasCode && !hasState) throw new Error("State is required when a state code is given");
};

export const validateCreateBranch = (body) => {
  const { name, code, state, stateCode, branchRole } = body || {};
  if (!name || !String(name).trim()) throw new Error("name is required");
  if (!code || !String(code).trim()) throw new Error("code is required");
  assertBranchState(state, stateCode);
  if (branchRole !== undefined && branchRole !== null && !BRANCH_ROLE_ARRAY.includes(branchRole))
    throw new Error(`branchRole must be one of: ${BRANCH_ROLE_ARRAY.join(", ")}`);
};

export const validateUpdateBranch = (body) => {
  const { name, code, state, stateCode, branchRole } = body || {};
  if (name !== undefined && !String(name).trim()) throw new Error("name cannot be empty");
  if (code !== undefined && !String(code).trim()) throw new Error("code cannot be empty");
  // The pair is checked only when at least one half is sent — an update that
  // touches neither must not trip the "both or neither" rule.
  if (state !== undefined || stateCode !== undefined) assertBranchState(state, stateCode);
  if (branchRole !== undefined && branchRole !== null && !BRANCH_ROLE_ARRAY.includes(branchRole))
    throw new Error(`branchRole must be one of: ${BRANCH_ROLE_ARRAY.join(", ")}`);
};

// ─── GST Rate Validators ─────────────────────────────────────────────────────

// Shape only, as everywhere else here: that the slab is not a duplicate needs
// the collection, so that half lives in StockGstRateService.
const assertGstRateValue = (rate) => {
  if (rate === undefined || rate === null || rate === "") throw new Error("rate is required");
  const num = Number(rate);
  if (!Number.isFinite(num)) throw new Error("rate must be a number");
  if (num < 0 || num > 100) throw new Error("rate must be between 0 and 100");
};

export const validateCreateGstRate = (body) => {
  const { rate, order } = body || {};
  assertGstRateValue(rate);
  if (order !== undefined && order !== null && order !== "" && !Number.isFinite(Number(order)))
    throw new Error("order must be a number");
};

export const validateUpdateGstRate = (body) => {
  const { rate, order } = body || {};
  if (rate !== undefined) assertGstRateValue(rate);
  if (order !== undefined && order !== null && order !== "" && !Number.isFinite(Number(order)))
    throw new Error("order must be a number");
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
// Add Invoice saves what the vendor's invoice says (number, date, quantities);
// Add Items then enters the actual units against it, draft by draft.

const validateExtraCharges = (extraCharges) => {
  if (extraCharges === undefined) return;
  if (!Array.isArray(extraCharges)) throw new Error("extraCharges must be an array");
  extraCharges.forEach((c, idx) => {
    // Required on every charge, billed or note-only — a charge with no
    // amount says nothing a plain invoice note couldn't.
    if (typeof c.amount !== "number" || !Number.isFinite(c.amount) || c.amount <= 0) {
      throw new Error(`Extra charge ${idx + 1}: amount is required and must be greater than 0`);
    }
    if (c.includeInBilling !== undefined && typeof c.includeInBilling !== "boolean") {
      throw new Error(`Extra charge ${idx + 1}: includeInBilling must be true or false`);
    }
  });
};

const validateInvoiceLines = (lines) => {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("Enter the invoice quantity for at least one product");
  }
  lines.forEach((line, idx) => {
    const where = `Line ${idx + 1}`;
    if (!isNonEmptyString(line.quotationItemId)) throw new Error(`${where}: quotationItemId is required`);
    if (!isNonNegativeNumber(line.invoiceQuantity)) {
      throw new Error(`${where}: invoice quantity must be 0 or greater`);
    }
  });
};

// Every field optional on an edit — only what is sent changes.
export const validateUpdateInvoice = (body) => {
  if (!body || typeof body !== "object") throw new Error("Request body is required");
  if (body.invoiceNumber !== undefined && !String(body.invoiceNumber).trim()) {
    throw new Error("Invoice number is required");
  }
  if (body.invoiceDate !== undefined && Number.isNaN(new Date(body.invoiceDate).getTime())) {
    throw new Error("Invoice date is not a valid date");
  }
  if (body.invoiceAmount !== undefined && !isNonNegativeNumber(Number(body.invoiceAmount))) {
    throw new Error("Invoice amount must be 0 or greater");
  }
  if (body.lines !== undefined) validateInvoiceLines(body.lines);
  validateExtraCharges(body.extraCharges);
  if (body.notes !== undefined && typeof body.notes !== "string") throw new Error("Notes must be text");
};

export const validateCreateInvoice = (body) => {
  if (!body || typeof body !== "object") throw new Error("Request body is required");
  if (!body.invoiceNumber || !String(body.invoiceNumber).trim()) throw new Error("Invoice number is required");
  if (!body.invoiceDate) throw new Error("Invoice date is required");
  // The branch is the invoice's branch — the service checks it is one the
  // receiver may use; here we only insist it was sent at all.
  if (!isNonEmptyString(body.branchId)) throw new Error("Receiving branch is required");
  validateUpdateInvoice(body);
  validateInvoiceLines(body.lines);
};

// Add Items — what has been entered so far (draft) or in full (submit).
export const validateSaveItems = (body) => {
  if (!body || typeof body !== "object") throw new Error("Request body is required");
  if (body.entryId !== undefined && body.entryId !== null && !isNonEmptyString(body.entryId)) {
    throw new Error("entryId must be an id");
  }
  if (!Array.isArray(body.lines)) throw new Error("lines must be an array");
  body.lines.forEach((line, idx) => {
    const where = `Line ${idx + 1}`;
    if (!isNonEmptyString(line.quotationItemId)) throw new Error(`${where}: quotationItemId is required`);
    if (!isNonNegativeNumber(line.receivedQuantity)) throw new Error(`${where}: quantity must be 0 or greater`);
    if (line.focQuantity !== undefined && !isNonNegativeNumber(line.focQuantity)) {
      throw new Error(`${where}: FOC quantity must be 0 or greater`);
    }
    if (line.rows !== undefined && !Array.isArray(line.rows)) throw new Error(`${where}: rows must be an array`);
    if (line.rating !== undefined && line.rating !== null) {
      const r = line.rating.rating;
      if (r !== undefined && r !== null && (typeof r !== "number" || r < 0 || r > 5)) {
        throw new Error(`${where}: rating must be between 0 and 5`);
      }
    }
  });
};

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
    // A list now: a vendor may have several contacts marked To. A bare
    // string is still accepted so an older caller keeps working.
    const toList = (Array.isArray(to) ? to : [to])
      .map((t) => String(t || '').trim())
      .filter(Boolean);
    if (!toList.length) {
      // Says what to DO about it: the recipient list is configured on the
      // vendor, not typed here, so 'a To email is required' would leave the
      // user with nowhere to enter one.
      throw new Error(
        "This vendor has no contact marked To. Edit the vendor and set at least one contact’s Recipient Type to To."
      );
    }
    toList.forEach((t) => {
      if (!isValidEmail(t)) throw new Error('Invalid To email: ' + t);
    });
    if (cc !== undefined) {
      if (!Array.isArray(cc)) throw new Error("cc must be an array");
      cc.forEach((e) => {
        if (!isValidEmail(e)) throw new Error(`Invalid CC email: ${e}`);
      });
    }
  }
};