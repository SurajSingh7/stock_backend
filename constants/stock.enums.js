export const INPUT_TYPES = {
  TEXT: "text",
  TEXTAREA: "textarea",
  NUMBER: "number",
  DECIMAL: "decimal",
  DROPDOWN: "dropdown",
  MULTI_SELECT: "multi_select",
  DATE: "date",
  DATETIME: "datetime",
  BOOLEAN: "boolean",
  COLOR: "color",
};

export const INPUT_TYPES_ARRAY = Object.values(INPUT_TYPES);

export const TRACKING_METHODS = {
  INDIVIDUAL: "individual",
  QUANTITY: "quantity",
};

export const TRACKING_METHODS_ARRAY = Object.values(TRACKING_METHODS);

// Inventory-item physical status (NOT quotations).
export const ITEM_STATUS = {
  AVAILABLE: "AVAILABLE",
  ALLOCATED: "ALLOCATED",
  IN_REPAIR: "IN_REPAIR",
  SCRAPPED: "SCRAPPED",
  IN_TRANSIT: "IN_TRANSIT",
};

export const ITEM_STATUS_ARRAY = Object.values(ITEM_STATUS);

export const CATEGORY_TYPES = {
  GROUP: "GROUP",
  LEAF: "LEAF",
};

export const CATEGORY_TYPES_ARRAY = Object.values(CATEGORY_TYPES);

export const PRODUCT_DEF_STATUS = {
  ACTIVE: "ACTIVE",
  DRAFT: "DRAFT",
};

export const PRODUCT_DEF_STATUS_ARRAY = Object.values(PRODUCT_DEF_STATUS);

export const UNIT_TYPES = {
  PIECES: "pieces",
  METER: "meter",
  KG: "kg",
  BOX: "box",
  LITRE: "litre",
  DOZEN: "dozen",
};

export const UNIT_TYPES_ARRAY = Object.values(UNIT_TYPES);
export const GST_RATES_ARRAY = ["0", "5", "12", "18", "28"];

// ─── Quotation status ─────────────────────────────────────────────────────────
// DERIVED from categoryApprovals[] and re-stored on review:
//   no decisions yet                 -> PENDING
//   every category APPROVED          -> APPROVED
//   every category REJECTED          -> REJECTED
//   a mix of APPROVED + REJECTED     -> PARTIALLY_APPROVED
export const QUOTATION_STATUS = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  PARTIALLY_APPROVED: "PARTIALLY_APPROVED",
  REJECTED: "REJECTED",
};

export const QUOTATION_STATUS_ARRAY = Object.values(QUOTATION_STATUS);

// Per-CATEGORY decision (stored in quotation.categoryApprovals[].status).
export const CATEGORY_APPROVAL_STATUS = {
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
};

export const CATEGORY_APPROVAL_STATUS_ARRAY = Object.values(CATEGORY_APPROVAL_STATUS);

// Placeholder shown when a snapshot has no source yet (no history / no reviews).
export const EMPTY_SNAPSHOT_DISPLAY = "-";


// ─── Purchase Order — ADD these to constants/stock.enums.js ───────────────────
 
export const PO_STATUS = {
  GENERATED: "GENERATED",   // form submitted + PDF made, review pending ("PO Created")
  APPROVED: "APPROVED",     // PO reviewed OK, ready to email (future SENT)
  REJECTED: "REJECTED",     // sent back → edit → regenerate
  SENT: "SENT",             // future — emailed to vendor
};
export const PO_STATUS_ARRAY = Object.values(PO_STATUS);
 
// GST split mode — derived from buyer entity state vs vendor state.
export const PO_TAX_TYPE = {
  CGST_SGST: "CGST_SGST",   // same state
  IGST: "IGST",             // different state
};
 
// Frontend-only enum for the shipment dropdown (future: more, or API-driven).
export const SHIPMENT_PREFERENCE_OPTIONS = [
  "Self Pickup",
  "Vendor Delivery",
  "Courier",
  "Transport",
  "Third-Party Logistics",
  "Hand Delivery",
];

// ─── Terms & Conditions master ─────────────────────────────────────────────
export const TERMS_STATUS = {
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
};
export const TERMS_STATUS_ARRAY = Object.values(TERMS_STATUS);

// Where a PO's terms snapshot came from at create time — a vendor-specific
// term, the single Default term, or (nothing configured yet) none.
export const TERMS_SOURCE = {
  VENDOR: "VENDOR",
  DEFAULT: "DEFAULT",
  MANUAL: "MANUAL",
  NONE: "NONE",
};
export const TERMS_SOURCE_ARRAY = Object.values(TERMS_SOURCE);

// ─── Tracking Orders — per (quotation, vendor) lifecycle ───────────────────
// One doc per vendor-row created when a quotation is Approved/Partially
// Approved. This is the source of truth for Entity/State + the overall
// workflow stage shown on both the Tracking Orders and PO Approval pages.
export const TRACKING_STATUS = {
  ENTITY_PENDING: "ENTITY_PENDING",     // just created — entity/state not yet assigned
  PO_PENDING: "PO_PENDING",             // entity assigned — ready for PO creation
  PO_GENERATED: "PO_GENERATED",         // PO created (mirrors PO_STATUS.GENERATED)
  PO_APPROVED: "PO_APPROVED",           // PO approved (mirrors PO_STATUS.APPROVED)
  MATERIAL_PENDING: "MATERIAL_PENDING", // mail sent or marked manual — final stage here
  REJECTED: "REJECTED",                 // PO rejected (mirrors PO_STATUS.REJECTED)
  NOT_REQUIRED: "NOT_REQUIRED",         // vendor marked "Not Required"
};
export const TRACKING_STATUS_ARRAY = Object.values(TRACKING_STATUS);

// How the PO ended up in MATERIAL_PENDING — actually emailed, or handled
// outside the system. Stored on the tracking order for the Action-column
// "Mail Sent"/"Manual" badge.
export const MAIL_MODE = { SENT: "SENT", MANUAL: "MANUAL" };
export const MAIL_MODE_ARRAY = Object.values(MAIL_MODE);

// ─── Notification master ───────────────────────────────────────────────────
export const NOTIFICATION_CHANNEL = {
  EMAIL: "EMAIL",
  WHATSAPP: "WHATSAPP",
  SMS: "SMS",
  SLACK: "SLACK",
};
export const NOTIFICATION_CHANNEL_ARRAY = Object.values(NOTIFICATION_CHANNEL);
