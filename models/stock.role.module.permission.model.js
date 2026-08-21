import mongoose from "mongoose";

const { Schema } = mongoose;

// Layer 1 — the default: every user with this role gets these actions on
// this module unless a stock.user.permission.override overrides it.
// roleId is HRMS's Role._id — no `ref`, it's a foreign collection.
const roleModulePermissionSchema = new Schema(
  {
    roleId: { type: Schema.Types.ObjectId, required: true },
    moduleId: { type: Schema.Types.ObjectId, ref: "modules", required: true },
    allowedActions: { type: [String], default: [] },
  },
  { timestamps: true }
);

roleModulePermissionSchema.index({ roleId: 1, moduleId: 1 }, { unique: true });

const StockRoleModulePermissionModel = mongoose.model(
  "role_module_permissions",
  roleModulePermissionSchema,
  "role_module_permissions"
);

export default StockRoleModulePermissionModel;
