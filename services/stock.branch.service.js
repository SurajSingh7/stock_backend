import mongoose from "mongoose";
import { actorSnapshot } from "../models/plugins/actor.stamp.plugin.js";
import StockBranchModel from "../models/stock.branch.model.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import { applyDataScope, isWithinDataScope } from "../helpers/data.scope.helper.js";

const MODULE_KEY = "branches";

const ENTITY_TYPE = "branches";

// Guard for every mutation. Throws the resource's normal "not found" rather
// than a 403 — a 403 would confirm a branch outside the caller's scope exists.
const assertDataScope = (branch, dataAccess) => {
  if (!isWithinDataScope(branch, dataAccess, MODULE_KEY)) {
    throw new Error("Branch not found");
  }
};

export default class StockBranchService {
  static async assertCodeNotDuplicate({ code, session, excludeId = null }) {
    if (!code) return;
    const filter = { code: String(code).trim().toUpperCase() };
    if (excludeId) filter._id = { $ne: excludeId };

    const existing = await StockBranchModel.findOne(filter).lean().session(session ?? null);
    if (existing) {
      if (existing.isActive) throw new Error("A branch with this code already exists.");
      throw new Error(
        "A branch with this code already exists in inactive records. Please restore it instead of creating a duplicate."
      );
    }
  }

  static async createBranch(body, actor, session) {
    const { name, code, address, description, city, state, stateCode, branchRole } = body;
    await StockBranchService.assertCodeNotDuplicate({ code, session });

    const branch = new StockBranchModel({
      name: String(name).trim(),
      code: String(code).trim(),
      address: address || "",
      description: description || "",
      city: city || "",
      state: state || "",
      stateCode: stateCode || "",
      branchRole: branchRole || undefined,
    });
    await branch.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: branch._id,
      action: "CREATE",
      actor,
      before: null,
      after: branch.toObject(),
    });

    return branch;
  }

  static async getAllBranches({ skip, limit, search, showInactive }, dataAccess) {
    const filter = showInactive ? {} : { isActive: true };
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { code: { $regex: search, $options: "i" } },
      ];
    }
    // The branch record itself IS the branch, so it's scoped on its own _id.
    applyDataScope(filter, dataAccess, MODULE_KEY);

    const [data, total] = await Promise.all([
      StockBranchModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      StockBranchModel.countDocuments(filter),
    ]);
    return { data, total };
  }

  // Unfiltered active list — for dropdowns (transfer-request source/destination
  // pickers, invoice branch field). Deliberately NOT branch-scoped: picking
  // a transfer's *other* branch is the whole point of that flow, and
  // restricting this list would make cross-branch transfers impossible to
  // create in the first place.
  static async getActiveBranches() {
    return StockBranchModel.find({ isActive: true }).sort({ name: 1 }).lean();
  }

  // Active branches inside the caller's branch scope, resolved off the
  // *calling module's* scope policy. The branch record IS the branch, so
  // it's scoped on its own _id — same rule as getAllBranches, minus the
  // pagination/search of a management list.
  //
  // This is what other modules' branch pickers should read. getActiveBranches
  // above sits behind `branches:READ`, which is the Master > Branch
  // *management* permission — a receiving clerk who only holds `invoices` must
  // not be forced to take that (and the nav entry it unlocks) just to name
  // their own branch.
  //
  // Returns [] for a branchless user on the default OWN_BRANCH scope. That is
  // the intended answer, not an error: callers surface it as "no branch assigned".
  static async getScopedActiveBranches(dataAccess) {
    const filter = applyDataScope({ isActive: true }, dataAccess, MODULE_KEY);
    return StockBranchModel.find(filter).sort({ name: 1 }).lean();
  }

  // Write-path guard for any record that persists a branchId. Storing one
  // outside the writer's scope produces a row its own author can no longer
  // read back (every list is branch-scoped on that same field), so reject it
  // up front rather than writing it silently.
  static async assertBranchInScope(branchId, dataAccess, session) {
    if (!branchId) throw new Error("Receiving branch is required");
    if (!mongoose.isValidObjectId(branchId)) throw new Error("Invalid branch selected");

    const branch = await StockBranchModel.findOne({ _id: branchId, isActive: true })
      .lean()
      .session(session ?? null);
    if (!branch || !isWithinDataScope(branch, dataAccess, MODULE_KEY)) {
      // Worded to hit the 403 branch of errorResponseHandler.
      throw new Error("You do not have permission to use the selected branch");
    }
    return branch._id;
  }

  static async getBranchById(id, dataAccess) {
    const branch = await StockBranchModel.findOne({ _id: id, isActive: true }).lean();
    if (!branch || !isWithinDataScope(branch, dataAccess, MODULE_KEY)) {
      throw new Error("Branch not found");
    }
    return branch;
  }

  static async updateBranch(id, body, actor, session, dataAccess) {
    const branch = await StockBranchModel.findOne({ _id: id, isActive: true }).session(session);
    if (!branch) throw new Error("Branch not found");
    assertDataScope(branch, dataAccess);
    const before = branch.toObject();

    if (body.code !== undefined && String(body.code).trim().toUpperCase() !== branch.code) {
      await StockBranchService.assertCodeNotDuplicate({
        code: body.code,
        session,
        excludeId: branch._id,
      });
    }

    const allowed = ["name", "code", "address", "description", "city", "state", "stateCode", "branchRole"];
    allowed.forEach((key) => {
      if (body[key] !== undefined) branch[key] = body[key];
    });

    await branch.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: branch._id,
      action: "UPDATE",
      actor,
      before,
      after: branch.toObject(),
    });

    return branch;
  }

  static async softDeleteBranch(id, actor, session, dataAccess) {
    const branch = await StockBranchModel.findOne({ _id: id, isActive: true }).session(session);
    if (!branch) throw new Error("Branch not found");
    assertDataScope(branch, dataAccess);
    const before = branch.toObject();

    branch.isActive = false;
    branch.deletedAt = new Date();
    branch.deletedBy = actorSnapshot(actor);
    await branch.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: branch._id,
      action: "DELETE",
      actor,
      before,
      after: branch.toObject(),
    });

    return branch;
  }

  static async restoreBranch(id, actor, session, dataAccess) {
    const branch = await StockBranchModel.findOne({ _id: id }).session(session);
    if (!branch) throw new Error("Branch not found");
    assertDataScope(branch, dataAccess);
    if (branch.isActive) throw new Error("Branch is already active");
    const before = branch.toObject();

    branch.isActive = true;
    branch.deletedAt = null;
    branch.deletedBy = null;
    await branch.save({ session });

    await StockAuditLogService.recordAudit({
      entityType: ENTITY_TYPE,
      entityId: branch._id,
      action: "RESTORE",
      actor,
      before,
      after: branch.toObject(),
    });

    return branch;
  }
}
