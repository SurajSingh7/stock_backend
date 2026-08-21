import StockWarehouseModel from "../models/stock.warehouse.model.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import { applyBranchScopeToFilter, isWithinBranchScope } from "../helpers/branch.scope.helper.js";

const ENTITY_TYPE = "warehouses";

export default class StockWarehouseService {
  static async assertCodeNotDuplicate({ code, session, excludeId = null }) {
    if (!code) return;
    const filter = { code: String(code).trim().toUpperCase() };
    if (excludeId) filter._id = { $ne: excludeId };

    const existing = await StockWarehouseModel.findOne(filter).lean().session(session ?? null);
    if (existing) {
      if (existing.isActive) throw new Error("A warehouse with this code already exists.");
      throw new Error(
        "A warehouse with this code already exists in inactive records. Please restore it instead of creating a duplicate."
      );
    }
  }

  static async createWarehouse(body, actor, session) {
    const { name, code, address, description, city, state, locationRole } = body;
    await StockWarehouseService.assertCodeNotDuplicate({ code, session });

    const warehouse = new StockWarehouseModel({
      name: String(name).trim(),
      code: String(code).trim(),
      address: address || "",
      description: description || "",
      city: city || "",
      state: state || "",
      locationRole: locationRole || undefined,
    });
    await warehouse.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: warehouse._id,
      action: "CREATE",
      actor,
      before: null,
      after: warehouse.toObject(),
    });

    return warehouse;
  }

  static async getAllWarehouses({ skip, limit, search, showInactive }, scopeCtx) {
    const filter = showInactive ? {} : { isActive: true };
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { code: { $regex: search, $options: "i" } },
      ];
    }
    // The warehouse record itself IS the branch, so it's scoped on its own _id.
    applyBranchScopeToFilter(filter, scopeCtx, "_id");

    const [data, total] = await Promise.all([
      StockWarehouseModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      StockWarehouseModel.countDocuments(filter),
    ]);
    return { data, total };
  }

  // Unfiltered active list — for dropdowns (transfer-request source/destination
  // pickers, invoice warehouse field). Deliberately NOT branch-scoped: picking
  // a transfer's *other* location is the whole point of that flow, and
  // restricting this list would make cross-branch transfers impossible to
  // create in the first place.
  static async getActiveWarehouses() {
    return StockWarehouseModel.find({ isActive: true }).sort({ name: 1 }).lean();
  }

  static async getWarehouseById(id, scopeCtx) {
    const warehouse = await StockWarehouseModel.findOne({ _id: id, isActive: true }).lean();
    if (!warehouse || !isWithinBranchScope(warehouse, scopeCtx, "_id")) {
      throw new Error("Warehouse not found");
    }
    return warehouse;
  }

  static async updateWarehouse(id, body, actor, session) {
    const warehouse = await StockWarehouseModel.findOne({ _id: id, isActive: true }).session(session);
    if (!warehouse) throw new Error("Warehouse not found");
    const before = warehouse.toObject();

    if (body.code !== undefined && String(body.code).trim().toUpperCase() !== warehouse.code) {
      await StockWarehouseService.assertCodeNotDuplicate({
        code: body.code,
        session,
        excludeId: warehouse._id,
      });
    }

    const allowed = ["name", "code", "address", "description", "city", "state", "locationRole"];
    allowed.forEach((key) => {
      if (body[key] !== undefined) warehouse[key] = body[key];
    });

    await warehouse.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: warehouse._id,
      action: "UPDATE",
      actor,
      before,
      after: warehouse.toObject(),
    });

    return warehouse;
  }

  static async softDeleteWarehouse(id, actor, session) {
    const warehouse = await StockWarehouseModel.findOne({ _id: id, isActive: true }).session(session);
    if (!warehouse) throw new Error("Warehouse not found");
    const before = warehouse.toObject();

    warehouse.isActive = false;
    warehouse.deletedAt = new Date();
    warehouse.deletedBy = actor?._id ?? null;
    await warehouse.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: warehouse._id,
      action: "DELETE",
      actor,
      before,
      after: warehouse.toObject(),
    });

    return warehouse;
  }

  static async restoreWarehouse(id, actor, session) {
    const warehouse = await StockWarehouseModel.findOne({ _id: id }).session(session);
    if (!warehouse) throw new Error("Warehouse not found");
    if (warehouse.isActive) throw new Error("Warehouse is already active");
    const before = warehouse.toObject();

    warehouse.isActive = true;
    warehouse.deletedAt = null;
    warehouse.deletedBy = null;
    await warehouse.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: warehouse._id,
      action: "RESTORE",
      actor,
      before,
      after: warehouse.toObject(),
    });

    return warehouse;
  }
}
