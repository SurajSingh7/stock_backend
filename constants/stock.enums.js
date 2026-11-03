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
  /*
    Out of the store, with the person on `assignedTo` — a subscriber (issued
    against an Item Request) or an employee (Employee Items), or entered as
    already with them (Opening Issued Stock). Set only by those flows, never
    by hand. Replaced the never-used ALLOCATED
    (scripts/rename-allocated-to-assigned.js).
  */
  ASSIGNED: "ASSIGNED",
  IN_REPAIR: "IN_REPAIR",
  SCRAPPED: "SCRAPPED",
  IN_TRANSIT: "IN_TRANSIT",
  /*
    Came in, was accepted into stock, was found defective — and a debit note
    took the money for it back off the invoice. The unit goes back to the
    vendor; it is no longer ours.

    Set only by accepting a DEBIT_NOTE adjustment, in the same transaction, so
    the books and the shelf never disagree. Without it a debited item would
    sit in stock as AVAILABLE: not paid for, but still transferable — which is
    exactly the mismatch nobody notices until an audit.

    Named for what happened to the MONEY, not for the unit's condition, and
    deliberately kept apart from a unit of ours that breaks in use (which we
    paid for and may repair or claim under warranty). One status for both
    would let the same unit be recovered twice — once by the debit note, again
    by a warranty claim. This used to be called FAULTY; see
    scripts/rename-faulty-to-debited.js.
  */
  DEBITED: "DEBITED",
  /*
    One of OURS that is broken — came back from a subscriber in bad condition
    (or replaced on site). Paid for, so it is still an asset: it goes on to be
    repaired, claimed under warranty, or scrapped. Never confuse with DEBITED,
    where the money was already recovered from the vendor.
  */
  FAULTY: "FAULTY",
  /*
    Sent back to its vendor on a warranty claim (IN_REPAIR is our own repair).
    Comes back repaired (AVAILABLE), is swapped for a new unit
    (VENDOR_REPLACED), or the claim is refused (FAULTY again).
  */
  AT_VENDOR: "AT_VENDOR",
  /*
    The vendor kept this unit and sent another in its place — terminal. The
    new unit is its own inventory item (source VENDOR_REPLACEMENT) pointing
    back here; this one stays on record so the chain can be followed.
  */
  VENDOR_REPLACED: "VENDOR_REPLACED",
};

export const ITEM_STATUS_ARRAY = Object.values(ITEM_STATUS);

// Where a FAULTY unit has gone to be fixed.
export const REPAIR_KIND = {
  INTERNAL: "INTERNAL", // our own technicians — IN_REPAIR
  VENDOR: "VENDOR",     // warranty claim — AT_VENDOR
};
export const REPAIR_KIND_ARRAY = Object.values(REPAIR_KIND);

// How a unit came back from a subscriber — decides AVAILABLE or FAULTY.
export const RETURN_CONDITION = {
  GOOD: "GOOD",
  FAULTY: "FAULTY",
};
export const RETURN_CONDITION_ARRAY = Object.values(RETURN_CONDITION);

/*
  Where a unit FIRST entered the system — set once at creation, never changed.
  A unit coming back from an employee or a transfer is the same unit with the
  same origin; only its movements say where it has been since. VENDOR_REPLACEMENT
  (a unit sent by the vendor against a faulty one) arrives with the
  replacement phase.
*/
export const ITEM_SOURCE = {
  PURCHASE: "PURCHASE",
  OPENING_STOCK: "OPENING_STOCK",
  // Sent by a vendor against a warranty claim, in place of a faulty unit.
  VENDOR_REPLACEMENT: "VENDOR_REPLACEMENT",
};
export const ITEM_SOURCE_ARRAY = Object.values(ITEM_SOURCE);

// The unit's physical condition. A unit becomes USED the first time someone
// is given it, and never goes back to NEW.
export const ITEM_CONDITION = {
  NEW: "NEW",
  USED: "USED",
};
export const ITEM_CONDITION_ARRAY = Object.values(ITEM_CONDITION);

/*
  One row in a unit's timeline (inventory_item_movements). Append-only.
  Assignment/return/repair/replacement add their own types in later phases.
*/
export const ITEM_MOVEMENT_TYPE = {
  RECEIVED: "RECEIVED",
  TRANSFERRED: "TRANSFERRED",
  // Handed to a subscriber against an Item Request.
  ISSUED: "ISSUED",
  // Came back from a subscriber (Return, or the old unit of a Replace).
  RETURNED: "RETURNED",
  // Faulty handling (Repair & Warranty).
  REPORTED_FAULTY: "REPORTED_FAULTY",
  SENT_FOR_REPAIR: "SENT_FOR_REPAIR",
  REPAIRED: "REPAIRED",
  REPAIR_FAILED: "REPAIR_FAILED",
  CLAIM_SENT: "CLAIM_SENT",
  CLAIM_RETURNED: "CLAIM_RETURNED",
  CLAIM_REJECTED: "CLAIM_REJECTED",
  VENDOR_REPLACED: "VENDOR_REPLACED",
  MARKED_OK: "MARKED_OK",
  SCRAPPED: "SCRAPPED",
  // Given to one of our employees (Employee Items).
  ASSIGNED: "ASSIGNED",
};

// Who an ASSIGNED unit is with: a customer (via an Item Request) or one of our
// own people (Employee Items).
export const ASSIGNEE_KIND = {
  SUBSCRIBER: "SUBSCRIBER",
  EMPLOYEE: "EMPLOYEE",
};
export const ASSIGNEE_KIND_ARRAY = Object.values(ASSIGNEE_KIND);
export const ITEM_MOVEMENT_TYPE_ARRAY = Object.values(ITEM_MOVEMENT_TYPE);

// The document a movement happened on.
export const ITEM_MOVEMENT_REF = {
  INVOICE: "INVOICE",
  OPENING_STOCK: "OPENING_STOCK",
  TRANSFER_REQUEST: "TRANSFER_REQUEST",
  ITEM_REQUEST: "ITEM_REQUEST",
  // A warranty claim with a vendor — refNumber is the vendor's docket / RMA no.
  WARRANTY_CLAIM: "WARRANTY_CLAIM",
};
export const ITEM_MOVEMENT_REF_ARRAY = Object.values(ITEM_MOVEMENT_REF);

/*
  Item Request — a subscriber's order (from the NOC / broadband website):
    ISSUE   up to 20 lines, each a leaf category and a quantity; the store
            picks the product(s) for each
    RETURN  units / quantities the subscriber holds, coming back to the store
    REPLACE units coming back, and as many of each one's category going out
            in their place (one outgoing line per category) — both halves on
            one request
*/
export const ITEM_REQUEST_TYPE = {
  ISSUE: "ISSUE",
  RETURN: "RETURN",
  REPLACE: "REPLACE",
};
export const ITEM_REQUEST_TYPE_ARRAY = Object.values(ITEM_REQUEST_TYPE);

/*
    PENDING ──issue──► PARTIAL ──issue──► COMPLETED
       │                  └──short close──► PARTIALLY_CLOSED
       └──reject──► REJECTED ──requester edits & resends──► PENDING
                       └──requester withdraws──► WITHDRAWN (final)

  Worked out from the lines (ITEM_REQUEST_LINE_STATUS): once every line is
  done or closed (and, for a return, everything is back) the request is
  COMPLETED — or PARTIALLY_CLOSED if any line was closed short. The store
  decides everything except the resend and the withdraw. The requester cannot
  cancel an open request — only withdraw a REJECTED one it no longer wants
  (until then its categories stay blocked for that subscriber and branch, so
  it is resent rather than asked for afresh). Needing more after a close is a
  new request.
*/
export const ITEM_REQUEST_STATUS = {
  PENDING: "PENDING",
  PARTIAL: "PARTIAL",
  COMPLETED: "COMPLETED",
  PARTIALLY_CLOSED: "PARTIALLY_CLOSED",
  REJECTED: "REJECTED",
  WITHDRAWN: "WITHDRAWN",
};
export const ITEM_REQUEST_STATUS_ARRAY = Object.values(ITEM_REQUEST_STATUS);

/*
  One outgoing line of a request — derived, never stored:
    PENDING   nothing given yet        PARTIAL  some given
    DONE      all given                CLOSED   closed short by the store
*/
export const ITEM_REQUEST_LINE_STATUS = {
  PENDING: "PENDING",
  PARTIAL: "PARTIAL",
  DONE: "DONE",
  CLOSED: "CLOSED",
};

/*
  Who raised the request. Each caller only ever sees and edits its own, and the
  test simulator's rows can be found and removed in one query once the real
  website is connected.
*/
export const ITEM_REQUEST_CHANNEL = {
  EXTERNAL_API: "EXTERNAL_API",
  TEST_SIMULATOR: "TEST_SIMULATOR",
};
export const ITEM_REQUEST_CHANNEL_ARRAY = Object.values(ITEM_REQUEST_CHANNEL);

/*
  Opening Stock Entry — stock that was already on hand before this system.
  DRAFT -> POSTED (posting creates the inventory items). Approval is not wanted
  yet; when it is, PENDING_APPROVAL slots in between and POST becomes SUBMIT +
  APPROVE — nothing already POSTED needs to change.
*/
export const OPENING_STOCK_STATUS = {
  DRAFT: "DRAFT",
  POSTED: "POSTED",
};
export const OPENING_STOCK_STATUS_ARRAY = Object.values(OPENING_STOCK_STATUS);

/*
  Two kinds of opening entry, two screens:
    STORE   "Opening Stock" — what is physically in the store (number OS-…)
    ISSUED  "Opening Issued Stock" — what is already with one person, an
            employee or a subscriber picked from the People Directory; posting
            makes the units ASSIGNED to them (number OI-…)
*/
export const OPENING_STOCK_KIND = {
  STORE: "STORE",
  ISSUED: "ISSUED",
};
export const OPENING_STOCK_KIND_ARRAY = Object.values(OPENING_STOCK_KIND);

/*
  People Directory — who stock can be with. EXTERNAL: found through the
  people API (HRMS employees, website subscribers — one search); MANUAL: typed
  in here because the API does not have them (yet).
*/
export const PERSON_SOURCE = {
  EXTERNAL: "EXTERNAL",
  MANUAL: "MANUAL",
};
export const PERSON_SOURCE_ARRAY = Object.values(PERSON_SOURCE);

/*
  Whether an opening-stock unit works — separate from its condition (New/Used):
  a unit can be New and Faulty, or Used and Working.
    WORKING        → AVAILABLE
    FAULTY         → FAULTY, straight into Repair & Warranty
    BEYOND_REPAIR  → SCRAPPED — on record (serial, audit) but never stock again
*/
export const OPENING_STOCK_STATE = {
  WORKING: "WORKING",
  FAULTY: "FAULTY",
  BEYOND_REPAIR: "BEYOND_REPAIR",
};
export const OPENING_STOCK_STATE_ARRAY = Object.values(OPENING_STOCK_STATE);

// The same three states for anything coming BACK — from a subscriber or an
// employee — chosen by the store when it checks the unit, with its condition
// (New: unused, box/seal intact; Used) beside it.
export const WORKING_STATE = OPENING_STOCK_STATE;
export const WORKING_STATE_ARRAY = OPENING_STOCK_STATE_ARRAY;

/*
  Why the requester is giving something back — picked on the website with the
  request. OTHER needs a note.
*/
export const RETURN_REASON = {
  CONNECTION_CLOSED: "Connection Closed",
  SHIFTING: "Shifting / Relocation",
  SERVICE_CHANGE: "Service Change",
  NOT_NEEDED: "Not Needed / Extra",
  WRONG_ITEM: "Wrong Item Given",
  OTHER: "Other",
};
export const REPLACE_REASON = {
  NOT_WORKING: "Not Working",
  INTERMITTENT: "Intermittent Problem",
  DAMAGED: "Physically Damaged",
  OTHER: "Other",
};

export const CATEGORY_TYPES = {
  GROUP: "GROUP",
  LEAF: "LEAF",
};

export const CATEGORY_TYPES_ARRAY = Object.values(CATEGORY_TYPES);


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
  // Named for what has arrived, so the status reads on its own (2026-11-03;
  // were IN_PROGRESS / PARTIAL / FULLY_CLOSED / SHORT_CLOSED — see
  // scripts/rename-tracking-statuses.js).
  AWAITING_DELIVERY: "AWAITING_DELIVERY", // PO approved, nothing received (approved) yet
  PARTLY_RECEIVED: "PARTLY_RECEIVED",     // >=1 invoice approved, 0 < received < ordered
  // The two END states, named as a pair so a board reader sees at a glance
  // that both mean "nothing more is coming", and what the difference is.
  // FULLY_RECEIVED is reached on its own; CLOSED_SHORT is a person's
  // decision, taken from PARTLY_RECEIVED when the rest will never arrive.
  FULLY_RECEIVED: "FULLY_RECEIVED",       // received == ordered on every PO line
  CLOSED_SHORT: "CLOSED_SHORT",           // closed early with less than ordered — see closures[]
  REJECTED: "REJECTED",                 // PO rejected (mirrors PO_STATUS.REJECTED)
  NOT_REQUIRED: "NOT_REQUIRED",         // vendor marked "Not Required"
};
export const TRACKING_STATUS_ARRAY = Object.values(TRACKING_STATUS);


// ─── Invoice (goods receiving) — ADD to constants/stock.enums.js ──────────────
// UPLOADED — the invoice is uploaded (number, date, quantities), no item entered
//            (was ADDED until 2026-11-03 — see scripts/rename-invoice-added.js)
// DRAFT  — items are being entered and saved as a draft, not submitted yet
// PENDING — every invoiced unit is entered and submitted for approval
// IN_PROGRESS — partial submit only: entries are being entered/approved one
//               by one and not every invoiced unit is approved yet
export const INVOICE_STATUS = {
  UPLOADED: "UPLOADED",
  DRAFT: "DRAFT",
  PENDING: "PENDING",
  IN_PROGRESS: "IN_PROGRESS",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
};

// One entry of a partial-submit invoice (Entry 1, 2, 3 …).
export const INVOICE_ENTRY_STATUS = {
  DRAFT: "DRAFT",
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
};
export const INVOICE_ENTRY_STATUS_ARRAY = Object.values(INVOICE_ENTRY_STATUS);
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

// What happened to the PO mail. Stored on the tracking order for the badge.
//   SENT    "Mail Sent"     — emailed by the system
//   MANUAL  "Sent Manually" — the vendor got it outside the system (by hand,
//                             own mail, WhatsApp); the stored value predates the
//                             label and is kept so old records read the same
//   SKIPPED "Mail Skipped"  — not sent at all; the order moves on regardless and
//                             the mail can still be sent later
// Any of the three means the send step is done and the PO is locked against
// delete/reset; only SENT and MANUAL mean the vendor actually holds the PO.
export const MAIL_MODE = { SENT: "SENT", MANUAL: "MANUAL", SKIPPED: "SKIPPED" };
export const MAIL_MODE_ARRAY = Object.values(MAIL_MODE);
export const MAIL_REACHED_VENDOR = [MAIL_MODE.SENT, MAIL_MODE.MANUAL];

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

/*
  Payment terms, as the number of days they actually mean.

  The term itself is a STRING on the vendor, snapshotted onto the purchase
  order (po.paymentTerms). Turning it into a due date needs this mapping, and
  that is business logic — so it lives here, server-side, and is never
  duplicated into a screen. The frontend already carries the LABELS twice
  (Podetailsview, Vendorform); the day counts must not follow them there.

  IMMEDIATE is 0, not "no term": payment is due the day the clock starts.
*/
export const PAYMENT_TERM_DAYS = {
  IMMEDIATE: 0,
  NET_30: 30,
  NET_60: 60,
  NET_90: 90,
};

// Unknown/blank terms fall back to 0 — due immediately is the safe default:
// it surfaces the invoice for someone to look at, rather than hiding it
// forever behind a term nobody configured.
export const termDays = (term) => PAYMENT_TERM_DAYS[term] ?? 0;

/*
  Why a payment may only be SCHEDULED from today onwards.

  The due date itself is never scheduled — it is invoiceDate + the term's days,
  fixed by the contract. What is scheduled is when the invoice reaches the
  account team's payable queue: earlier when a vendor asks to be paid ahead of
  terms, later when the money is not there yet.

  Scheduling into the past is meaningless — it would manufacture overdue days
  for a decision taken today. Forward has no limit on purpose: "we will pay
  after 100 days, not 90" is a real instruction and a window could not express
  it.

  What stops the due date being pushed away for ever is not a window but the
  two locks in StockInvoicePaymentService.schedulePayment: once the invoice is
  payable, and once an approval has been asked for, the date is frozen. Plus
  every change is kept, with who made it.
*/

/*
  The payment side of an invoice is TWO independent questions, and they get two
  independent answers. One field for both was the original mistake: the moment
  a part-payment landed, "was this ever approved" became unanswerable, because
  the single status had already moved on to PARTLY_PAID.

      paymentApprovalStatus   stored     has it been cleared to pay
      paymentState            derived    how much of it has been paid

  Both are shown side by side on the Payments screen, which is only possible
  because they are separate.
*/
export const PAYMENT_APPROVAL_STATUS = {
  PENDING: "PENDING",     // sent to the approval team, awaiting a verdict
  APPROVED: "APPROVED",   // cleared to pay
  REJECTED: "REJECTED",   // sent back — fix the adjustments and send again
};
export const PAYMENT_APPROVAL_STATUS_ARRAY = Object.values(PAYMENT_APPROVAL_STATUS);

/*
  Never stored: it is paidTotal against payable, worked out on read. Storing it
  would mean a value that has to be kept in step with the payments array, and
  the two would eventually disagree.
*/
export const PAYMENT_STATE = {
  UNPAID: "UNPAID",
  PARTIAL: "PARTIAL",
  PAID: "PAID",
};
export const PAYMENT_STATE_ARRAY = Object.values(PAYMENT_STATE);

/*
  Only these two can be forced by hand. UNPAID is absent on purpose: an
  invoice with money against it is not unpaid, and saying so would be a lie the
  payments array immediately contradicts.
*/
export const PAYMENT_STATE_OVERRIDE_ARRAY = [PAYMENT_STATE.PAID, PAYMENT_STATE.PARTIAL];

/*
  Due-date filters, also derived. "Payable now" is what an accounts desk opens
  the screen for — anything whose clock has run out — so it is the default.
*/
export const PAYABLE_FILTER = {
  ALL: "ALL",
  NOW: "NOW",      // dueDate has arrived or passed
  LATER: "LATER",  // still inside its term
};

// Due-side tabs on the Invoice List, which reads the same derived dates.
export const DUE_FILTER = {
  ALL: "ALL",
  NOT_DUE: "NOT_DUE",
  DUE: "DUE",
  OVERDUE: "OVERDUE",
};

/*
  ── Invoice adjustments ──────────────────────────────────────────────────
  Anything that changes what is actually payable on an already-approved
  invoice. One collection, one type field, because the kinds of adjustment
  will keep growing — a second array per kind would mean a schema change
  every time.
*/
export const ADJUSTMENT_TYPE = {
  // Goods were defective. Carries the items it is claimed against, and
  // accepting it also marks those items DEBITED.
  DEBIT_NOTE: "DEBIT_NOTE",
  // Anything else with an amount and a reason — freight, handling, a charge
  // the vendor passed on. No items, no stock effect.
  MISC: "MISC",
};
export const ADJUSTMENT_TYPE_ARRAY = Object.values(ADJUSTMENT_TYPE);

/*
  Which way the money moves. Stored explicitly rather than derived from the
  type: today DEBIT_NOTE is always DEDUCT and MISC always ADD, but the next
  type added may be either, and a stored direction means that type needs no
  change to how payable is computed.
*/
export const ADJUSTMENT_DIRECTION = {
  DEDUCT: "DEDUCT",
  ADD: "ADD",
};
export const ADJUSTMENT_DIRECTION_ARRAY = Object.values(ADJUSTMENT_DIRECTION);

/*
  A debit note's own chain. Raised from the Invoice List, reviewed on Payments,
  decided on Approvals. Named for the STEP, never the team doing it, so moving
  review to another team is a permission change and nothing else.

    REVIEW_PENDING ─┬─ review reject ─▶ REVIEW_REJECTED ─ edit & resubmit ─▶ REVIEW_PENDING
                    └─ send ─▶ APPROVAL_PENDING ─┬─▶ APPROVED           (final, counts)
                                                 └─▶ APPROVAL_REJECTED  (final, nothing more)
    WITHDRAWN (final) — by the raiser, only from REVIEW_PENDING / REVIEW_REJECTED.

  Misc charges carry no status: they are accounts' own and in force at once.
  A debit note with NO status predates this chain and is treated as APPROVED.
*/
export const DEBIT_NOTE_STATUS = {
  REVIEW_PENDING: "REVIEW_PENDING",
  REVIEW_REJECTED: "REVIEW_REJECTED",
  APPROVAL_PENDING: "APPROVAL_PENDING",
  APPROVED: "APPROVED",
  APPROVAL_REJECTED: "APPROVAL_REJECTED",
  WITHDRAWN: "WITHDRAWN",
};
export const DEBIT_NOTE_STATUS_ARRAY = Object.values(DEBIT_NOTE_STATUS);
// Still moving — blocks a second debit note and a payment request.
export const DEBIT_NOTE_LIVE_STATUSES = [
  DEBIT_NOTE_STATUS.REVIEW_PENDING,
  DEBIT_NOTE_STATUS.REVIEW_REJECTED,
  DEBIT_NOTE_STATUS.APPROVAL_PENDING,
];
// Stock already released: these no longer hold any unit.
export const DEBIT_NOTE_RELEASED_STATUSES = [
  DEBIT_NOTE_STATUS.APPROVAL_REJECTED,
  DEBIT_NOTE_STATUS.WITHDRAWN,
];

// How a payment actually left. An enum, not free text, because "NEFT" typed
// six different ways cannot be reported on.
export const PAYMENT_MODE = {
  NEFT: "NEFT",
  RTGS: "RTGS",
  CHEQUE: "CHEQUE",
  CASH: "CASH",
  UPI: "UPI",
};
export const PAYMENT_MODE_ARRAY = Object.values(PAYMENT_MODE);

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

// ─── Alerts & Escalations ───────────────────────────────────────────────────
/*
  One engine, many channels. A rule says WHAT to send on an event; the channel
  decides HOW it travels. The provider behind a channel (chatflow today, Meta
  or a BSP tomorrow) is chosen in .env — see helpers/alert.providers/ — so no
  rule, template or log row ever names a provider.
*/
export const ALERT_CHANNEL = {
  EMAIL: "EMAIL",
  WHATSAPP: "WHATSAPP",
  // Reserved: the website bell (phase 5). Present so rules and templates can
  // already be shaped for it; sending refuses until its sender exists.
  IN_APP: "IN_APP",
};
export const ALERT_CHANNEL_ARRAY = Object.values(ALERT_CHANNEL);

// AUTOMATIC fires on its event by itself. MANUAL never fires: it only fills a
// dialog a person sends from (PO → vendor), and the person decides.
export const ALERT_RULE_KIND = { AUTOMATIC: "AUTOMATIC", MANUAL: "MANUAL" };
export const ALERT_RULE_KIND_ARRAY = Object.values(ALERT_RULE_KIND);

// A step of a rule's chain. All three send the same way; the type only says
// to a reader whether the team was reminded or the matter went upward.
export const ALERT_STEP_TYPE = { INITIAL: "INITIAL", REMINDER: "REMINDER", ESCALATION: "ESCALATION" };
export const ALERT_STEP_TYPE_ARRAY = Object.values(ALERT_STEP_TYPE);

/*
  Who a send goes to.
    CONTACT  one person from the Contacts list
    GROUP    a Contacts group: a list of people, or one WhatsApp group
    CREATOR  whoever created the record (its createdBy snapshot)
    VENDOR   the record's vendor — its contacts marked To (and CC)
    ADDRESS  a raw email / phone typed into the rule
*/
export const ALERT_RECIPIENT_TYPE = {
  CONTACT: "CONTACT",
  GROUP: "GROUP",
  CREATOR: "CREATOR",
  VENDOR: "VENDOR",
  ADDRESS: "ADDRESS",
  // Everyone (linked to a login) whose data scope on the event's module covers
  // the record's branch — OWN / SELECTED / ALL, exactly as the screens apply it.
  BRANCH_USERS: "BRANCH_USERS",
};
export const ALERT_RECIPIENT_TYPE_ARRAY = Object.values(ALERT_RECIPIENT_TYPE);

// A product's stock in one branch against its alert threshold.
export const STOCK_LEVEL = {
  OK: "OK",
  LOW: "LOW", // 0 < available ≤ threshold
  OUT: "OUT", // nothing available
};
export const STOCK_LEVEL_ARRAY = Object.values(STOCK_LEVEL);

export const ALERT_GROUP_TYPE = { LIST: "LIST", WHATSAPP_GROUP: "WHATSAPP_GROUP" };
export const ALERT_GROUP_TYPE_ARRAY = Object.values(ALERT_GROUP_TYPE);

export const ALERT_CONTACT_TYPE = { INTERNAL: "INTERNAL", EXTERNAL: "EXTERNAL" };
export const ALERT_CONTACT_TYPE_ARRAY = Object.values(ALERT_CONTACT_TYPE);

/*
  One message's life (Message Log).
    QUEUED → SENDING → SENT → DELIVERED → READ        (the last two: WhatsApp)
                     ↘ retry … → FAILED → (Resend) → QUEUED
    SKIPPED   never left: channel off, no address, manual skip
    CANCELLED stopped while still waiting
*/
export const ALERT_MESSAGE_STATUS = {
  QUEUED: "QUEUED",
  SENDING: "SENDING",
  SENT: "SENT",
  DELIVERED: "DELIVERED",
  READ: "READ",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
  CANCELLED: "CANCELLED",
};
export const ALERT_MESSAGE_STATUS_ARRAY = Object.values(ALERT_MESSAGE_STATUS);

// What put a message in the log.
export const ALERT_TRIGGER = {
  EVENT: "EVENT",           // a rule's first step
  ESCALATION: "ESCALATION", // a later step of the chain
  MANUAL: "MANUAL",         // a person sent it from a dialog
  RESEND: "RESEND",
  TEST: "TEST",
  DIGEST: "DIGEST",
};
export const ALERT_TRIGGER_ARRAY = Object.values(ALERT_TRIGGER);

/*
  A record's escalation chain.
    ACTIVE   waiting for its next step
    RESOLVED the work got done — no further step goes out
    FINISHED the last step went out
    STOPPED  stopped by hand from the Escalations tab
    CANCELLED the record went away (deleted / reset) or its rule was removed
*/
export const ALERT_ESCALATION_STATUS = {
  ACTIVE: "ACTIVE",
  RESOLVED: "RESOLVED",
  FINISHED: "FINISHED",
  STOPPED: "STOPPED",
  CANCELLED: "CANCELLED",
};
export const ALERT_ESCALATION_STATUS_ARRAY = Object.values(ALERT_ESCALATION_STATUS);
