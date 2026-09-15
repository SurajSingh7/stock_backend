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

// Only two units exist. Unit and trackingMethod are independent — the
// client picks both explicitly (e.g. Group+Pieces for bottles, Individual+
// Meter for a serialized cable reel are both valid). Never derive one from
// the other.
export const UNIT_TYPES = {
  PIECES: "pieces",
  METER: "meter",
};

export const UNIT_TYPES_ARRAY = Object.values(UNIT_TYPES);

// GST_RATES_ARRAY used to live here. It is now the `gstrates` collection —
// see models/stock.gst.rate.model.js for why a hardcoded slab list was the
// wrong shape, and seeders/stock.gst.rate.seeder.js for the starting rows.

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
  APPROVED: "APPROVED",     // reviewed OK and handed to the vendor — terminal
  REJECTED: "REJECTED",     // sent back → edit → regenerate
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
  PO_APPROVED: "PO_APPROVED",           // PO approved + mailed (mirrors PO_STATUS.APPROVED)
  IN_PROGRESS: "IN_PROGRESS",           // an invoice submitted, none approved yet
  PARTIAL: "PARTIAL",                   // >=1 invoice approved, 0 < received < ordered
  COMPLETED: "COMPLETED",               // received == ordered on every PO line
  REJECTED: "REJECTED",                 // PO rejected (mirrors PO_STATUS.REJECTED)
  NOT_REQUIRED: "NOT_REQUIRED",         // vendor marked "Not Required"
};
export const TRACKING_STATUS_ARRAY = Object.values(TRACKING_STATUS);


// ─── Invoice (goods receiving) — ADD to constants/stock.enums.js ──────────────
export const INVOICE_STATUS = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
};
export const INVOICE_STATUS_ARRAY = Object.values(INVOICE_STATUS);

// Approval state of a received inventory item — independent of its physical
// ITEM_STATUS. Only APPROVED items count toward "available quantity".
export const ITEM_APPROVAL_STATUS = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
};
export const ITEM_APPROVAL_STATUS_ARRAY = Object.values(ITEM_APPROVAL_STATUS);

// ─── Branch role ──────────────────────────────────────────────────────────
// Descriptive only (reporting/filtering) — does not restrict which branches
// can transfer with which. Any branch can send/receive stock to/from any
// other, regardless of role.
export const BRANCH_ROLE = {
  CENTRAL: "CENTRAL",
  REGIONAL: "REGIONAL",
  NORMAL: "NORMAL",
};
export const BRANCH_ROLE_ARRAY = Object.values(BRANCH_ROLE);

// ─── Inventory Transfer Request — one-shot request/fulfil workflow ─────────
// A request is PENDING until the source branch acts on it exactly once:
//   - process (full or partial transfer) -> COMPLETED, any shortfall auto-closed
//   - reject (nothing transferred)       -> REJECTED
// There is no further action once a request leaves PENDING — a still-needed
// remainder must be raised as a brand-new request.
export const TRANSFER_REQUEST_STATUS = {
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
  REJECTED: "REJECTED",
};
export const TRANSFER_REQUEST_STATUS_ARRAY = Object.values(TRANSFER_REQUEST_STATUS);

export const CONSUMPTION_REF_TYPE = {
  PROJECT: "PROJECT",
  JOB: "JOB",
  WORK_ORDER: "WORK_ORDER",
};
export const CONSUMPTION_REF_TYPE_ARRAY = Object.values(CONSUMPTION_REF_TYPE);

// How the PO reached the vendor — actually emailed, or handled outside the
// system. Stored on the tracking order for the "Mail Sent"/"Manual" badge, and
// it is what marks a PO as already sent now that there is no SENT status.
export const MAIL_MODE = { SENT: "SENT", MANUAL: "MANUAL" };
export const MAIL_MODE_ARRAY = Object.values(MAIL_MODE);

// ─── Data Access Control ────────────────────────────────────────────────────
// WHICH RECORDS a user may see and act on. Kept entirely separate from the
// action vocabulary above: actions answer "what may they do", these answer
// "to whose rows".
//
// Three independent dimensions (branch / entity / record ownership), each
// resolved from the user's global data-access row, optionally overridden per
// module. They combine with AND — a record must pass every dimension that
// applies to its model (see config/data.scope.registry.js).
export const DATA_SCOPE = {
  OWN: "OWN",           // resolved from an attribute on the user
  SELECTED: "SELECTED", // an explicit allow-list
  ALL: "ALL",           // unrestricted, and dynamically so
};
export const DATA_SCOPE_ARRAY = Object.values(DATA_SCOPE);

// Entity deliberately has no OWN: a user has no entity of their own the way
// they have a branch, and no such field exists on the HRMS Login. Access is
// always either an explicit list or everything.
export const ENTITY_SCOPE = {
  SELECTED: "SELECTED",
  ALL: "ALL",
};
export const ENTITY_SCOPE_ARRAY = Object.values(ENTITY_SCOPE);

// Base action vocabulary most modules grant as-is; a module can extend this
// with its own (e.g. purchase-orders adds APPROVE/REJECT/SEND_MAIL) — see
// each entry in seeders/stock.module.seeder.js.
export const STANDARD_ACTIONS = ["CREATE", "READ", "UPDATE", "DELETE", "RESTORE"];

// ─── Notification master ───────────────────────────────────────────────────
// Which line of an outgoing vendor mail a contact belongs on. Held per
// contact, not per vendor, so one vendor can have a buyer on To and their
// accounts desk on CC.
// Whether this module appears in the navigation, held as an action so it
// flows through the same role -> department -> user-override stack every
// other permission does. Deliberately separate from READ: a user can need a
// module's data on other screens (filters, dropdowns) while having no reason
// to open its management page from the menu.
export const VIEW_MENU_ACTION = "VIEW_MENU";

export const CONTACT_RECIPIENT_TYPE = { TO: "TO", CC: "CC", NONE: "NONE" };
export const CONTACT_RECIPIENT_TYPE_ARRAY = Object.values(CONTACT_RECIPIENT_TYPE);

export const NOTIFICATION_CHANNEL = {
  EMAIL: "EMAIL",
  WHATSAPP: "WHATSAPP",
  SMS: "SMS",
  SLACK: "SLACK",
};
export const NOTIFICATION_CHANNEL_ARRAY = Object.values(NOTIFICATION_CHANNEL);
