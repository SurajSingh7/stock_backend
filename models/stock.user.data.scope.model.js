import mongoose from "mongoose";
import { DATA_SCOPE, DATA_SCOPE_ARRAY, ENTITY_SCOPE, ENTITY_SCOPE_ARRAY } from "../constants/stock.enums.js";

const { Schema } = mongoose;

// `moduleId: null` marks the user's GLOBAL row; a row with a moduleId is an
// override for that one module. One collection rather than two, so the
// resolver is a single query and the merge rule lives in one place.
//
// The merge is per DIMENSION, not per document: an override replaces only the
// dimensions it explicitly sets, and the rest still come from global. Each
// dimension therefore has a `configured` flag — without it there is no way to
// tell "override says branch = OWN" from "override says nothing about branch",
// since OWN is also the schema default.
const branchScopeSchema = new Schema(
  {
    configured: { type: Boolean, default: false },
    scope: { type: String, enum: DATA_SCOPE_ARRAY, default: DATA_SCOPE.OWN },
    allowedBranchIds: [{ type: Schema.Types.ObjectId, ref: "branches" }],
  },
  { _id: false }
);

const entityScopeSchema = new Schema(
  {
    configured: { type: Boolean, default: false },
    // No OWN — a user has no entity of their own. Unconfigured therefore means
    // SELECTED with an empty list: sees nothing, never "sees everything".
    scope: { type: String, enum: ENTITY_SCOPE_ARRAY, default: ENTITY_SCOPE.SELECTED },
    allowedEntityAliases: [{ type: String, trim: true, uppercase: true }],
  },
  { _id: false }
);

const ownershipScopeSchema = new Schema(
  {
    configured: { type: Boolean, default: false },
    scope: { type: String, enum: DATA_SCOPE_ARRAY, default: DATA_SCOPE.OWN },
    allowedUserIds: [{ type: Schema.Types.ObjectId }],
  },
  { _id: false }
);

const userDataScopeSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true }, // HRMS Login._id
    moduleId: { type: Schema.Types.ObjectId, ref: "modules", default: null }, // null = global
    branch: { type: branchScopeSchema, default: () => ({}) },
    entity: { type: entityScopeSchema, default: () => ({}) },
    recordOwnership: { type: ownershipScopeSchema, default: () => ({}) },
    updatedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

// One global row and at most one override per module, per user.
userDataScopeSchema.index({ userId: 1, moduleId: 1 }, { unique: true });

const StockUserDataScopeModel = mongoose.model(
  "user_data_scopes",
  userDataScopeSchema,
  "user_data_scopes"
);

export default StockUserDataScopeModel;
