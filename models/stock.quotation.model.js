import mongoose from "mongoose";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";
import {
  QUOTATION_STATUS,
  QUOTATION_STATUS_ARRAY,
  CATEGORY_APPROVAL_STATUS_ARRAY,
} from "../constants/stock.enums.js";

const { Schema } = mongoose;

const quotationLineItemSchema = new Schema(
  {
    productDefinitionId: {
      type: Schema.Types.ObjectId,
      ref: "product_definitions",
      required: true,
    },
    vendorId: { type: Schema.Types.ObjectId, ref: "vendors", required: true },
    categoryId: { type: Schema.Types.ObjectId, ref: "categories", required: true },

    // display snapshots (list/detail never needs a populate)
    productName: { type: String, trim: true, default: "" },
    vendorName: { type: String, trim: true, default: "" },
    categoryName: { type: String, trim: true, default: "" },

    // priced quantities
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    // Warranty in whole MONTHS (see helpers/stock.warranty.helper.js), both
    // snapshotted at save and never re-read live — a later vendor edit can't
    // retroactively change a priced line.
    //   defaultWarrantyMonths — what the vendor offers by default (assignment
    //     override, else the product default).
    //   warrantyMonths — what was quoted. Equal to the default unless the
    //     creator overrode it for THIS quotation only; the vendor's own
    //     assignment is never touched. Both are kept so the approver can see
    //     an override, since L1 ranking puts warranty before price.
    warrantyMonths: { type: Number, default: null, min: 1 },
    defaultWarrantyMonths: { type: Number, default: null },
    gstRate: { type: Number, default: 0, min: 0 },
    baseAmount: { type: Number, default: 0, min: 0 },
    gstAmount: { type: Number, default: 0, min: 0 },
    lineTotal: { type: Number, default: 0, min: 0 },

    // read-only snapshots from other collections (null => UI shows "-")
    previousQuantity: { type: Number, default: null },
    previousPrice: { type: Number, default: null },
    averageRating: { type: Number, default: null },

    // L-rank of this offer inside its leaf category (1 = L-1), frozen at
    // create by assignCategoryRanks — see the service for the ordering rule.
    // Snapshotted for the same reason price and warranty are: the ranking is
    // what the approver actually saw, and a later change to the ranking policy
    // must not silently re-rank a quotation that has already been decided.
    // Null on quotations created before ranking moved server-side.
    rank: { type: Number, default: null },

    // convenience flag set true when this exact offer is the winning selection
    // of an approved category (mirrors categoryApprovals[].selections[].itemId).
    isApproved: { type: Boolean, default: false },

    // PO Management board state — which PO this line landed on, and when.
    // Whether a line is ordered AT ALL is deliberately not here: that decision
    // is taken after approval and belongs to the tracking order
    // (excludedItems), so this document stays a record of what was approved
    // and nothing else. poSkipped/poSkipReason/poSkippedBy/poSkippedAt used to
    // live here and wrote back onto an approved quotation; they were replaced
    // by that, which is reversible until a PO exists.
    poId: { type: Schema.Types.ObjectId, ref: "purchase_orders", default: null },
    poAddedAt: { type: Date, default: null },
  },
  { _id: true } 
);

const categorySelectionSchema = new Schema(
  {
    itemId: { type: Schema.Types.ObjectId, default: null }, // -> items[]._id
    productDefinitionId: {
      type: Schema.Types.ObjectId,
      ref: "product_definitions",
      required: true,
    },
    productName: { type: String, trim: true, default: "" },
    vendorId: { type: Schema.Types.ObjectId, ref: "vendors", required: true },
    vendorName: { type: String, trim: true, default: "" },

    quantity: { type: Number, default: 0 },
    unitPrice: { type: Number, default: 0 },
    warrantyMonths: { type: Number, default: null },
    // The winning offer's L-rank, copied from items[].rank. Kept so "how often
    // is a non-L-1 approved" is a query, not a recomputation.
    rank: { type: Number, default: null },
    gstRate: { type: Number, default: 0 },
    baseAmount: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
    lineTotal: { type: Number, default: 0 },
  },
  { _id: false }
);


const categoryApprovalSchema = new Schema(
  {
    categoryId: { type: Schema.Types.ObjectId, ref: "categories", required: true },
    categoryName: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: CATEGORY_APPROVAL_STATUS_ARRAY,
      required: true,
    },
    remarks: { type: String, trim: true, default: "" },
    // length 1 today (one product + one vendor); array keeps future multi free.
    selections: { type: [categorySelectionSchema], default: [] },

    decidedBy: { type: Schema.Types.ObjectId, ref: "users", default: null },
    decidedByName: { type: String, trim: true, default: "" },
    decidedAt: { type: Date, default: null },
  },
  { _id: true }
);

/*
  disabledVendorSchema used to sit here — vendors an admin had excluded from
  the PO flow for this quotation. It was removed because it wrote to a document
  that is meant to be frozen at approval, nothing enforced it (PO creation
  never read it), and no screen could set it. Excluding a vendor or a line is
  now one mechanism on the tracking order: trackingOrder.excludedItems, set by
  "Not Required" and "Revise Order" and enforced in createPurchaseOrder.
*/

const quotationSchema = new Schema(
  {
    quotationNumber: { type: String, trim: true, uppercase: true, default: null },

    status: {
      type: String,
      enum: QUOTATION_STATUS_ARRAY,
      default: QUOTATION_STATUS.PENDING,
    },

    categoryIds: [{ type: Schema.Types.ObjectId, ref: "categories" }],

    items: {
      type: [quotationLineItemSchema],
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length > 0,
        message: "A quotation must have at least one item",
      },
    },

    // Empty until the approver submits; then one entry per category.
    categoryApprovals: { type: [categoryApprovalSchema], default: [] },

    notes: { type: String, trim: true, default: "" },
    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },  },
  { timestamps: true }
);

quotationSchema.index({ status: 1, isActive: 1 });
quotationSchema.index({ quotationNumber: 1 }, { unique: true, sparse: true });
quotationSchema.index({ categoryIds: 1 });
quotationSchema.index({ "items.vendorId": 1 });
quotationSchema.index({ "items.productDefinitionId": 1 });
quotationSchema.index({ "categoryApprovals.selections.vendorId": 1 });


// who created / last touched this — see the plugin for why it is a hook
quotationSchema.plugin(actorStampPlugin);

const StockQuotationModel = mongoose.model("quotations", quotationSchema, "quotations");

export default StockQuotationModel;