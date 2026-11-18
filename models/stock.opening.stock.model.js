import mongoose from "mongoose";
import { actorStampPlugin, actorSchema } from "./plugins/actor.stamp.plugin.js";
import {
  TRACKING_METHODS_ARRAY,
  UNIT_TYPES_ARRAY,
  ITEM_CONDITION_ARRAY,
  ITEM_CONDITION,
  OPENING_STOCK_STATUS,
  OPENING_STOCK_STATUS_ARRAY,
  OPENING_STOCK_STATE,
  OPENING_STOCK_STATE_ARRAY,
  OPENING_STOCK_KIND,
  OPENING_STOCK_KIND_ARRAY,
  ASSIGNEE_KIND_ARRAY,
} from "../constants/stock.enums.js";

const { Schema } = mongoose;

/*
  One unit (individual-tracked) or one batch (quantity-tracked) of stock that
  was already on hand before this system — what the store keeper types or
  uploads. Posting turns each line into exactly one inventory item.

  Everything about the stock's past is optional on purpose: old stock rarely
  has its paperwork. What is known is captured; what is not stays null and
  shows as "Unknown", never as a guess.
*/
const openingStockLineSchema = new Schema(
  {
    productDefinitionId: { type: Schema.Types.ObjectId, ref: "product_definitions", required: true },
    // Snapshots — the line still reads correctly after a product edit.
    productName: { type: String, trim: true, default: "" },
    trackingMethod: { type: String, enum: TRACKING_METHODS_ARRAY, required: true },
    unit: { type: String, enum: UNIT_TYPES_ARRAY, default: null },

    fieldValues: { type: Schema.Types.Mixed, default: {} },
    // Quantity-tracked only; null for an individual unit (which is always 1).
    quantity: { type: Number, default: null, min: 0 },

    vendorId: { type: Schema.Types.ObjectId, ref: "vendors", default: null },
    vendorName: { type: String, trim: true, default: "" },
    purchaseDate: { type: Date, default: null },
    // Per unit / per meter. Optional for now.
    purchaseCost: { type: Number, default: null, min: 0 },

    // Warranty is given ONE of three ways: months (counted from purchaseDate),
    // an end date, or neither (unknown). Both at once is refused, so the
    // stored line never holds two answers that disagree.
    warrantyMonths: { type: Number, default: null, min: 0 },
    warrantyEndDate: { type: Date, default: null },

    condition: { type: String, enum: ITEM_CONDITION_ARRAY, default: ITEM_CONDITION.USED },

    // Does it work? Decides what posting makes of it — see OPENING_STOCK_STATE.
    workingState: { type: String, enum: OPENING_STOCK_STATE_ARRAY, default: OPENING_STOCK_STATE.WORKING },
    // What is wrong with it — required unless WORKING.
    faultNote: { type: String, trim: true, default: "" },

    // Set when the entry is posted.
    inventoryItemId: { type: Schema.Types.ObjectId, ref: "inventory_items", default: null },
  },
  { _id: true }
);

const openingStockEntrySchema = new Schema(
  {
    entryNumber: { type: String, trim: true, uppercase: true, required: true },
    // STORE (Opening Stock, OS-…) or ISSUED (Opening Issued Stock, OI-…) —
    // fixed at creation.
    kind: { type: String, enum: OPENING_STOCK_KIND_ARRAY, default: OPENING_STOCK_KIND.STORE },
    branchId: { type: Schema.Types.ObjectId, ref: "branches", required: true },

    /*
      ISSUED only — the one person every line of the entry is with, picked from
      the People Directory. A snapshot of their details as they were when the
      entry was saved; posting refreshes it from the directory once more.
    */
    issuedTo: {
      type: new Schema(
        {
          personId: { type: Schema.Types.ObjectId, ref: "directory_people", default: null },
          kind: { type: String, enum: ASSIGNEE_KIND_ARRAY, default: null },
          name: { type: String, trim: true, default: "" },
          employeeCode: { type: String, trim: true, default: "" },
          orderId: { type: String, trim: true, default: "" },
          username: { type: String, trim: true, default: "" },
          serviceType: { type: String, trim: true, default: "" },
          phone: { type: String, trim: true, default: "" },
          email: { type: String, trim: true, default: "" },
        },
        { _id: false }
      ),
      default: null,
    },
    // ISSUED only — since when the person has had these.
    issuedSince: { type: Date, default: null },
    // The day this stock is counted into the system — the received date its
    // items carry and the first date on their timelines.
    entryDate: { type: Date, required: true },
    remarks: { type: String, trim: true, default: "" },

    status: {
      type: String,
      enum: OPENING_STOCK_STATUS_ARRAY,
      default: OPENING_STOCK_STATUS.DRAFT,
    },
    lines: { type: [openingStockLineSchema], default: [] },

    postedAt: { type: Date, default: null },
    // Who posted it — the same snapshot as createdBy (see the plugin), kept
    // apart from updatedBy because posting is the one act that makes stock.
    postedBy: { type: actorSchema, default: null },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

openingStockEntrySchema.index({ entryNumber: 1 }, { unique: true });
openingStockEntrySchema.index({ branchId: 1, status: 1 });
openingStockEntrySchema.index({ kind: 1, createdAt: -1 });
openingStockEntrySchema.index({ createdAt: -1 });

// createdBy / updatedBy / deletedBy — see the plugin.
openingStockEntrySchema.plugin(actorStampPlugin);

const StockOpeningStockModel = mongoose.model(
  "opening_stock_entries",
  openingStockEntrySchema,
  "opening_stock_entries"
);

export default StockOpeningStockModel;
