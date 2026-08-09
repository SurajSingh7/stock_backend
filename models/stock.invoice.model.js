import mongoose from "mongoose";
import { INVOICE_STATUS, INVOICE_STATUS_ARRAY } from "../constants/stock.enums.js";

const { Schema } = mongoose;

const extraChargeSchema = new Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    note: { type: String, trim: true, default: "" },
  },
  { timestamps: false }
);

const ratingSchema = new Schema(
  {
    rating: { type: Number, min: 0, max: 5, default: null },
    notes: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

// One line = one PO line item (product) this invoice is receiving against.
// `quotationItemId` is the stable correlation key the PO copied from the
// quotation — used to sum received quantity per product across invoices.
const invoiceLineSchema = new Schema(
  {
    quotationItemId: { type: Schema.Types.ObjectId, default: null },
    categoryId: { type: Schema.Types.ObjectId, ref: "categories", default: null },
    categoryName: { type: String, trim: true, default: "" },
    productDefinitionId: {
      type: Schema.Types.ObjectId,
      ref: "product_definitions",
      default: null,
    },
    productName: { type: String, trim: true, default: "" },

    // Snapshotted from the PO line at invoice-create time — never re-read
    // from the PO later, same immutable-snapshot convention as everywhere else.
    unitPrice: { type: Number, default: 0 },

    receivedQuantity: { type: Number, required: true, min: 0 },

    // One entry per generated Serial/MAC row (individual-tracked products
    // only; empty for quantity-tracked products, which just set
    // receivedQuantity directly).
    rows: { type: [{ fieldValues: Schema.Types.Mixed }], default: [] },

    createdInventoryItemIds: { type: [Schema.Types.ObjectId], ref: "inventory_items", default: [] },

    rating: { type: ratingSchema, default: null },
  },
  { _id: true }
);

const invoiceSchema = new Schema(
  {
    trackingOrderId: { type: Schema.Types.ObjectId, ref: "tracking_orders", required: true },
    poId: { type: Schema.Types.ObjectId, ref: "purchase_orders", default: null },

    vendorId: { type: Schema.Types.ObjectId, ref: "vendors", default: null },
    vendorName: { type: String, trim: true, default: "" },

    invoiceNumber: { type: String, trim: true, required: true },
    invoiceDate: { type: Date, required: true },
    invoiceFile: { type: String, trim: true, default: "" }, // relative public path

    warehouseId: { type: Schema.Types.ObjectId, ref: "warehouses", default: null },

    // String snapshot (no real user-linking system on the frontend yet) —
    // same convention as createdByName/reviewedByName elsewhere.
    receivedByName: { type: String, trim: true, default: "" },

    extraCharges: { type: [extraChargeSchema], default: [] },
    lines: { type: [invoiceLineSchema], default: [] },

    // Server-computed: sum(receivedQuantity*unitPrice) + sum(extraCharges.amount)
    amount: { type: Number, default: 0 },

    status: {
      type: String,
      enum: INVOICE_STATUS_ARRAY,
      default: INVOICE_STATUS.PENDING,
    },
    rejectedReason: { type: String, trim: true, default: "" },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "users", default: null },
    reviewedByName: { type: String, trim: true, default: "" },
    reviewedAt: { type: Date, default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: "users", default: null },
    createdByName: { type: String, trim: true, default: "" },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

invoiceSchema.index({ trackingOrderId: 1, status: 1 });
invoiceSchema.index({ poId: 1 });
invoiceSchema.index({ vendorId: 1 });
invoiceSchema.index({ status: 1, isActive: 1 });

const StockInvoiceModel = mongoose.model("invoices", invoiceSchema, "invoices");

export default StockInvoiceModel;
