import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import StockProductDefinitionService from "../services/stock.product.definition.service.js";
import { toPublicImagePath, deleteProductImageFile } from "../helpers/stock.upload.helper.js";
import {
  validateCreateProductDefinition,
  validateUpdateProductDefinition,
} from "../validators/stock.validator.js";

const log = getLogger(import.meta.url);

// Requests now arrive as multipart/form-data (to carry the optional image file
// alongside the rest of the payload), so the JSON body is sent as a single
// "data" field and parsed here. Plain JSON bodies (no file, no multipart) are
// still supported as a fallback for callers that never send an image.
function parseBody(req) {
  if (req.body && typeof req.body.data === "string") {
    return JSON.parse(req.body.data);
  }
  return req.body || {};
}

export default class StockProductDefinitionController {
  static async createProductDefinition(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const body = parseBody(req);
      validateCreateProductDefinition(body);

      if (req.file) {
        body.image = toPublicImagePath(req.file.filename);
      }

      const data = await StockProductDefinitionService.createProductDefinition(
        body,
        session
      );
      await session.commitTransaction();
      log.info("Stock product definition created");
      successResponseHandler(res, data, "Product definition created successfully");
    } catch (error) {
      await session.abortTransaction();
      // The file was already written to disk by multer before this handler ran —
      // if the DB write failed, don't leave an orphaned image behind.
      if (req.file) deleteProductImageFile(toPublicImagePath(req.file.filename));
      log.error("Error creating product definition", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async getAllProductDefinitions(req, res) {
    try {
      const { skip, limit, page } = paginate(req.query);

      // trackingMethod + productId were missing here. The service already reads
      // them, but an un-forwarded param arrives as undefined, so `if (productId)`
      // is false and the filter silently no-ops — the whole category comes back
      // instead of the one selected product.
      const { search, categoryId, showInactive, trackingMethod, productId } = req.query;

      const { data, total } = await StockProductDefinitionService.getAllProductDefinitions({
        skip,
        limit,
        search,
        categoryId,
        showInactive: showInactive === "true",
        trackingMethod,
        productId,
      });

      successResponseHandler(
        res,
        paginateReturn(data, total, page, limit),
        "Product definitions fetched successfully"
      );
    } catch (error) {
      log.error("Error fetching product definitions", error);
      errorResponseHandler(res, error);
    }
  }

  static async getGstRates(req, res) {
    try {
      const data = await StockProductDefinitionService.getGstRates();
      successResponseHandler(res, data, "GST rates fetched successfully");
    } catch (error) {
      log.error("Error fetching GST rates", error);
      errorResponseHandler(res, error);
    }
  }

  static async getProductDefinitionById(req, res) {
    try {
      const data = await StockProductDefinitionService.getProductDefinitionById(req.params.id);
      successResponseHandler(res, data, "Product definition fetched successfully");
    } catch (error) {
      log.error("Error fetching product definition", error);
      errorResponseHandler(res, error);
    }
  }

  static async getProductDefinitionsByCategory(req, res) {
    try {
      const data = await StockProductDefinitionService.getProductDefinitionsByCategory(
        req.params.catId
      );
      successResponseHandler(res, data, "Product definitions fetched successfully");
    } catch (error) {
      log.error("Error fetching product definitions by category", error);
      errorResponseHandler(res, error);
    }
  }

  static async updateProductDefinition(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const body = parseBody(req);
      validateUpdateProductDefinition(body);

      if (req.file) {
        body.image = toPublicImagePath(req.file.filename);
      }

      const data = await StockProductDefinitionService.updateProductDefinition(
        req.params.id,
        body,
        session
      );
      await session.commitTransaction();
      log.info("Stock product definition updated");
      successResponseHandler(res, data, "Product definition updated successfully");
    } catch (error) {
      await session.abortTransaction();
      if (req.file) deleteProductImageFile(toPublicImagePath(req.file.filename));
      log.error("Error updating product definition", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async softDeleteProductDefinition(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const deletedBy = req.user?._id ?? req.userId ?? null;
      const data = await StockProductDefinitionService.softDeleteProductDefinition(
        req.params.id,
        deletedBy,
        session
      );
      await session.commitTransaction();
      log.info("Stock product definition soft deleted");
      successResponseHandler(res, data, "Product definition deleted successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error deleting product definition", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async restoreProductDefinition(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockProductDefinitionService.restoreProductDefinition(
        req.params.id,
        session
      );
      await session.commitTransaction();
      log.info("Stock product definition restored");
      successResponseHandler(res, data, "Product definition restored successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error restoring product definition", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }
}