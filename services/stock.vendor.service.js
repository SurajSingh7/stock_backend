import mongoose from "mongoose";
import { actorSnapshot } from "../models/plugins/actor.stamp.plugin.js";
import StockVendorModel from "../models/stock.vendor.model.js";
import StockInventoryItemModel from "../models/stock.inventory.item.model.js";
import { applyDataScope, isWithinDataScope } from "../helpers/data.scope.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockAuditLogService from "./stock.audit.log.service.js";

const log = getLogger(import.meta.url);
const ENTITY_TYPE = "vendors";


const escapeRegex = (str = "") => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SCOPE_MODULE_KEY = "vendors";

// Throws the resource's normal "not found" rather than a 403 — a 403 would
// confirm that a vendor outside the caller's branch exists.
const assertDataScope = (vendor, dataAccess) => {
  if (!isWithinDataScope(vendor, dataAccess, SCOPE_MODULE_KEY)) {
    throw new Error("Vendor not found");
  }
};

export default class StockVendorService {

  // Identity guards. All three match case-insensitively against ACTIVE vendors
  // only — a soft-deleted vendor does not block reuse of its name, GST or PAN,
  // which is the long-standing behaviour here.
  //
  // NOTE ON PAN: one PAN can legitimately hold several GSTINs — a company
  // registered in more than one state has the same PAN throughout. This rule
  // rejects that outright, one PAN one vendor, as specified. If a multi-state
  // vendor ever needs separate rows, the check to relax is this one: allow a
  // repeat PAN when the GST numbers differ.
  static async assertVendorNotDuplicate({ name, gstNumber, panNumber, excludeId, session }) {
    if (name) {
      const nameFilter = {
        name: new RegExp(`^${escapeRegex(name.trim())}$`, "i"),
        isActive: true,
      };
      if (excludeId) nameFilter._id = { $ne: excludeId };
      const existingName = await StockVendorModel.findOne(nameFilter).session(session).lean();
      if (existingName) throw new Error("A vendor with this name already exists.");
    }

    if (gstNumber) {
      const gstFilter = {
        "gst.gstNumber": new RegExp(`^${escapeRegex(gstNumber.trim())}$`, "i"),
        isActive: true,
      };
      if (excludeId) gstFilter._id = { $ne: excludeId };
      const existingGst = await StockVendorModel.findOne(gstFilter).session(session).lean();
      if (existingGst) throw new Error("A vendor with this GST number already exists.");
    }

    if (panNumber) {
      const panFilter = {
        panNumber: new RegExp(`^${escapeRegex(panNumber.trim())}$`, "i"),
        isActive: true,
      };
      if (excludeId) panFilter._id = { $ne: excludeId };
      const existingPan = await StockVendorModel.findOne(panFilter).session(session).lean();
      if (existingPan) {
        // Names the holder: "PAN already exists" leaves the user hunting for
        // which vendor has it, and the answer is usually a near-duplicate row
        // they meant to edit.
        throw new Error(
          `A vendor with this PAN already exists: ${existingPan.name}${
            existingPan.vendorCode ? ` (${existingPan.vendorCode})` : ""
          }.`
        );
      }
    }
  }


  static async generateNextVendorCode(session) {
    const PREFIX = "VEN";
    const PAD = 4;

    const last = await StockVendorModel.findOne({ vendorCode: { $regex: `^${PREFIX}\\d+$` } })
      .sort({ vendorCode: -1 })
      .session(session)
      .lean();

    let nextNum = 1;
    if (last?.vendorCode) {
      const match = last.vendorCode.match(/(\d+)$/);
      if (match) nextNum = parseInt(match[1], 10) + 1;
    }

    return `${PREFIX}${String(nextNum).padStart(PAD, "0")}`;
  }

  /*
    The main-vendor rule, checked on create and edit:
      - the main vendor exists, is active, and is itself a main vendor
        (one level only);
      - a vendor is never its own main;
      - a vendor that already has child firms cannot become someone's child.
    Returns the id to store (null = this vendor is a main vendor).
  */
  static async _resolveParent(parentVendorId, selfId, session) {
    if (!parentVendorId) return null;
    if (!mongoose.Types.ObjectId.isValid(parentVendorId)) throw new Error("Main vendor is not valid");
    if (selfId && String(parentVendorId) === String(selfId)) throw new Error("A vendor cannot be its own main vendor");
    const parent = await StockVendorModel.findOne({ _id: parentVendorId, isActive: true })
      .select("name parentVendorId")
      .session(session ?? null)
      .lean();
    if (!parent) throw new Error("Main vendor not found");
    if (parent.parentVendorId) {
      throw new Error(`${parent.name} is itself under another main vendor — pick that main vendor instead`);
    }
    if (selfId) {
      const hasChildren = await StockVendorModel.exists({ parentVendorId: selfId, isActive: true }).session(session ?? null);
      if (hasChildren) throw new Error("This vendor has its own child vendors, so it cannot be put under another vendor");
    }
    return parent._id;
  }

  static async createVendor(body, actor, session) {
    try {
      await StockVendorService.assertVendorNotDuplicate({
        name: body.name,
        gstNumber: body?.gst?.gstNumber,
        panNumber: body.panNumber,
        session,
      });

      // Always the creator's branch. body.branchId is deliberately ignored:
      // the form shows the field disabled, and a UI that says "you cannot
      // change this" while the API happily accepts a different value is not a
      // rule, it is decoration. Reassignment happens on edit, admin only.
      const branchId = actor?.branchId || null;
      if (!branchId) {
        // Refused rather than saved with a null branch: such a vendor is
        // invisible to every user on Own-branch scope, with nothing on screen
        // to explain why it never appears.
        throw new Error(
          "Your account has no branch assigned, so this vendor would belong to no branch and stay hidden. Ask an administrator to set your branch in HRMS."
        );
      }

      const docData = {
        name: body.name,
        branchId,
        vendorAlias: body.vendorAlias || "",
        gst: body.gst || {},
        panNumber: body.panNumber || "",
        paymentTerms: body.paymentTerms,
        tdsRate: Number(body.tdsRate) || 0,
        parentVendorId: await StockVendorService._resolveParent(body.parentVendorId, null, session),
        notes: body.notes || "",
        contacts: body.contacts || [],
        address: body.address || {},
        assignedProducts: body.assignedProducts || [],
        bankAccounts: body.bankAccounts || [],
      };

      const MAX_ATTEMPTS = 5;
      let lastErr = null;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const vendorCode = await StockVendorService.generateNextVendorCode(session);
        try {
          const [vendor] = await StockVendorModel.create([{ ...docData, vendorCode }], { session });
          await StockAuditLogService.recordAudit({
            entityType: ENTITY_TYPE, entityId: vendor._id, action: "CREATE", actor, before: null, after: vendor.toObject(),
          });
          return vendor;
        } catch (err) {
          if (err?.code === 11000 && err?.keyPattern?.vendorCode) {
            lastErr = err;
            continue; // someone else just took this number — retry with the next one
          }
          throw err;
        }
      }

      throw lastErr || new Error("Could not generate a unique vendor code, please try again");
    } catch (error) {
      throw error;
    }
  }

 static async getAllVendors(query, dataAccess) {
    try {
      const { search, showInactive, status, categoryId, productId, branchId, group, parentId } = query;
      const { skip, limit, page } = paginate(query);

      const filter = {};
      // status=ACTIVE|INACTIVE filters here, so paging and totals are right for
      // either tab (filtering one page in the browser lost deleted vendors that
      // sat on a later page). Without it: showInactive=true is "everything",
      // anything else "active only" — what the pickers send.
      if (status === "INACTIVE") filter.isActive = false;
      else if (status === "ACTIVE" || showInactive !== "true") filter.isActive = true;
      applyDataScope(filter, dataAccess, SCOPE_MODULE_KEY);

      if (search) {
        const regex = new RegExp(escapeRegex(search.trim()), "i");
        filter.$or = [{ name: regex }, { vendorCode: regex }, { "gst.gstNumber": regex }, { "contacts.phone": regex }];
      }

      // The branch a vendor belongs to (the list's Branch filter).
      if (branchId) {
        if (!mongoose.Types.ObjectId.isValid(branchId)) return paginateReturn([], 0, page, limit);
        filter.branchId = new mongoose.Types.ObjectId(branchId);
      }

      // RULE 23 — dropdown/picker filters are applied in the SERVICE layer.
      // Vendors.jsx sends ?categoryId= / ?productId= from its leaf-category
      // and dependent-product pickers; never fetch-all-then-filter in the
      // browser (it silently breaks limit/total — Section 20, lesson 3).
      // Both match against the vendor's assignedProducts sub-documents.
      // An unparseable id yields zero rows instead of a CastError 500.
      if (categoryId) {
        if (!mongoose.Types.ObjectId.isValid(categoryId)) {
          return paginateReturn([], 0, page, limit);
        }
        filter["assignedProducts.categoryId"] = new mongoose.Types.ObjectId(categoryId);
      }

      if (productId) {
        if (!mongoose.Types.ObjectId.isValid(productId)) {
          return paginateReturn([], 0, page, limit);
        }
        filter["assignedProducts.products.productId"] = new mongoose.Types.ObjectId(productId);
      }

      /*
        Vendor groups.
          parentId=X      → the child vendors of main vendor X (row expand)
          group=top       → main and stand-alone vendors only (children sit
                            under their main); ignored while searching, so a
                            child firm can still be found by its own name
          group=groups    → only main vendors that have child vendors
          group=mains     → every main vendor, for the "Main Vendor" picker
      */
      if (parentId) {
        if (!mongoose.Types.ObjectId.isValid(parentId)) return paginateReturn([], 0, page, limit);
        filter.parentVendorId = new mongoose.Types.ObjectId(parentId);
      } else if (group === "mains" || (group === "top" && !search && status !== "INACTIVE")) {
        // (The Inactive tab lists every deleted vendor flat — a deleted child
        // firm has no main vendor row there to sit under.)
        filter.parentVendorId = null;
      } else if (group === "groups") {
        const parents = await StockVendorModel.distinct("parentVendorId", { isActive: true, parentVendorId: { $ne: null } });
        filter._id = { $in: parents };
      }

      const [data, total] = await Promise.all([
        StockVendorModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        StockVendorModel.countDocuments(filter),
      ]);

      // Each row says how many child vendors it has, and a child row names its main.
      const ids = data.map((v) => v._id);
      const childCounts = ids.length
        ? await StockVendorModel.aggregate([
            { $match: { parentVendorId: { $in: ids }, isActive: true } },
            { $group: { _id: "$parentVendorId", n: { $sum: 1 } } },
          ])
        : [];
      const countBy = new Map(childCounts.map((c) => [String(c._id), c.n]));
      const parentIds = [...new Set(data.map((v) => v.parentVendorId).filter(Boolean).map(String))];
      const parents = parentIds.length
        ? await StockVendorModel.find({ _id: { $in: parentIds } }).select("name").lean()
        : [];
      const parentName = new Map(parents.map((p) => [String(p._id), p.name]));
      // The branch each vendor belongs to, by name, for the list's Branch column.
      const branchIds = [...new Set(data.map((v) => v.branchId).filter(Boolean).map(String))];
      const branches = branchIds.length
        ? await mongoose.model("branches").find({ _id: { $in: branchIds } }).select("name code").lean()
        : [];
      const branchById = new Map(branches.map((b) => [String(b._id), b]));
      data.forEach((v) => {
        v.childCount = countBy.get(String(v._id)) || 0;
        v.parentVendorName = v.parentVendorId ? parentName.get(String(v.parentVendorId)) || "" : "";
        const b = v.branchId ? branchById.get(String(v.branchId)) : null;
        v.branchName = b?.name || "";
        v.branchCode = b?.code || "";
      });

      return paginateReturn(data, total, page, limit);
    } catch (error) {
      throw error;
    }
  }

  // includeInactive is opt-in so the edit route keeps refusing soft-deleted
  // vendors; only the read-only detail view asks for them, which is what makes
  // "inspect before restoring" possible from the Inactive tab.
  static async getVendorById(id, dataAccess, { includeInactive = false } = {}) {
    try {
      const vendor = await StockVendorModel.findOne({ _id: id, ...(includeInactive ? {} : { isActive: true }) })
        .populate("assignedProducts.categoryId", "name type")
        .populate("assignedProducts.products.productId", "name warrantyMonths")
        // Name only, and flattened below — the form binds branchId to a select,
        // so the field itself has to stay a plain id.
        .populate("branchId", "name")
        .lean();
      if (!vendor) throw new Error("Vendor not found");
      assertDataScope(vendor, dataAccess);

      // Flatten the populated branch back into id + name.
      if (vendor.branchId && typeof vendor.branchId === "object") {
        vendor.branchName = vendor.branchId.name || "";
        vendor.branchId = vendor.branchId._id;
      }
      return vendor;
    } catch (error) {
      throw error;
    }
  }

  /*
    The whole group a vendor belongs to: its main vendor and every child firm,
    with how to reach each — so when one firm is a problem, the others are one
    click away. Limited to what the caller may see.
  */
  static async getVendorGroup(id, dataAccess) {
    const vendor = await StockVendorModel.findOne({ _id: id }).select("parentVendorId").lean();
    if (!vendor) throw new Error("Vendor not found");
    const mainId = vendor.parentVendorId || vendor._id;
    const filter = applyDataScope(
      { isActive: true, $or: [{ _id: mainId }, { parentVendorId: mainId }] },
      dataAccess,
      SCOPE_MODULE_KEY
    );
    const rows = await StockVendorModel.find(filter)
      .select("name vendorCode parentVendorId contacts gst.gstNumber paymentTerms tdsRate")
      .lean();
    const shape = (v) => {
      const c = (v.contacts || []).find((x) => x.label === "PRIMARY") || (v.contacts || [])[0] || {};
      return {
        _id: v._id, name: v.name, vendorCode: v.vendorCode || "", gstNumber: v.gst?.gstNumber || "",
        contactName: c.name || "", phone: c.phone || "", email: c.email || "",
        paymentTerms: v.paymentTerms || "", tdsRate: v.tdsRate || 0,
        isCurrent: String(v._id) === String(id),
      };
    };
    const main = rows.find((v) => String(v._id) === String(mainId)) || null;
    return {
      main: main ? shape(main) : null,
      children: rows.filter((v) => String(v._id) !== String(mainId)).map(shape).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  static async updateVendor(id, body, actor, session, dataAccess) {
    try {
      if (Object.prototype.hasOwnProperty.call(body, "vendorCode")) {
        throw new Error("vendorCode cannot be updated once set");
      }

      const vendor = await StockVendorModel.findOne({ _id: id, isActive: true }).session(session);
      if (!vendor) throw new Error("Vendor not found");
      assertDataScope(vendor, dataAccess);

      // Flatten the populated branch back into id + name.
      if (vendor.branchId && typeof vendor.branchId === "object") {
        vendor.branchName = vendor.branchId.name || "";
        vendor.branchId = vendor.branchId._id;
      }
      const before = vendor.toObject();

      await StockVendorService.assertVendorNotDuplicate({
        name: body.name,
        gstNumber: body?.gst?.gstNumber,
        panNumber: body.panNumber,
        excludeId: id,
        session,
      });

      // Reassigning a vendor to another branch is admin-only. Everyone else
      // sees the field disabled, and the list here is what actually enforces
      // it. Admins already bypass data scope entirely, so this grants them
      // nothing they did not have.
      const updatableFields = [
        ...(actor?.isAdmin ? ["branchId"] : []),
        "name",
        "vendorAlias",
        "gst",
        "panNumber",
        "paymentTerms",
        "tdsRate",
        "parentVendorId",
        "notes",
        "contacts",
        "address",
        "assignedProducts",
        "bankAccounts",
      ];
      if (Object.prototype.hasOwnProperty.call(body, "parentVendorId")) {
        body = { ...body, parentVendorId: await StockVendorService._resolveParent(body.parentVendorId, vendor._id, session) };
      }
      updatableFields.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(body, field)) {
          vendor[field] = body[field];
        }
      });

      await vendor.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: vendor._id, action: "UPDATE", actor, before, after: vendor.toObject(),
      });
      return vendor;
    } catch (error) {
      throw error;
    }
  }

  static async softDeleteVendor(id, actor, session, dataAccess) {
    try {
      const vendor = await StockVendorModel.findOne({ _id: id, isActive: true }).session(session);
      if (!vendor) throw new Error("Vendor not found");
      assertDataScope(vendor, dataAccess);

      // Flatten the populated branch back into id + name.
      if (vendor.branchId && typeof vendor.branchId === "object") {
        vendor.branchName = vendor.branchId.name || "";
        vendor.branchId = vendor.branchId._id;
      }
      const before = vendor.toObject();

      // Blocked while stock from this vendor is still on the books — same rule
      // as product-definition delete.
      const referenced = await StockInventoryItemModel.exists({ vendorId: vendor._id, isActive: true }).session(session);
      if (referenced) {
        throw new Error("Cannot delete — this vendor is referenced by active inventory items");
      }

      // A main vendor with live child firms would leave them pointing at
      // nothing — move or remove the children first.
      const children = await StockVendorModel.countDocuments({ parentVendorId: vendor._id, isActive: true }).session(session);
      if (children) {
        throw new Error(`This is the main vendor of ${children} other vendor${children > 1 ? "s" : ""} — move them under another main vendor first`);
      }

      vendor.isActive = false;
      vendor.deletedAt = new Date();
      vendor.deletedBy = actorSnapshot(actor);
      await vendor.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: vendor._id, action: "DELETE", actor, before, after: vendor.toObject(),
      });
      return vendor;
    } catch (error) {
      throw error;
    }
  }

  static async restoreVendor(id, actor, session, dataAccess) {
    try {
      const vendor = await StockVendorModel.findOne({ _id: id, isActive: false }).session(session);
      if (!vendor) throw new Error("Inactive vendor not found");
      assertDataScope(vendor, dataAccess);
      const before = vendor.toObject();

      vendor.isActive = true;
      vendor.deletedAt = null;
      vendor.deletedBy = null;
      await vendor.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: vendor._id, action: "RESTORE", actor, before, after: vendor.toObject(),
      });
      return vendor;
    } catch (error) {
      throw error;
    }
  }
}