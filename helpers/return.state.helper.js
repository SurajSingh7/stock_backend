import { AppError } from "./response.helper.js";
import { ITEM_STATUS, ITEM_CONDITION, ITEM_CONDITION_ARRAY, WORKING_STATE, WORKING_STATE_ARRAY, RETURN_CONDITION } from "../constants/stock.enums.js";

/*
  How a unit came back, as the store judged it — shared by subscriber returns
  / replaces and employee returns, so all three land a unit the same way:

    { workingState: WORKING | FAULTY | BEYOND_REPAIR, itemCondition: NEW | USED, note }

    WORKING        → AVAILABLE, back on the shelf
    FAULTY         → FAULTY, into Repair & Warranty with the note
    BEYOND_REPAIR  → SCRAPPED, on record only, the note as why

  The older { condition: GOOD | FAULTY } is still read (GOOD = WORKING).
  Condition defaults to USED; NEW only when the store has checked it unused.
  A note is required unless it works.
*/
export const readReturnState = (input, label = "") => {
  const at = label ? `${label}: ` : "";
  const raw = String(input?.workingState || "").toUpperCase();
  const legacy = String(input?.condition || "").toUpperCase();
  const workingState = WORKING_STATE_ARRAY.includes(raw)
    ? raw
    : legacy === RETURN_CONDITION.GOOD
      ? WORKING_STATE.WORKING
      : legacy === RETURN_CONDITION.FAULTY
        ? WORKING_STATE.FAULTY
        : null;
  if (!workingState) throw new AppError(`${at}say whether it works — Working, Faulty (Repairable) or Beyond Repair`, 400);
  const cond = String(input?.itemCondition || "").toUpperCase();
  if (cond && !ITEM_CONDITION_ARRAY.includes(cond)) throw new AppError(`${at}condition must be New or Used`, 400);
  const note = input?.note === undefined || input?.note === null ? "" : String(input.note).trim().slice(0, 500);
  if (workingState !== WORKING_STATE.WORKING && !note)
    throw new AppError(`${at}${workingState === WORKING_STATE.FAULTY ? "describe the fault" : "say why it is beyond repair"}`, 400);
  return { workingState, itemCondition: cond || ITEM_CONDITION.USED, note };
};

// The unit's fields once it has landed back at `branchId`.
export const landedFields = ({ workingState, itemCondition, note }, branchId, now, via, requestNumber = "") => ({
  status:
    workingState === WORKING_STATE.WORKING ? ITEM_STATUS.AVAILABLE : workingState === WORKING_STATE.FAULTY ? ITEM_STATUS.FAULTY : ITEM_STATUS.SCRAPPED,
  branchId,
  condition: itemCondition,
  assignedTo: null,
  fault: workingState === WORKING_STATE.FAULTY ? { reportedAt: now, note, via, requestNumber } : null,
  scrapNote: workingState === WORKING_STATE.BEYOND_REPAIR ? note : "",
});

// "Working · New", "Faulty (Repairable) · Used: no power" — for notes and history.
export const returnStateLabel = ({ workingState, itemCondition, note }) => {
  const w = workingState === WORKING_STATE.WORKING ? "Working" : workingState === WORKING_STATE.FAULTY ? "Faulty (Repairable)" : "Beyond Repair";
  return `${w} · ${itemCondition === ITEM_CONDITION.NEW ? "New" : "Used"}${note && workingState !== WORKING_STATE.WORKING ? `: ${note}` : ""}`;
};

// The old two-way flag, still kept on receipts for anything reading it.
export const legacyCondition = (workingState) => (workingState === WORKING_STATE.WORKING ? RETURN_CONDITION.GOOD : RETURN_CONDITION.FAULTY);
