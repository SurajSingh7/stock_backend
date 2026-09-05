import mongoose from "mongoose";

const { Schema } = mongoose;

// One generic collection for every "who did what, when" record — covers
// business-entity changes (StockItem, Transfer, PurchaseOrder, ...) AND
// permission-management actions (entityType: "Permission"), so both the
// per-record History tab and the global activity log read from one place.
const auditLogSchema = new Schema(
  {
    entityType: { type: String, required: true, trim: true }, // e.g. "branches", "Permission"
    entityId: { type: Schema.Types.ObjectId, required: true },
    action: { type: String, required: true, trim: true }, // matches the module's action vocabulary
    actor: {
      userId: { type: Schema.Types.ObjectId, default: null },
      employeeCode: { type: String, default: "" }, // company id — reads better than a name two people share
      name: { type: String, default: "" },
      email: { type: String, default: "" },
      roleName: { type: String, default: "" },
      branchId: { type: Schema.Types.ObjectId, default: null },
      ipAddress: { type: String, default: null },
      userAgent: { type: String, default: "" },
    },
    before: { type: Schema.Types.Mixed, default: null }, // null on CREATE
    after: { type: Schema.Types.Mixed, default: null },
    changedFields: { type: [String], default: [] }, // quick-diff keys, for a fast UI summary line
    reason: { type: String, default: "" }, // e.g. rejection reason
  },
  { timestamps: true }
);

auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ "actor.userId": 1, createdAt: -1 });

const StockAuditLogModel = mongoose.model("audit_logs", auditLogSchema, "audit_logs");

export default StockAuditLogModel;
