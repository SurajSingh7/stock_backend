import mongoose from "mongoose";

const { Schema } = mongoose;

// Layer 2 — the "same role, this one person gets more/less" case. Applied
// on top of the role's default: effective = roleDefault ∪ addActions,
// minus removeActions. userId is HRMS's Login._id — no `ref`, foreign
// collection. A delegation "copy" (see stock.access.delegation.model.js)
// writes a normal record here — it's just an override whose origin happens
// to be traced back to another user via delegatedFrom.
const userPermissionOverrideSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    moduleId: { type: Schema.Types.ObjectId, ref: "modules", required: true },
    addActions: { type: [String], default: [] },
    removeActions: { type: [String], default: [] },
    delegatedFrom: { type: Schema.Types.ObjectId, default: null }, // set when this row originated as a copy
    delegationBatchId: { type: String, default: null },
  },
  { timestamps: true }
);

userPermissionOverrideSchema.index({ userId: 1, moduleId: 1 }, { unique: true });

const StockUserPermissionOverrideModel = mongoose.model(
  "user_permission_overrides",
  userPermissionOverrideSchema,
  "user_permission_overrides"
);

export default StockUserPermissionOverrideModel;
