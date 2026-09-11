import mongoose from "mongoose";

/*
  Atomic document-number sequences — one row per sequence key
  (e.g. "QTN-2026"). A $inc on a single document is atomic, so two requests
  can never draw the same number; counting existing documents and adding one
  (the pattern this replaces) hands both of them the same value.

  Internal mechanics, not business data: no actor stamps, no soft delete.
*/
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // sequence key
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false }
);

const StockCounterModel = mongoose.model("counters", counterSchema, "counters");

export default StockCounterModel;
