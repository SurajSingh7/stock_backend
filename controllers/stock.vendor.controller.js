import mongoose from "mongoose";
import StockVendorService from "../services/stock.vendor.service.js";
import { validateCreateVendor, validateUpdateVendor } from "../validators/stock.validator.js";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";

const log = getLogger(import.meta.url);

export default class StockVendorController {
  static async createVendor(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateCreateVendor(req.body);
      const vendor = await StockVendorService.createVendor(req.body, req.user, session);
      await session.commitTransaction();
      successResponseHandler(res, vendor, "Vendor created successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error creating vendor", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async getAllVendors(req, res) {
    try {
      const data = await StockVendorService.getAllVendors(req.query, req.dataAccess);
      successResponseHandler(res, data, "Vendors fetched successfully");
    } catch (error) {
      log.error("Error fetching vendors", error);
      errorResponseHandler(res, error);
    }
  }

  static async getVendorById(req, res) {
    try {
      const vendor = await StockVendorService.getVendorById(req.params.id, req.dataAccess);
      successResponseHandler(res, vendor, "Vendor fetched successfully");
    } catch (error) {
      log.error("Error fetching vendor", error);
      errorResponseHandler(res, error);
    }
  }

  static async updateVendor(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateUpdateVendor(req.body);
      const vendor = await StockVendorService.updateVendor(req.params.id, req.body, req.user, session, req.dataAccess);
      await session.commitTransaction();
      successResponseHandler(res, vendor, "Vendor updated successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error updating vendor", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async softDeleteVendor(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      await StockVendorService.softDeleteVendor(req.params.id, req.user, session, req.dataAccess);
      await session.commitTransaction();
      successResponseHandler(res, null, "Vendor deleted successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error deleting vendor", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async restoreVendor(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const vendor = await StockVendorService.restoreVendor(req.params.id, req.user, session, req.dataAccess);
      await session.commitTransaction();
      successResponseHandler(res, vendor, "Vendor restored successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error restoring vendor", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }
}