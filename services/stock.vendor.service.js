import mongoose from "mongoose";
import StockVendorModel from "../models/stock.vendor.model.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockAuditLogService from "./stock.audit.log.service.js";

const log = getLogger(import.meta.url);
const ENTITY_TYPE = "vendors";


const escapeRegex = (str = "") => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export default class StockVendorService {

  static async assertVendorNotDuplicate({ name, gstNumber, excludeId, session }) {
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

  static async createVendor(body, actor, session) {
    try {
      await StockVendorService.assertVendorNotDuplicate({
        name: body.name,
        gstNumber: body?.gst?.gstNumber,
        session,
      });

      const docData = {
        name: body.name,
        vendorAlias: body.vendorAlias || "",
        gst: body.gst || {},
        panNumber: body.panNumber || "",
        paymentTerms: body.paymentTerms,
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

 static async getAllVendors(query) {
    try {
      const { search, showInactive, categoryId, productId } = query;
      const { skip, limit, page } = paginate(query);

      const filter = {};
      // NOTE (known constraint — same as Field Definitions / Product
      // Definitions, Section 8.2/14): showInactive only supports "show
      // everything" vs "active only" here. There is no server-side
      // "inactive only" mode — that tab is handled client-side in Vendors.jsx.
      if (showInactive !== "true") filter.isActive = true;

      if (search) {
        const regex = new RegExp(escapeRegex(search.trim()), "i");
        filter.$or = [{ name: regex }, { vendorCode: regex }, { "gst.gstNumber": regex }];
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

      const [data, total] = await Promise.all([
        StockVendorModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        StockVendorModel.countDocuments(filter),
      ]);

      return paginateReturn(data, total, page, limit);
    } catch (error) {
      throw error;
    }
  }

  static async getVendorById(id) {
    try {
      const vendor = await StockVendorModel.findOne({ _id: id, isActive: true })
        .populate("assignedProducts.categoryId", "name type")
        .populate("assignedProducts.products.productId", "name warrantyYears")
        .lean();
      if (!vendor) throw new Error("Vendor not found");
      return vendor;
    } catch (error) {
      throw error;
    }
  }

  static async updateVendor(id, body, actor, session) {
    try {
      if (Object.prototype.hasOwnProperty.call(body, "vendorCode")) {
        throw new Error("vendorCode cannot be updated once set");
      }

      const vendor = await StockVendorModel.findOne({ _id: id, isActive: true }).session(session);
      if (!vendor) throw new Error("Vendor not found");
      const before = vendor.toObject();

      await StockVendorService.assertVendorNotDuplicate({
        name: body.name,
        gstNumber: body?.gst?.gstNumber,
        excludeId: id,
        session,
      });

      const updatableFields = [
        "name",
        "vendorAlias",
        "gst",
        "panNumber",
        "paymentTerms",
        "notes",
        "contacts",
        "address",
        "assignedProducts",
        "bankAccounts",
      ];
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

  static async softDeleteVendor(id, actor, session) {
    try {
      const vendor = await StockVendorModel.findOne({ _id: id, isActive: true }).session(session);
      if (!vendor) throw new Error("Vendor not found");
      const before = vendor.toObject();

      // NOTE: stock_inventory_items is not built yet (spec Section 8.5).
      // Once it exists, uncomment this block so delete is blocked exactly
      // like fieldDefinition/productDefinition delete (Section 14):
      //
      // const StockInventoryItemModel = (await import("../models/stock.inventory.item.model.js")).default;
      // const referenced = await StockInventoryItemModel.exists({
      //   vendorId: id,
      //   isActive: true,
      // }).session(session);
      // if (referenced) {
      //   throw new Error("Cannot delete — this vendor is referenced by active inventory items");
      // }

      vendor.isActive = false;
      vendor.deletedAt = new Date();
      vendor.deletedBy = actor?._id ?? null;
      await vendor.save({ session });
      await StockAuditLogService.recordAudit({
        entityType: ENTITY_TYPE, entityId: vendor._id, action: "DELETE", actor, before, after: vendor.toObject(),
      });
      return vendor;
    } catch (error) {
      throw error;
    }
  }

  static async restoreVendor(id, actor, session) {
    try {
      const vendor = await StockVendorModel.findOne({ _id: id, isActive: false }).session(session);
      if (!vendor) throw new Error("Inactive vendor not found");
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