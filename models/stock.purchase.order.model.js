import mongoose from "mongoose";
import { PO_STATUS, PO_STATUS_ARRAY, PO_TAX_TYPE, TERMS_SOURCE_ARRAY, TERMS_SOURCE } from "../constants/stock.enums.js";

const { Schema } = mongoose;

// Buyer = one of our internal companies (from the internal-companies API).
// Snapshotted so the PO/PDF never depends on that external source later.
const buyerEntitySchema = new Schema(
  {
    entityId: { type: Schema.Types.ObjectId, default: null }, // internal-companies _id
    name: { type: String, trim: true, default: "" },
    alias: { type: String, trim: true, default: "" },
    gstNumber: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    stateCode: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

// One PO line = one approved selection copied from the quotation snapshot.
const poItemSchema = new Schema(
  {
    quotationItemId: { type: Schema.Types.ObjectId, default: null }, // -> quotation items[]._id
    categoryId: { type: Schema.Types.ObjectId, ref: "categories", default: null },
    categoryName: { type: String, trim: true, default: "" },
    productDefinitionId: {
      type: Schema.Types.ObjectId,
      ref: "product_definitions",
      default: null,
    },
    productName: { type: String, trim: true, default: "" },

    quantity: { type: Number, default: 0 },
    unitPrice: { type: Number, default: 0 },
    gstRate: { type: Number, default: 0 },

    taxable: { type: Number, default: 0 },  // quantity * unitPrice
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 }, // cgst + sgst OR igst
    lineTotal: { type: Number, default: 0 }, // taxable + gstAmount
  },
  { _id: false }
);

const purchaseOrderSchema = new Schema(
  {
    poNumber: { type: String, trim: true, uppercase: true, default: null },

    sourceQuotationId: { type: Schema.Types.ObjectId, ref: "quotations", default: null },

    // Supplier = vendor (snapshot from the vendor master at PO create time)
    vendorId: { type: Schema.Types.ObjectId, ref: "vendors", required: true },
    vendorName: { type: String, trim: true, default: "" },
    vendorGstin: { type: String, trim: true, default: "" },
    vendorAddress: { type: String, trim: true, default: "" },
    vendorState: { type: String, trim: true, default: "" },
    vendorStateCode: { type: String, trim: true, default: "" },
    vendorPhone: { type: String, trim: true, default: "" },
    vendorEmail: { type: String, trim: true, default: "" },

    // Buyer = internal entity (snapshot)
    buyerEntity: { type: buyerEntitySchema, default: () => ({}) },

    requester: { type: String, trim: true, default: "" },
    poDate: { type: Date, default: Date.now },
    shipmentPreference: { type: String, trim: true, default: "" },
    paymentTerms: { type: String, trim: true, default: "" }, // snapshot from vendor

    // Terms snapshot — auto-resolved server-side at create time from the
    // Terms & Conditions master (vendor-specific match, else the Default
    // term). NOT settable by the client and immutable after create — see
    // StockPurchaseOrderService.createPurchaseOrder / updatePurchaseOrder.
    terms: { type: String, default: "" }, // rich text (HTML) snapshot
    termsConditionId: { type: mongoose.Schema.Types.ObjectId, ref: "terms_conditions", default: null },
    termsSource: { type: String, enum: TERMS_SOURCE_ARRAY, default: TERMS_SOURCE.NONE },

    notes: { type: String, trim: true, default: "" },

    // GST split — derived from buyer vs vendor state code
    taxType: {
      type: String,
      enum: Object.values(PO_TAX_TYPE),
      default: PO_TAX_TYPE.IGST,
    },

    items: { type: [poItemSchema], default: [] },

    // server-computed totals (client math ignored)
    subTotal: { type: Number, default: 0 },   // sum taxable
    cgstTotal: { type: Number, default: 0 },
    sgstTotal: { type: Number, default: 0 },
    igstTotal: { type: Number, default: 0 },
    gstTotal: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },

    status: {
      type: String,
      enum: PO_STATUS_ARRAY,
      default: PO_STATUS.GENERATED,
    },
    rejectedReason: { type: String, trim: true, default: "" },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "users", default: null },
    reviewedByName: { type: String, trim: true, default: "" },
    reviewedAt: { type: Date, default: null },

    pdfPath: { type: String, trim: true, default: "" },     // relative public path
    emailedTo: { type: String, trim: true, default: "" },   // future
    emailedAt: { type: Date, default: null },               // future

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

purchaseOrderSchema.index({ poNumber: 1 }, { unique: true, sparse: true });
purchaseOrderSchema.index({ sourceQuotationId: 1 });
purchaseOrderSchema.index({ vendorId: 1 });
purchaseOrderSchema.index({ status: 1, isActive: 1 });

const StockPurchaseOrderModel = mongoose.model(
  "purchase_orders",
  purchaseOrderSchema,
  "purchase_orders"
);

export default StockPurchaseOrderModel;