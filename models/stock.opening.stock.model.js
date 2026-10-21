import mongoose from "mongoose";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";
import {
  TRACKING_METHODS_ARRAY,
  UNIT_TYPES_ARRAY,
  ITEM_CONDITION_ARRAY,
  ITEM_CONDITION,
  OPENING_STOCK_STATUS,
  OPENING_STOCK_STATUS_ARRAY,
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

    // "Abhi kiske paas hai" — set when the unit is with an employee right now.
    // Such a unit is posted RESERVED, not AVAILABLE.
    heldBy: { type: String, trim: true, default: "" },
    // Pre-system history: free text, since past users may no longer be in HRMS.
    lastUsedBy: { type: String, trim: true, default: "" },
    historyRemarks: { type: String, trim: true, default: "" },

    // Set when the entry is posted.
    inventoryItemId: { type: Schema.Types.ObjectId, ref: "inventory_items", default: null },
  },
  { _id: true }
);

const openingStockEntrySchema = new Schema(
  {
    entryNumber: { type: String, trim: true, uppercase: true, required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "branches", required: true },
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
    // Who posted it — same snapshot shape as createdBy (see the plugin), kept
    // apart from updatedBy because posting is the one act that makes stock.
    postedBy: {
      type: new Schema(
        {
          userId: { type: Schema.Types.ObjectId, default: null },
          employeeCode: { type: String, trim: true, default: "" },
          name: { type: String, trim: true, default: "" },
        },
        { _id: false }
      ),
      default: null,
    },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

openingStockEntrySchema.index({ entryNumber: 1 }, { unique: true });
openingStockEntrySchema.index({ branchId: 1, status: 1 });
openingStockEntrySchema.index({ createdAt: -1 });

// createdBy / updatedBy / deletedBy — see the plugin.
openingStockEntrySchema.plugin(actorStampPlugin);

const StockOpeningStockModel = mongoose.model(
  "opening_stock_entries",
  openingStockEntrySchema,
  "opening_stock_entries"
);

export default StockOpeningStockModel;
