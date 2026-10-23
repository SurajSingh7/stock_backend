import StockAlertContactModel from "../models/stock.alert.contact.model.js";
import StockAlertGroupModel from "../models/stock.alert.group.model.js";
import StockVendorModel from "../models/stock.vendor.model.js";
import {
  ALERT_CHANNEL,
  ALERT_GROUP_TYPE,
  ALERT_RECIPIENT_TYPE,
  CONTACT_RECIPIENT_TYPE,
} from "../constants/stock.enums.js";

/*
  Turns a rule's recipients into concrete addresses for one channel.

  Result: { targets: [{ kind, address, name, contactId }], skipped: [{ name, reason }] }
    kind EMAIL     address = email
    kind PHONE     address = WhatsApp digits (919876543210)
    kind WA_GROUP  address = the provider's group id

  `skipped` is not an error: "Ravi has no WhatsApp number" becomes a SKIPPED
  row in the log, so the admin can see who was missed and why, while everyone
  else still gets the message.
*/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Digits with country code. A bare 10-digit Indian mobile gets 91. */
export const normalizePhone = (raw) => {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  return digits.length >= 11 && digits.length <= 15 ? digits : "";
};

// WhatsApp goes to the WhatsApp number; the HRMS phone is only a fallback.
const whatsappOf = (c) => normalizePhone(c?.whatsappNumber) || normalizePhone(c?.phone);

const contactTarget = (channel, c) => {
  if (channel === ALERT_CHANNEL.EMAIL) {
    return EMAIL_RE.test(c.email || "")
      ? { target: { kind: "EMAIL", address: c.email, name: c.name, contactId: c._id } }
      : { skip: { name: c.name, reason: "no email" } };
  }
  if (channel === ALERT_CHANNEL.WHATSAPP) {
    const n = whatsappOf(c);
    return n
      ? { target: { kind: "PHONE", address: n, name: c.name, contactId: c._id } }
      : { skip: { name: c.name, reason: "no WhatsApp number" } };
  }
  if (channel === ALERT_CHANNEL.IN_APP) {
    return c.userId
      ? { target: { kind: "USER", address: String(c.userId), name: c.name, contactId: c._id } }
      : { skip: { name: c.name, reason: "not linked to a login" } };
  }
  return { skip: { name: c.name, reason: `channel ${channel} not supported` } };
};

export default class StockAlertRecipientService {
  /**
   * @param channel     ALERT_CHANNEL
   * @param recipients  rule recipients [{ type, refId, address }]
   * @param context     { owner: { userId, name, phone, email }, vendorId, vendorLine: "TO"|"CC" }
   */
  static async resolve(channel, recipients = [], context = {}) {
    const targets = [];
    const skipped = [];
    const push = (r) => (r.target ? targets.push(r.target) : skipped.push(r.skip));

    const contactIds = recipients.filter((r) => r.type === ALERT_RECIPIENT_TYPE.CONTACT && r.refId).map((r) => r.refId);
    const groupIds = recipients.filter((r) => r.type === ALERT_RECIPIENT_TYPE.GROUP && r.refId).map((r) => r.refId);

    const [contacts, groups] = await Promise.all([
      contactIds.length ? StockAlertContactModel.find({ _id: { $in: contactIds }, isActive: true }).lean() : [],
      groupIds.length
        ? StockAlertGroupModel.find({ _id: { $in: groupIds }, isActive: true })
            .populate({ path: "members", match: { isActive: true } })
            .lean()
        : [],
    ]);
    const contactById = new Map(contacts.map((c) => [String(c._id), c]));
    const groupById = new Map(groups.map((g) => [String(g._id), g]));

    for (const r of recipients) {
      switch (r.type) {
        case ALERT_RECIPIENT_TYPE.CONTACT: {
          const c = contactById.get(String(r.refId));
          if (!c) skipped.push({ name: "Removed contact", reason: "contact no longer exists" });
          else push(contactTarget(channel, c));
          break;
        }
        case ALERT_RECIPIENT_TYPE.GROUP: {
          const g = groupById.get(String(r.refId));
          if (!g) {
            skipped.push({ name: "Removed group", reason: "group no longer exists" });
            break;
          }
          // A WhatsApp group gets ONE message in the group itself.
          if (channel === ALERT_CHANNEL.WHATSAPP && g.type === ALERT_GROUP_TYPE.WHATSAPP_GROUP) {
            if (g.whatsappGroupId) {
              targets.push({ kind: "WA_GROUP", address: g.whatsappGroupId, name: g.whatsappGroupName || g.name, contactId: null });
            } else {
              skipped.push({ name: g.name, reason: "WhatsApp group not picked" });
            }
            break;
          }
          const members = (g.members || []).filter(Boolean);
          if (!members.length) skipped.push({ name: g.name, reason: "group has no members" });
          members.forEach((c) => push(contactTarget(channel, c)));
          break;
        }
        case ALERT_RECIPIENT_TYPE.CREATOR: {
          const owner = context.owner;
          if (!owner) {
            skipped.push({ name: "Record creator", reason: "record has no creator" });
            break;
          }
          // Prefer the person's contact (it may carry a separate WhatsApp
          // number); fall back to what HRMS stamped on the record.
          const linked = owner.userId
            ? await StockAlertContactModel.findOne({ userId: owner.userId, isActive: true }).lean()
            : null;
          push(
            contactTarget(channel, {
              _id: linked?._id || null,
              name: linked?.name || owner.name || "Record creator",
              email: linked?.email || owner.email,
              whatsappNumber: linked?.whatsappNumber || "",
              phone: linked?.phone || owner.phone,
              userId: owner.userId,
            })
          );
          break;
        }
        case ALERT_RECIPIENT_TYPE.VENDOR: {
          if (!context.vendorId) {
            skipped.push({ name: "Vendor", reason: "record has no vendor" });
            break;
          }
          const vendor = await StockVendorModel.findById(context.vendorId).select("name contacts").lean();
          const line = context.vendorLine || CONTACT_RECIPIENT_TYPE.TO;
          const people = (vendor?.contacts || []).filter((c) => c.recipientType === line);
          if (!people.length) {
            skipped.push({ name: vendor?.name || "Vendor", reason: `no vendor contact marked ${line}` });
          }
          people.forEach((c) => push(contactTarget(channel, { ...c, _id: null, name: `${c.name} (${vendor.name})` })));
          break;
        }
        case ALERT_RECIPIENT_TYPE.ADDRESS: {
          const a = String(r.address || "").trim();
          push(contactTarget(channel, { _id: null, name: a, email: a.toLowerCase(), phone: a }));
          break;
        }
        default:
          skipped.push({ name: String(r.type), reason: "unknown recipient type" });
      }
    }

    // One person in two groups gets one message.
    const seen = new Set();
    const unique = targets.filter((t) => {
      const k = `${t.kind}:${t.address}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { targets: unique, skipped };
  }
}
