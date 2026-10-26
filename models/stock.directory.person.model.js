import mongoose from "mongoose";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";
import {
  ASSIGNEE_KIND_ARRAY,
  PERSON_SOURCE_ARRAY,
  PERSON_SOURCE,
  ITEM_REQUEST_CHANNEL_ARRAY,
} from "../constants/stock.enums.js";

const { Schema } = mongoose;

/*
  directory_people — the People Directory: everyone stock can be with.

  The people API (HRMS employees and website subscribers behind one search)
  is the source of truth; a row lands here the first time someone is picked
  from it, so the stock records that point at them keep a local copy. Anyone
  the API does not have (yet) is typed in by hand — source MANUAL.

  `key` makes a person one row however they arrived:
    EMPLOYEE    EMP:<EMPLOYEE CODE>
    SUBSCRIBER  SUB:<CHANNEL>:<ORDER ID>
  so the same employee picked from the API and typed in by hand can never be
  two people.
*/
const directoryPersonSchema = new Schema(
  {
    kind: { type: String, enum: ASSIGNEE_KIND_ARRAY, required: true },
    source: { type: String, enum: PERSON_SOURCE_ARRAY, default: PERSON_SOURCE.MANUAL },
    key: { type: String, trim: true, uppercase: true, required: true },
    // The person's id in the people API, when they came from it.
    externalId: { type: String, trim: true, default: "" },

    name: { type: String, trim: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },

    // EMPLOYEE
    employeeCode: { type: String, trim: true, default: "" },

    // SUBSCRIBER — the website the order belongs to (the test simulator, until
    // the real site is live), and the stock-side registry row for it, linked
    // once stock is entered against them.
    channel: { type: String, enum: ITEM_REQUEST_CHANNEL_ARRAY, default: null },
    orderId: { type: String, trim: true, default: "" },
    username: { type: String, trim: true, default: "" },
    serviceType: { type: String, trim: true, default: "" },
    subscriberId: { type: Schema.Types.ObjectId, ref: "subscribers", default: null },

    // Everything else the API knows (department, address, plan …), as it sent it.
    extraFields: { type: Schema.Types.Mixed, default: {} },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

directoryPersonSchema.index({ key: 1 }, { unique: true });
directoryPersonSchema.index({ kind: 1, name: 1 });

directoryPersonSchema.plugin(actorStampPlugin);

const StockDirectoryPersonModel = mongoose.model("directory_people", directoryPersonSchema, "directory_people");

export default StockDirectoryPersonModel;
