import mongoose from "mongoose";

const { Schema } = mongoose;

// A ceiling, not a grant. Base actions = role actions ∩ department actions, so
// a department can only ever take away what the role gave — it can never add.
//
// Absence means NO restriction (base = role actions), which is the opposite of
// how a missing role permission behaves (that denies). The asymmetry is
// deliberate: roles are the source of authority, departments only narrow it,
// so "nobody configured a department restriction" must not lock anyone out.
//
// departmentId is HRMS's departments._id — no `ref`, foreign collection.
const departmentModuleRestrictionSchema = new Schema(
  {
    departmentId: { type: Schema.Types.ObjectId, required: true },
    moduleId: { type: Schema.Types.ObjectId, ref: "modules", required: true },
    allowedActions: { type: [String], default: [] },
    updatedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

departmentModuleRestrictionSchema.index({ departmentId: 1, moduleId: 1 }, { unique: true });

const StockDepartmentModuleRestrictionModel = mongoose.model(
  "department_module_restrictions",
  departmentModuleRestrictionSchema,
  "department_module_restrictions"
);

export default StockDepartmentModuleRestrictionModel;
