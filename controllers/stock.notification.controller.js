import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "../helpers/response.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import { paginate, paginateReturn } from "../helpers/pagination.helper.js";
import StockNotificationService from "../services/stock.notification.service.js";
import {
  validateCreateNotification,
  validateUpdateNotification,
} from "../validators/stock.validator.js";

const log = getLogger(import.meta.url);

export default class StockNotificationController {
  static async createNotification(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateCreateNotification(req.body);
      const data = await StockNotificationService.createNotification(req.body, req.user, session);
      await session.commitTransaction();
      log.info("Notification created");
      successResponseHandler(res, data, "Notification created successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error creating Notification", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async getAllNotifications(req, res) {
    try {
      const { skip, limit, page } = paginate(req.query);
      const { search, channel, showInactive } = req.query;
      const { data, total } = await StockNotificationService.getAllNotifications({
        skip,
        limit,
        search,
        channel,
        showInactive: showInactive === "true",
      });
      successResponseHandler(res, paginateReturn(data, total, page, limit), "Notifications fetched successfully");
    } catch (error) {
      log.error("Error fetching Notifications", error);
      errorResponseHandler(res, error);
    }
  }

  static async getNotificationById(req, res) {
    try {
      const data = await StockNotificationService.getNotificationById(req.params.id);
      successResponseHandler(res, data, "Notification fetched successfully");
    } catch (error) {
      log.error("Error fetching Notification by id", error);
      errorResponseHandler(res, error);
    }
  }

  static async updateNotification(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      validateUpdateNotification(req.body);
      const data = await StockNotificationService.updateNotification(req.params.id, req.body, req.user, session);
      await session.commitTransaction();
      log.info("Notification updated");
      successResponseHandler(res, data, "Notification updated successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error updating Notification", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async softDeleteNotification(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockNotificationService.softDeleteNotification(req.params.id, req.user, session);
      await session.commitTransaction();
      log.info("Notification soft deleted");
      successResponseHandler(res, data, "Notification deleted successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error deleting Notification", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  static async restoreNotification(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await StockNotificationService.restoreNotification(req.params.id, req.user, session);
      await session.commitTransaction();
      log.info("Notification restored");
      successResponseHandler(res, data, "Notification restored successfully");
    } catch (error) {
      await session.abortTransaction();
      log.error("Error restoring Notification", error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  }

  // Read-only lookup the Send Mail popup calls to prefill From/CC before send.
  static async resolveForVendor(req, res) {
    try {
      const channel = req.query.channel || "EMAIL";
      const data = await StockNotificationService.resolveForVendor(req.params.vendorId, channel);
      successResponseHandler(res, data, "Applicable notification resolved successfully");
    } catch (error) {
      log.error("Error resolving Notification for vendor", error);
      errorResponseHandler(res, error);
    }
  }
}
