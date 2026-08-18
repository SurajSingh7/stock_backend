import StockWarehouseModel from "../models/stock.warehouse.model.js";

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

  static async createWarehouse(body, session) {
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
    return warehouse;
  }

  static async getAllWarehouses({ skip, limit, search, showInactive }) {
    const filter = showInactive ? {} : { isActive: true };
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { code: { $regex: search, $options: "i" } },
      ];
    }

    const [data, total] = await Promise.all([
      StockWarehouseModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      StockWarehouseModel.countDocuments(filter),
    ]);
    return { data, total };
  }

  // Unfiltered active list — for dropdowns (Add Items form, Inventory filters).
  static async getActiveWarehouses() {
    return StockWarehouseModel.find({ isActive: true }).sort({ name: 1 }).lean();
  }

  static async getWarehouseById(id) {
    const warehouse = await StockWarehouseModel.findOne({ _id: id, isActive: true }).lean();
    if (!warehouse) throw new Error("Warehouse not found");
    return warehouse;
  }

  static async updateWarehouse(id, body, session) {
    const warehouse = await StockWarehouseModel.findOne({ _id: id, isActive: true }).session(session);
    if (!warehouse) throw new Error("Warehouse not found");

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
    return warehouse;
  }

  static async softDeleteWarehouse(id, deletedBy, session) {
    const warehouse = await StockWarehouseModel.findOne({ _id: id, isActive: true }).session(session);
    if (!warehouse) throw new Error("Warehouse not found");
    if (warehouse.code === "MAIN") throw new Error("The default Main Warehouse cannot be deleted");

    warehouse.isActive = false;
    warehouse.deletedAt = new Date();
    warehouse.deletedBy = deletedBy ?? null;
    await warehouse.save({ session });
    return warehouse;
  }

  static async restoreWarehouse(id, session) {
    const warehouse = await StockWarehouseModel.findOne({ _id: id }).session(session);
    if (!warehouse) throw new Error("Warehouse not found");
    if (warehouse.isActive) throw new Error("Warehouse is already active");

    warehouse.isActive = true;
    warehouse.deletedAt = null;
    warehouse.deletedBy = null;
    await warehouse.save({ session });
    return warehouse;
  }
}
