/**
 * Warranty is stored everywhere as a whole number of MONTHS (`warrantyMonths`):
 * the product default, the vendor assignment override, and the quotation line.
 * A single integer unit keeps comparison and L1 ranking trivial and never
 * needs fractions ("1.5 years"). The UI converts to and from years for input
 * and display; the API only ever speaks months.
 *
 * Range is enforced here, at the API layer, and NOT with a schema `max`: the
 * schema re-validates whole documents on every save, so a limit there would
 * block soft-delete/restore on any older row that sits outside it.
 */
export const WARRANTY_MONTHS_MIN = 1;
export const WARRANTY_MONTHS_MAX = 120;

export const isValidWarrantyMonths = (v) =>
  typeof v === "number" &&
  Number.isInteger(v) &&
  v >= WARRANTY_MONTHS_MIN &&
  v <= WARRANTY_MONTHS_MAX;

export const assertWarrantyMonths = (v, label = "warrantyMonths") => {
  if (!isValidWarrantyMonths(v)) {
    throw new Error(
      `${label} must be a whole number of months between ${WARRANTY_MONTHS_MIN} and ${WARRANTY_MONTHS_MAX}`
    );
  }
};

/*
 * A unit's warranty end date: start + whole calendar months, in UTC (dates
 * arrive as "YYYY-MM-DD", i.e. UTC midnight). Clamped to the month's last day,
 * so 31 Jan + 1 month is 28/29 Feb rather than rolling over into March.
 * Null when either half is missing — an unknown warranty, not a zero one.
 */
export const addMonthsUtc = (date, months) => {
  const d = new Date(date);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return target;
};

export const warrantyEndDate = (startDate, months) =>
  startDate && Number.isInteger(months) && months > 0 ? addMonthsUtc(startDate, months) : null;

/*
 * TEMPORARY — remove once every deployed frontend sends `warrantyMonths`.
 *
 * Until then an older client still sends `warrantyYears`; convert it in place
 * so the backend can be deployed ahead of (or behind) the frontend without
 * breaking product/vendor saves. `warrantyMonths`, when present, always wins.
 */
export const upgradeLegacyWarranty = (obj) => {
  if (!obj || typeof obj !== "object") return obj;
  if (
    obj.warrantyMonths === undefined &&
    obj.warrantyYears !== undefined &&
    obj.warrantyYears !== null &&
    obj.warrantyYears !== ""
  ) {
    obj.warrantyMonths = Number(obj.warrantyYears) * 12;
  }
  delete obj.warrantyYears;
  return obj;
};

// Same, for a vendor's assignedProducts[].products[].overrides tree.
export const upgradeLegacyVendorWarranty = (body) => {
  (body?.assignedProducts || []).forEach((ap) =>
    (ap?.products || []).forEach((p) => upgradeLegacyWarranty(p?.overrides))
  );
  return body;
};
