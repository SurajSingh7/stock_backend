import mongoose from "mongoose";
import StockAlertContactModel from "../models/stock.alert.contact.model.js";
import StockAlertGroupModel from "../models/stock.alert.group.model.js";
import StockAuditLogService from "./stock.audit.log.service.js";
import { normalizePhone } from "./stock.alert.recipient.service.js";
import { ALERT_CONTACT_TYPE_ARRAY, ALERT_GROUP_TYPE, ALERT_GROUP_TYPE_ARRAY } from "../constants/stock.enums.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const escapeRegex = (s = "") => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const cleanContact = (body, current = {}) => {
  const next = { ...current };
  if (body.name !== undefined) next.name = String(body.name || "").trim();
  if (body.type !== undefined) next.type = body.type;
  if (body.email !== undefined) next.email = String(body.email || "").trim().toLowerCase();
  if (body.designation !== undefined) next.designation = String(body.designation || "").trim();
  if (body.note !== undefined) next.note = String(body.note || "").trim();
  if (body.userId !== undefined) next.userId = body.userId || null;
  for (const field of ["phone", "whatsappNumber"]) {
    if (body[field] === undefined) continue;
    const raw = String(body[field] || "").trim();
    const n = raw ? normalizePhone(raw) : "";
    if (raw && !n) throw new Error(`Invalid ${field === "phone" ? "phone" : "WhatsApp number"} — use 10 digits or digits with country code`);
    next[field] = n;
  }

  if (!next.name) throw new Error("Contact name is required");
  if (next.type && !ALERT_CONTACT_TYPE_ARRAY.includes(next.type)) throw new Error("Invalid contact type");
  if (next.email && !EMAIL_RE.test(next.email)) throw new Error("Invalid email");
  if (next.userId && !mongoose.isValidObjectId(next.userId)) throw new Error("Invalid linked user");
  if (!next.email && !next.phone && !next.whatsappNumber && !next.userId) {
    throw new Error("A contact needs at least an email, a phone or a WhatsApp number");
  }
  return next;
};

export class StockAlertContactService {
  static async list({ skip = 0, limit = 50, search, type, showInactive } = {}) {
    const filter = showInactive ? {} : { isActive: true };
    if (type) filter.type = type;
    if (search) {
      const rx = { $regex: escapeRegex(search.trim()), $options: "i" };
      filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { whatsappNumber: rx }, { designation: rx }];
    }
    const [data, total] = await Promise.all([
      StockAlertContactModel.find(filter).sort({ name: 1 }).skip(skip).limit(limit).lean(),
      StockAlertContactModel.countDocuments(filter),
    ]);
    return { data, total };
  }

  static async create(body, actor) {
    const data = cleanContact(body);
    if (data.userId && (await StockAlertContactModel.exists({ userId: data.userId, isActive: true }))) {
      throw new Error("A contact for this user already exists");
    }
    const doc = await StockAlertContactModel.create(data);
    await StockAuditLogService.recordAudit({ entityType: "alert_contacts", entityId: doc._id, action: "CREATE", actor, after: doc.toObject() });
    return doc;
  }

  static async update(id, body, actor) {
    const doc = await StockAlertContactModel.findOne({ _id: id, isActive: true });
    if (!doc) throw new Error("Contact not found");
    const before = doc.toObject();
    const data = cleanContact(body, before);
    if (
      data.userId &&
      String(data.userId) !== String(before.userId || "") &&
      (await StockAlertContactModel.exists({ userId: data.userId, isActive: true, _id: { $ne: doc._id } }))
    ) {
      throw new Error("A contact for this user already exists");
    }
    doc.set(data);
    await doc.save();
    await StockAuditLogService.recordAudit({ entityType: "alert_contacts", entityId: doc._id, action: "UPDATE", actor, before, after: doc.toObject() });
    return doc;
  }

  static async remove(id, actor) {
    const doc = await StockAlertContactModel.findOne({ _id: id, isActive: true });
    if (!doc) throw new Error("Contact not found");
    const before = doc.toObject();
    doc.isActive = false;
    doc.deletedAt = new Date();
    await doc.save();
    // Out of every group too, so no group lists a ghost.
    await StockAlertGroupModel.updateMany({ members: doc._id }, { $pull: { members: doc._id } });
    await StockAuditLogService.recordAudit({ entityType: "alert_contacts", entityId: doc._id, action: "DELETE", actor, before, after: doc.toObject() });
    return doc;
  }
}

const cleanGroup = async (body, current = {}) => {
  const next = { ...current };
  if (body.name !== undefined) next.name = String(body.name || "").trim();
  if (body.type !== undefined) next.type = body.type;
  if (body.description !== undefined) next.description = String(body.description || "").trim();
  if (body.whatsappGroupId !== undefined) next.whatsappGroupId = String(body.whatsappGroupId || "").trim();
  if (body.whatsappGroupName !== undefined) next.whatsappGroupName = String(body.whatsappGroupName || "").trim();
  if (body.members !== undefined) {
    if (!Array.isArray(body.members)) throw new Error("members must be a list");
    const ids = [...new Set(body.members.map(String))];
    if (ids.some((x) => !mongoose.isValidObjectId(x))) throw new Error("Invalid member");
    const found = await StockAlertContactModel.countDocuments({ _id: { $in: ids }, isActive: true });
    if (found !== ids.length) throw new Error("One of the members is not an active contact");
    next.members = ids;
  }

  if (!next.name) throw new Error("Group name is required");
  if (!ALERT_GROUP_TYPE_ARRAY.includes(next.type || ALERT_GROUP_TYPE.LIST)) throw new Error("Invalid group type");
  if (next.type === ALERT_GROUP_TYPE.WHATSAPP_GROUP && !next.whatsappGroupId) {
    throw new Error("Pick the WhatsApp group this group sends to");
  }
  if ((next.type || ALERT_GROUP_TYPE.LIST) === ALERT_GROUP_TYPE.LIST && !(next.members || []).length) {
    throw new Error("A list group needs at least one member");
  }
  return next;
};

export class StockAlertGroupService {
  static async list({ skip = 0, limit = 50, search, showInactive } = {}) {
    const filter = showInactive ? {} : { isActive: true };
    if (search) filter.name = { $regex: escapeRegex(search.trim()), $options: "i" };
    const [data, total] = await Promise.all([
      StockAlertGroupModel.find(filter)
        .populate({ path: "members", select: "name email phone whatsappNumber isActive" })
        .sort({ name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StockAlertGroupModel.countDocuments(filter),
    ]);
    return { data, total };
  }

  static async create(body, actor) {
    const data = await cleanGroup(body);
    const doc = await StockAlertGroupModel.create(data);
    await StockAuditLogService.recordAudit({ entityType: "alert_groups", entityId: doc._id, action: "CREATE", actor, after: doc.toObject() });
    return doc;
  }

  static async update(id, body, actor) {
    const doc = await StockAlertGroupModel.findOne({ _id: id, isActive: true });
    if (!doc) throw new Error("Group not found");
    const before = doc.toObject();
    doc.set(await cleanGroup(body, { ...before, members: (before.members || []).map(String) }));
    await doc.save();
    await StockAuditLogService.recordAudit({ entityType: "alert_groups", entityId: doc._id, action: "UPDATE", actor, before, after: doc.toObject() });
    return doc;
  }

  static async remove(id, actor) {
    const doc = await StockAlertGroupModel.findOne({ _id: id, isActive: true });
    if (!doc) throw new Error("Group not found");
    const before = doc.toObject();
    doc.isActive = false;
    doc.deletedAt = new Date();
    await doc.save();
    await StockAuditLogService.recordAudit({ entityType: "alert_groups", entityId: doc._id, action: "DELETE", actor, before, after: doc.toObject() });
    return doc;
  }
}
