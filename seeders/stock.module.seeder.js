import mongoose from "mongoose";
import dotenv from "dotenv";
import StockModuleModel from "../models/stock.module.model.js";
import { STANDARD_ACTIONS, VIEW_MENU_ACTION } from "../constants/stock.enums.js";
dotenv.config();

// One entry per resource in routes/v1.stock.routes.js. `key` matches the
// route prefix so requirePermission(key, action) reads naturally at the
// call site. Only inserts what's missing — an admin's later edits to a
// module's action list (via the access-control API) are never overwritten
// on restart.
// VIEW_MENU is appended to every module below rather than written out
// thirteen times — it applies to all of them, and a module quietly missing it
// would be permanently unreachable from the navigation.
const withMenu = (actions) => [...actions, VIEW_MENU_ACTION];

const MODULE_DEFINITIONS = [
  { key: "field-definitions", name: "Field Definitions", actions: withMenu(STANDARD_ACTIONS) },
  { key: "categories", name: "Categories", actions: withMenu([...STANDARD_ACTIONS, "REORDER", "MOVE", "TOGGLE_TYPE"]) },
  { key: "product-definitions", name: "Product Definitions", actions: withMenu(STANDARD_ACTIONS) },
  { key: "vendors", name: "Vendors", actions: withMenu(STANDARD_ACTIONS) },
  { key: "terms-conditions", name: "Terms & Conditions", actions: withMenu(STANDARD_ACTIONS) },
  // The Stock pages, one module each so each can be granted on its own (all
  // read-only — stock is never edited by hand). Replaced "inventory-items" —
  // scripts/migrate-stock-page-modules.js moves its grants across.
  { key: "available-products", name: "Available Product", actions: withMenu(["READ"]) },
  { key: "available-items", name: "Available Item", actions: withMenu(["READ"]) },
  { key: "product-summary", name: "Product Summary", actions: withMenu(["READ"]) },
  { key: "item-summary", name: "Item Summary", actions: withMenu(["READ"]) },
  // No UPDATE: a quotation is never edited — a mistake is rejected at review and
  // entered again as a new quotation. (scripts/remove-quotation-update-action.js
  // removes it from databases seeded before this.)
  { key: "quotations", name: "Quotations", actions: withMenu(["CREATE", "READ", "DELETE", "RESTORE", "REVIEW"]) },
  { key: "purchase-orders", name: "Purchase Orders", actions: withMenu(["CREATE", "READ", "UPDATE", "DELETE", "APPROVE", "REJECT", "SEND_MAIL", "RESET_ORDER"]) },
  { key: "tracking-orders", name: "Tracking Orders", actions: withMenu(["READ", "ADD_ENTITY", "MARK_NOT_REQUIRED", "SHORT_CLOSE", "REOPEN"]) },
  // Read-only register of every line and vendor that was dropped. Its own
  // module so "who may see the history of what we chose not to buy" is granted
  // separately from the permissions to actually drop something.
  { key: "not-required", name: "Not Required", actions: withMenu(["READ"]) },
  // EDIT_INVOICE: change an invoice's details (number, date, quantities,
  // charges) or delete it — kept apart from CREATE, which receiving staff hold.
  { key: "invoices", name: "Invoices", actions: withMenu(["CREATE", "READ", "UPDATE", "APPROVE", "REJECT", "EDIT_INVOICE"]) },
  // The payment-side list of approved invoices — read by the stock team, who
  // have no business approving invoices. Its own module so "who can see what
  // we owe" and "who can move a payment due date" are granted separately from
  // the receiving permissions. The nav entry for it has existed unbacked since
  // before this module did (layouts/navbar/NavCategories.js, moduleKey
  // "invoice-list"), which is why nobody could see it.
  { key: "invoice-list", name: "Invoice List", actions: withMenu(["READ", "SCHEDULE_PAYMENT", "RAISE_DEBIT_NOTE"]) },
  { key: "debit-note-items", name: "Debit Note Items", actions: withMenu(["READ"]) },
  // The account team's screen. Three separate write actions on purpose: the
  // person who clears a debit note need not be the one who asks for payment
  // approval, nor the one who records the money leaving.
  { key: "payments", name: "Payments", actions: withMenu(["READ", "MANAGE_ADJUSTMENT", "REVIEW_DEBIT_NOTE", "REQUEST_PAYMENT_APPROVAL", "ENTER_PAYMENT"]) },
  // The approval team's screen. Read and decide, nothing else — they approve a
  // payable somebody else computed, so they get no action that can change one.
  { key: "payment-approval", name: "Approvals", actions: withMenu(["READ", "APPROVE", "APPROVE_DEBIT_NOTE"]) },
  // Lost Items: report units lost / found (CREATE), and approve or reject those entries (lost-approval).
  { key: "lost-items", name: "Lost Items", actions: withMenu(["READ", "CREATE"]) },
  { key: "lost-approval", name: "Lost Items Approval", actions: withMenu(["READ", "APPROVE"]) },
  // Dead Items: write units off as dead (CREATE) — the only way a unit is scrapped — and approve them.
  { key: "dead-items", name: "Dead Items", actions: withMenu(["READ", "CREATE"]) },
  { key: "dead-approval", name: "Dead Items Approval", actions: withMenu(["READ", "APPROVE"]) },
  // READ only, and that is the whole module: a ledger reports what already
  // happened elsewhere. Its own key because a vendor statement is shown to a
  // wider audience than the desk that records payments.
  { key: "vendor-ledger", name: "Vendor Ledger", actions: withMenu(["READ"]) },

  /*
    Reports — read-only, one module each.

    Four keys rather than one "reports" module with four actions, because the
    nav advertises a module by VIEW_MENU: one shared key would make all four
    pages appear or vanish together, and "show them Outstanding but not the
    unit prices in Invoice Breakup" is a real thing an organisation asks for.

    Billing and Outstanding read the same data as Vendor Ledger. They still
    get their own keys so the data scope can differ per report — see the note
    in config/data.scope.registry.js.
  */
  { key: "billing-report", name: "Billing Report", actions: withMenu(["READ"]) },
  { key: "paid-report", name: "Paid", actions: withMenu(["READ"]) },
  { key: "transaction-register", name: "Transaction Register", actions: withMenu(["READ"]) },
  { key: "invoice-breakup", name: "Invoice Breakup", actions: withMenu(["READ"]) },
  { key: "account-summary", name: "Vendor Outstanding Overview", actions: withMenu(["READ"]) },
  { key: "branches", name: "Branches", actions: withMenu(STANDARD_ACTIONS) },
  { key: "gst-rates", name: "GST Rates", actions: withMenu(STANDARD_ACTIONS) },
  // Which Claude model reads uploaded invoices. UPDATE also gates the
  // "Change model" button next to Re-scan on Add Invoice.
  { key: "ai-settings", name: "AI Settings", actions: withMenu(["READ", "UPDATE", "TEST"]) },
  /*
    Stock Transfer — one page each, every transfer starting as a request:
      my-stock-requests      My Requests: ask another branch (CREATE); say
                             All Received / Report Problem (RECEIVE)
      stock-requests-to-us   Requests to Us: SEND (also Correct & Resend) or DECLINE
      stock-transfer-history Transfer History: received and declined, both ways
    Replaced "transfer-requests" — scripts/migrate-transfer-modules.js moves
    its grants across.
  */
  { key: "my-stock-requests", name: "Stock Transfer · My Requests", actions: withMenu(["READ", "CREATE", "RECEIVE"]) },
  { key: "stock-requests-to-us", name: "Stock Transfer · Requests to Us", actions: withMenu(["READ", "SEND", "DECLINE"]) },
  { key: "stock-transfer-history", name: "Stock Transfer · Transfer History", actions: withMenu(["READ"]) },
  // Stock that was already on hand before this system. POST is its own action
  // because it is the step that actually creates stock — the person typing up
  // a 300-row draft need not be the one allowed to put it on the books. An
  // APPROVE action joins here if approval is ever wanted.
  { key: "opening-stock", name: "Opening Stock", actions: withMenu(["CREATE", "READ", "UPDATE", "DELETE", "POST"]) },
  // The same entries for stock already with someone (posting makes it
  // ASSIGNED to them) — its own module, so who may say "X has had this for
  // years" is granted apart from who counts the shelves.
  { key: "opening-issued-stock", name: "Opening Issued Stock", actions: withMenu(["CREATE", "READ", "UPDATE", "DELETE", "POST"]) },
  // Subscribers' requests for stock. Issuing, short-closing and rejecting are
  // separate actions: the person handing over units need not be the one who
  // may refuse a request outright.
  { key: "item-requests", name: "Item Requests", actions: withMenu(["READ", "ISSUE", "RECEIVE", "SHORT_CLOSE", "REJECT"]) },
  // Our broken units. REPORT (mark a shelf unit faulty) is held by store staff;
  // MANAGE (send for repair / result) by whoever runs repairs. Writing a unit
  // off is Dead Items (dead-items / dead-approval), not here.
  { key: "repairs", name: "Repair & Warranty", actions: withMenu(["READ", "REPORT", "MANAGE"]) },
  // Stock with our own people — handing out and taking back are separate.
  { key: "employee-items", name: "Employee Items", actions: withMenu(["READ", "ASSIGN", "RETURN"]) },
  // 🧪 TEST ONLY — plays the requesting website. Remove when the real one is live.
  { key: "test-simulator", name: "Request Simulator (Test)", actions: withMenu(["READ", "CREATE", "REQUEST"]) },

  /*
    Alerts & Escalations — one module per tab, so each page can be granted on
    its own (support may read the Message Log without touching rules). TEST
    sends a real message, so it is its own action, apart from UPDATE.
  */
  { key: "alert-channels", name: "Alerts · Channels", actions: withMenu(["READ", "UPDATE", "TEST"]) },
  { key: "alert-contacts", name: "Alerts · Contacts & Groups", actions: withMenu(["CREATE", "READ", "UPDATE", "DELETE"]) },
  { key: "alert-templates", name: "Alerts · Templates", actions: withMenu(["CREATE", "READ", "UPDATE", "DELETE", "TEST"]) },
  { key: "alert-rules", name: "Alerts · Rules", actions: withMenu(["CREATE", "READ", "UPDATE", "DELETE"]) },
  { key: "alert-escalations", name: "Alerts · Escalations", actions: withMenu(["READ", "STOP"]) },
  { key: "alert-log", name: "Alerts · Message Log", actions: withMenu(["READ", "RESEND", "CANCEL"]) },
];

export const seedModules = async () => {
  try {
    const existing = await StockModuleModel.find({}, "key actions").lean();
    const existingKeys = new Set(existing.map((m) => m.key));

    /*
      Actions added to a module that already exists. Inserting only new
      modules meant a new action (EDIT_INVOICE, RAISE_DEBIT_NOTE…) never
      reached a database seeded before it — the route would 403 for everyone
      but admins. Add-only: an action is never removed or renamed here.
    */
    const actionsByKey = new Map(existing.map((m) => [m.key, new Set(m.actions || [])]));
    let actionsAdded = 0;
    for (const def of MODULE_DEFINITIONS) {
      const have = actionsByKey.get(def.key);
      if (!have) continue;
      const add = def.actions.filter((a) => !have.has(a));
      if (!add.length) continue;
      await StockModuleModel.updateOne({ key: def.key }, { $addToSet: { actions: { $each: add } } });
      actionsAdded += add.length;
      console.info(`Module ${def.key}: added action(s) ${add.join(", ")}`);
    }

    const missing = MODULE_DEFINITIONS.filter((m) => !existingKeys.has(m.key));
    if (missing.length === 0) return { seeded: actionsAdded > 0, count: 0, actionsAdded };

    await StockModuleModel.insertMany(missing);
    console.info(`Seeded ${missing.length} module(s): ${missing.map((m) => m.key).join(", ")}`);
    return { seeded: true, count: missing.length };
  } catch (error) {
    console.error("Error seeding modules:", error);
    throw error;
  }
};

// ─── Run as standalone script ─────────────────────────────────────────────────
// node seeders/stock.module.seeder.js
if (process.argv[1].includes("stock.module.seeder")) {
  const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/stock_db";
  mongoose
    .connect(MONGO_URI)
    .then(async () => {
      await seedModules();
      await mongoose.disconnect();
      process.exit(0);
    })
    .catch((err) => {
      console.error("DB connection error:", err);
      process.exit(1);
    });
}
