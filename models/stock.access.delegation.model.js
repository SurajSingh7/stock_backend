import mongoose from "mongoose";

const { Schema } = mongoose;

// Audit trail only — records that User B's access was snapshot-copied from
// User A on a given date. The actual grant lives as normal rows in
// stock.user.permission.override / stock.access.scope.policy (tagged with
// this batchId); this doc just answers "who copied what from whom, when."
// Deliberately NOT a live link — editing A afterward does not touch B.
const accessDelegationSchema = new Schema(
  {
    fromUserId: { type: Schema.Types.ObjectId, required: true },
    toUserId: { type: Schema.Types.ObjectId, required: true },
    batchId: { type: String, required: true, unique: true },
    moduleIds: [{ type: Schema.Types.ObjectId, ref: "modules" }],
    performedBy: { type: Schema.Types.ObjectId, required: true }, // the admin who triggered the copy
  },
  { timestamps: true }
);

const StockAccessDelegationModel = mongoose.model(
  "access_delegations",
  accessDelegationSchema,
  "access_delegations"
);

export default StockAccessDelegationModel;
