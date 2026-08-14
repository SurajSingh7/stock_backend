import mongoose from "mongoose";
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
    // Snapshotted at creation from the vendor's assignment override (falling
    // back to the product's default) — never re-read live, same posture as
    // unitPrice/gstRate, so a later vendor edit can't retroactively change it.
    warrantyYears: { type: Number, default: null, min: 1 },
    gstRate: { type: Number, default: 0, min: 0 },
    baseAmount: { type: Number, default: 0, min: 0 },
    gstAmount: { type: Number, default: 0, min: 0 },
    lineTotal: { type: Number, default: 0, min: 0 },

    // read-only snapshots from other collections (null => UI shows "-")
    previousQuantity: { type: Number, default: null },
    previousPrice: { type: Number, default: null },
    averageRating: { type: Number, default: null },

    // convenience flag set true when this exact offer is the winning selection
    // of an approved category (mirrors categoryApprovals[].selections[].itemId).
    isApproved: { type: Boolean, default: false },

    // PO Management board state
    poId: { type: Schema.Types.ObjectId, ref: "purchase_orders", default: null },
    poAddedAt: { type: Date, default: null },
    poSkipped: { type: Boolean, default: false }, // unchecked at Create PO → permanent skip
    poSkipReason: { type: String, trim: true, default: "" },
    poSkippedBy: { type: Schema.Types.ObjectId, ref: "users", default: null },
    poSkippedAt: { type: Date, default: null },
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
    warrantyYears: { type: Number, default: null },
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

/* Vendors an admin has excluded from the PO flow for this quotation (with a reason). */
const disabledVendorSchema = new Schema(
  {
    vendorId: { type: Schema.Types.ObjectId, ref: "vendors" },
    vendorName: { type: String, trim: true, default: "" },
    reason: { type: String, trim: true, default: "" },
    disabledBy: { type: Schema.Types.ObjectId, ref: "users", default: null },
    disabledByName: { type: String, trim: true, default: "" },
    disabledAt: { type: Date, default: null },
  },
  { _id: false }
);

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

    // Vendors excluded from the PO Management board for this quotation.
    disabledVendors: { type: [disabledVendorSchema], default: [] },

    notes: { type: String, trim: true, default: "" },

    createdBy: { type: Schema.Types.ObjectId, ref: "users", default: null },
    createdByName: { type: String, trim: true, default: "" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "users", default: null },
    updatedByName: { type: String, trim: true, default: "" },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

quotationSchema.index({ status: 1, isActive: 1 });
quotationSchema.index({ quotationNumber: 1 }, { unique: true, sparse: true });
quotationSchema.index({ categoryIds: 1 });
quotationSchema.index({ "items.vendorId": 1 });
quotationSchema.index({ "items.productDefinitionId": 1 });
quotationSchema.index({ "categoryApprovals.selections.vendorId": 1 });
quotationSchema.index({ createdBy: 1 });

const StockQuotationModel = mongoose.model("quotations", quotationSchema, "quotations");

export default StockQuotationModel;