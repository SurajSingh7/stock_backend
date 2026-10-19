import { ADJUSTMENT_TYPE, DEBIT_NOTE_STATUS } from "../constants/stock.enums.js";

/*
  Which adjustments move the payable.

  Misc charges always do. A debit note does only once APPROVED — one still in
  review or approval is a claim, not a deduction, and a rejected or withdrawn
  one never will be. A debit note with no status predates the approval chain
  and was in force the day it was raised, so it counts as approved.

  One definition, used by the payment screens, the ledger and the reports, so
  no two of them can disagree about what is owed.
*/
export const countsInPayable = (a) =>
  a.type !== ADJUSTMENT_TYPE.DEBIT_NOTE || !a.status || a.status === DEBIT_NOTE_STATUS.APPROVED;

// The same rule as a Mongo filter, for queries that should only ever see these.
export const PAYABLE_ADJUSTMENT_FILTER = {
  $or: [
    { type: { $ne: ADJUSTMENT_TYPE.DEBIT_NOTE } },
    { status: null },
    { status: DEBIT_NOTE_STATUS.APPROVED },
  ],
};
