import mongoose from "mongoose";
import { ENTITY_SCOPE, ENTITY_SCOPE_ARRAY } from "../constants/stock.enums.js";

const { Schema } = mongoose;

// One row per user — NOT per (user, module) like AccessScopePolicy.
// "Ramesh works on GTEL" is a property of the person: holding it per module
// would let someone end up with GTEL on Purchase Orders and WIBRO on Invoices,
// which is meaningless for a workflow that runs across both.
//
// Stored as the alias ("GTEL"), not the internal-company _id, because one
// company has several entity records — one per state registration/GST. A grant
// of "GTEL" must cover all of them, including ones created later, and must not
// depend on the external ERP company API being reachable at check time.
const userEntityAccessSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, unique: true }, // HRMS Login._id
    scope: { type: String, enum: ENTITY_SCOPE_ARRAY, required: true, default: ENTITY_SCOPE.ALL_ENTITIES },
    // Only meaningful when scope === SPECIFIC_ENTITIES.
    allowedEntityAliases: [{ type: String, trim: true, uppercase: true }],
  },
  { timestamps: true }
);

const StockUserEntityAccessModel = mongoose.model(
  "user_entity_access",
  userEntityAccessSchema,
  "user_entity_access"
);

export default StockUserEntityAccessModel;
