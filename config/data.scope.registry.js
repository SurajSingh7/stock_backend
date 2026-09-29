/**
 * Which data-access dimensions actually apply to each module, and which field
 * on that model carries each one.
 *
 * Deliberately code, not a database collection: it has to stay in step with
 * the Mongoose schemas, and a field added to a model plus its entry here land
 * in the same commit. A DB-backed setting could silently drift from the actual
 * schema, and an admin could misconfigure it into either a lockout or a leak.
 *
 * FAIL CLOSED: every module the router protects must appear here, even when no
 * dimension applies (`{}` — shared master data). resolveModuleScopeFields()
 * throws for anything missing, so a new module added without an entry fails
 * loudly on first use instead of quietly returning unrestricted data.
 *
 * A dimension's value is the field path on that model. An array means the
 * record qualifies if ANY of those fields matches (transfer requests sit
 * between two branches and belong to both).
 */
export const DATA_SCOPE_REGISTRY = {
  // ── Shared master data — intentionally unscoped ──────────────────────────
  // These are reference data every user needs to do their job: the product
  // catalogue, the vendor list, the branch list that feeds every dropdown.
  // Scoping them by who happened to create the row would make the system
  // unusable, so they carry no dimension at all.
  categories: {},
  "field-definitions": {},
  "product-definitions": {}, // its branchId lives inside branchThresholds[] — an
                             // alert setting per branch, not an owning branch.
  // Each branch keeps its own vendor list; central staff hold branch: ALL and
  // see everyone's. Registered only after every vendor had a branch assigned
  // (scripts/backfill-vendor-branch.js) — a null here is invisible to anyone
  // on OWN, with no error to explain it.
  vendors: { branch: "branchId" },
  "terms-conditions": {},
  notifications: {},
  // The GST slab ladder — the same rows for the whole company. No branch,
  // entity or ownership dimension exists to scope them on.
  "gst-rates": {},

  // ── Branch-scoped ────────────────────────────────────────────────────────
  // A branch record IS a branch, so it scopes on its own _id. The unscoped
  // dropdown a transfer needs (you must be able to pick the OTHER branch)
  // is a separate service method, not a hole in this rule.
  branches: { branch: "_id" },
  "inventory-items": { branch: "branchId" },
  "transfer-requests": { branch: ["requestingBranchId", "sourceBranchId"] },

  // ── Ownership-scoped ─────────────────────────────────────────────────────
  quotations: { ownership: "createdBy.userId" },

  // ── Entity-scoped ────────────────────────────────────────────────────────
  "tracking-orders": { entity: "buyerEntity.alias" },
  // The Not Required register reads tracking orders, so it scopes exactly as
  // they do. Rows dropped before an entity was ever assigned have a blank
  // alias and stay visible — the same rule the tracking board already applies
  // to ENTITY_PENDING rows.
  "not-required": { entity: "buyerEntity.alias" },
  "purchase-orders": { entity: "buyerEntity.alias", ownership: "createdBy.userId" },

  // ── All three ────────────────────────────────────────────────────────────
  invoices: { branch: "branchId", entity: "entityAlias", ownership: "createdBy.userId" },
  // The payment-side view of the same documents. Its own key, not a reuse of
  // `invoices`, because it is a different module with a different audience —
  // which means an admin can give the stock team a wide branch scope here
  // while their scope on receiving stays narrow, or the other way round.
  // Same dimensions, so the same knobs are available.
  "invoice-list": { branch: "branchId", entity: "entityAlias", ownership: "createdBy.userId" },
  // The same invoices again, once per team that looks at them. Separate keys
  // are the point: accounts normally hold every branch here while the stock
  // team holds one, and the approval team sits somewhere between. Same
  // dimensions, so the same knobs exist for each.
  payments: { branch: "branchId", entity: "entityAlias", ownership: "createdBy.userId" },
  "payment-approval": { branch: "branchId", entity: "entityAlias", ownership: "createdBy.userId" },
  "vendor-ledger": { branch: "branchId", entity: "entityAlias", ownership: "createdBy.userId" },

  /*
    The report pages. Same invoices, same scope dimensions as the ledger —
    they ARE the ledger's data, read with different columns.

    Registered separately rather than reusing "vendor-ledger" because the
    scope is resolved per module in requirePermission: giving each report its
    own key is what lets one person be branch-limited on Billing while seeing
    every branch on Outstanding. Sharing a key would silently make that
    impossible.
  */
  "billing-report": { branch: "branchId", entity: "entityAlias", ownership: "createdBy.userId" },
  "outstanding-report": { branch: "branchId", entity: "entityAlias", ownership: "createdBy.userId" },
  "paid-report": { branch: "branchId", entity: "entityAlias", ownership: "createdBy.userId" },
  "transaction-register": { branch: "branchId", entity: "entityAlias", ownership: "createdBy.userId" },
  "invoice-breakup": { branch: "branchId", entity: "entityAlias", ownership: "createdBy.userId" },
};

/**
 * Fail-closed lookup. Never returns a default for an unknown module — that is
 * the whole point: forgetting to register a module must break, not leak.
 */
export function resolveModuleScopeFields(moduleKey) {
  const entry = DATA_SCOPE_REGISTRY[moduleKey];
  if (entry === undefined) {
    throw new Error(
      `Module "${moduleKey}" is not in the data-scope registry. Add an entry to ` +
        `config/data.scope.registry.js — use {} if no data scope applies to it.`
    );
  }
  return entry;
}

/** Every registered module key — used by scripts/check-data-scope.js. */
export const REGISTERED_MODULE_KEYS = Object.keys(DATA_SCOPE_REGISTRY);
