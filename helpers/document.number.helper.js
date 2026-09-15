import StockCounterModel from "../models/stock.counter.model.js";

/*
  Atomic per-year document numbers — QTN-2026-0001, PO-2026-0001, and so on.

  The pattern this replaces is counting existing rows and adding one. That
  hands two simultaneous requests the SAME number; with a unique index on the
  field, one of them then dies on a raw duplicate-key error that means nothing
  to the person who pressed the button. A $inc on a single counter row is
  atomic, so it cannot happen.

  Seeding: the first number of a year finds no counter row, so it is seeded
  from the highest number already issued for that prefix. That is what makes
  the switch-over safe on a collection that already has numbers in it — without
  it the sequence would restart at 1 and collide with everything.

  Soft-deleted documents are deliberately INCLUDED when seeding: their numbers
  were issued and must never be handed out again (a reset PO keeps its number
  out of circulation).
*/
export async function nextDocumentNumber({ model, field, prefix, session, pad = 4 }) {
  const year = new Date().getFullYear();
  const fullPrefix = `${prefix}-${year}-`;
  const key = `${prefix}-${year}`;

  const bumped = await StockCounterModel.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { new: true, session }
  ).lean();
  let seq = bumped?.seq;

  if (seq === undefined) {
    const [top] = await model
      .aggregate([
        { $match: { [field]: { $regex: `^${fullPrefix}\\d+$` } } },
        {
          $group: {
            _id: null,
            max: { $max: { $toInt: { $substrCP: [`$${field}`, fullPrefix.length, 12] } } },
          },
        },
      ])
      .session(session);

    const seeded = await StockCounterModel.findOneAndUpdate(
      { _id: key },
      [{ $set: { seq: { $add: [{ $ifNull: ["$seq", top?.max || 0] }, 1] } } }],
      { new: true, upsert: true, session }
    ).lean();
    seq = seeded.seq;
  }

  return `${fullPrefix}${String(seq).padStart(pad, "0")}`;
}
