import StockVendorModel from "../models/stock.vendor.model.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import { getLogger } from "../helpers/logger.helper.js";

const log = getLogger(import.meta.url);

// Ported from StockCategoryService.escapeRegex — keep this identical across
// modules rather than reinventing it per Rule 21/24. If the category service
// exports it, import that one instead of duplicating here.
const escapeRegex = (str = "") => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export default class StockVendorService {
  /**
   * Active-only, case-insensitive, regex-escaped duplicate check on
   * name + gst.gstNumber — identical pattern to
   * StockCategoryService.assertNameNotDuplicate (Rule 21/24).
   */
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

  static async createVendor(body, userId, session) {
    try {
      await StockVendorService.assertVendorNotDuplicate({
        name: body.name,
        gstNumber: body?.gst?.gstNumber,
        session,
      });

      const [vendor] = await StockVendorModel.create(
        [
          {
            name: body.name,
            vendorCode: body.vendorCode || null,
            vendorAlias: body.vendorAlias || "",
            gst: body.gst || {},
            panNumber: body.panNumber || "",
            paymentTerms: body.paymentTerms,
            notes: body.notes || "",
            contacts: body.contacts || [],
            address: body.address || {},
            assignedProducts: body.assignedProducts || [],
            bankAccounts: body.bankAccounts || [],
          },
        ],
        { session }
      );

      return vendor;
    } catch (error) {
      throw error;
    }
  }

  static async getAllVendors(query) {
    try {
      const { search, showInactive } = query;
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
        .populate("assignedProducts.productIds", "name")
        .lean();
      if (!vendor) throw new Error("Vendor not found");
      return vendor;
    } catch (error) {
      throw error;
    }
  }

  static async updateVendor(id, body, session) {
    try {
      if (Object.prototype.hasOwnProperty.call(body, "vendorCode")) {
        throw new Error("vendorCode cannot be updated once set");
      }

      const vendor = await StockVendorModel.findOne({ _id: id, isActive: true }).session(session);
      if (!vendor) throw new Error("Vendor not found");

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
      return vendor;
    } catch (error) {
      throw error;
    }
  }

  static async softDeleteVendor(id, userId, session) {
    try {
      const vendor = await StockVendorModel.findOne({ _id: id, isActive: true }).session(session);
      if (!vendor) throw new Error("Vendor not found");

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
      vendor.deletedBy = userId || null;
      await vendor.save({ session });
      return vendor;
    } catch (error) {
      throw error;
    }
  }

  static async restoreVendor(id, session) {
    try {
      const vendor = await StockVendorModel.findOne({ _id: id, isActive: false }).session(session);
      if (!vendor) throw new Error("Inactive vendor not found");

      vendor.isActive = true;
      vendor.deletedAt = null;
      vendor.deletedBy = null;
      await vendor.save({ session });
      return vendor;
    } catch (error) {
      throw error;
    }
  }
}