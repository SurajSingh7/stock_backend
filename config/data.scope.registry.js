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
  vendors: {},
  "terms-conditions": {},
  notifications: {},

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
  "purchase-orders": { entity: "buyerEntity.alias", ownership: "createdBy.userId" },

  // ── All three ────────────────────────────────────────────────────────────
  invoices: { branch: "branchId", entity: "entityAlias", ownership: "createdBy.userId" },
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
