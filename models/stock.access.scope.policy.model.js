import mongoose from "mongoose";
import { ACCESS_SCOPE, ACCESS_SCOPE_ARRAY } from "../constants/stock.enums.js";

const { Schema } = mongoose;

// Layer 3 — independent of what actions a user can perform: which records
// they can see/act on. No policy for a (user, module) pair = OWN_BRANCH,
// the safe/most-restrictive default (see requirePermission()).
const accessScopePolicySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    moduleId: { type: Schema.Types.ObjectId, ref: "modules", required: true },
    scope: { type: String, enum: ACCESS_SCOPE_ARRAY, required: true, default: ACCESS_SCOPE.OWN_BRANCH },
    // Only meaningful when scope === SPECIFIC_BRANCHES.
    allowedBranchIds: [{ type: Schema.Types.ObjectId, ref: "branches" }],
  },
  { timestamps: true }
);

accessScopePolicySchema.index({ userId: 1, moduleId: 1 }, { unique: true });

const StockAccessScopePolicyModel = mongoose.model(
  "access_scope_policies",
  accessScopePolicySchema,
  "access_scope_policies"
);

export default StockAccessScopePolicyModel;
