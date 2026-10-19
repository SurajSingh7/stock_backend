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
  { key: "inventory-items", name: "Inventory Items", actions: withMenu([...STANDARD_ACTIONS, "BULK_CREATE", "UPDATE_STATUS"]) },
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
  // PARTIAL_SUBMIT: turn partial submit on/off for an invoice.
  { key: "invoices", name: "Invoices", actions: withMenu(["CREATE", "READ", "UPDATE", "APPROVE", "REJECT", "EDIT_INVOICE", "PARTIAL_SUBMIT"]) },
  // The payment-side list of approved invoices — read by the stock team, who
  // have no business approving invoices. Its own module so "who can see what
  // we owe" and "who can move a payment due date" are granted separately from
  // the receiving permissions. The nav entry for it has existed unbacked since
  // before this module did (layouts/navbar/NavCategories.js, moduleKey
  // "invoice-list"), which is why nobody could see it.
  { key: "invoice-list", name: "Invoice List", actions: withMenu(["READ", "SCHEDULE_PAYMENT", "RAISE_DEBIT_NOTE"]) },
  // The account team's screen. Three separate write actions on purpose: the
  // person who clears a debit note need not be the one who asks for payment
  // approval, nor the one who records the money leaving.
  { key: "payments", name: "Payments", actions: withMenu(["READ", "MANAGE_ADJUSTMENT", "REVIEW_DEBIT_NOTE", "REQUEST_PAYMENT_APPROVAL", "ENTER_PAYMENT"]) },
  // The approval team's screen. Read and decide, nothing else — they approve a
  // payable somebody else computed, so they get no action that can change one.
  { key: "payment-approval", name: "Approvals", actions: withMenu(["READ", "APPROVE", "APPROVE_DEBIT_NOTE"]) },
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
  { key: "tds-rates", name: "TDS Rates", actions: withMenu(STANDARD_ACTIONS) },
  { key: "transfer-requests", name: "Transfer Requests", actions: withMenu(["CREATE", "READ", "PROCESS", "REJECT"]) },
  { key: "notifications", name: "Notifications", actions: withMenu(STANDARD_ACTIONS) },
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
