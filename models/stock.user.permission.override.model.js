import mongoose from "mongoose";

const { Schema } = mongoose;

// The "same role, this one person gets more/less" case, applied on top of the
// base (role ∩ department). userId is HRMS's Login._id — no `ref`, foreign
// collection. A delegation "copy" (see stock.access.delegation.model.js)
// writes a normal record here — it's just an override whose origin happens
// to be traced back to another user via delegatedFrom.
//
// An override is an exception to a deliberate rule, so who granted it and why
// are part of the record, not just of the audit log: `reason` is required for
// anything granted by hand.
const userPermissionOverrideSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    moduleId: { type: Schema.Types.ObjectId, ref: "modules", required: true },
    addActions: { type: [String], default: [] },
    removeActions: { type: [String], default: [] },
    reason: { type: String, trim: true, default: "" },
    createdBy: { type: Schema.Types.ObjectId, default: null },
    updatedBy: { type: Schema.Types.ObjectId, default: null },
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
