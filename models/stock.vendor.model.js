import mongoose from "mongoose";

const { Schema } = mongoose;
const stateSchema = new Schema(
  {
    key: { type: String, trim: true, default: null }, // e.g. "HR"
    name: { type: String, trim: true, default: null }, // e.g. "Haryana"
    code: { type: String, trim: true, default: null }, // e.g. "06"
  },
  { _id: false }
);

const gstSchema = new Schema(
  {
    isAvailable: { type: Boolean, default: true },
    gstNumber: { type: String, trim: true, uppercase: true, default: null },
    isVerified: { type: Boolean, default: false },
    verifiedAt: { type: Date, default: null },
    legalName: { type: String, trim: true, default: "" },
    tradeName: { type: String, trim: true, default: "" },
    gstAddress: { type: String, trim: true, default: "" },
    state: { type: stateSchema, default: () => ({}) },
  },
  { _id: false }
);

const contactSchema = new Schema(
  {
    label: { type: String, required: true, trim: true, uppercase: true }, // "PRIMARY", "TECHNICAL", ...
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, required: true, trim: true },
    designation: { type: String, trim: true, default: "" },
    department: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const addressSchema = new Schema(
  {
    fullAddress: { type: String, required: true, trim: true },
    area: { type: String, trim: true, default: "" },
    city: { type: String, required: true, trim: true },
    pinCode: { type: String, required: true, trim: true },
    state: { type: stateSchema, default: () => ({}) },
  },
  { _id: false }
);

const assignedProductOverrideSchema = new Schema(
  {
    warrantyYears: { type: Number, default: null, min: 1 },
  },
  { _id: false, strict: false }
);

const assignedProductEntrySchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: "product_definitions",
      required: true,
    },
    overrides: { type: assignedProductOverrideSchema, default: () => ({}) },
  },
  { _id: false }
);

const assignedProductSchema = new Schema(
  {
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: "categories", // ← was "StockCategoryModel" / "stock_categories"
      required: true,
    },
    products: { type: [assignedProductEntrySchema], default: [] },
  },
  { _id: false }
);

const bankAccountSchema = new Schema(
  {
    label: { type: String, required: true, trim: true, uppercase: true }, // "PRIMARY", "SECONDARY ACCOUNT", ...
    ifsc: { type: String, required: true, trim: true, uppercase: true },
    bankName: { type: String, trim: true, default: "" },
    branch: { type: String, trim: true, default: "" },
    branchAddress: { type: String, trim: true, default: "" },
    state: { type: stateSchema, default: () => ({}) },
    city: { type: String, trim: true, default: "" },
    accountNumber: { type: String, required: true, trim: true },
    rtgsCode: { type: String, trim: true, default: "" },
    neftCode: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const stockVendorSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },

    vendorCode: { type: String, trim: true, uppercase: true },

    vendorAlias: { type: String, trim: true, default: "" },

    gst: { type: gstSchema, default: () => ({}) },

    panNumber: { type: String, trim: true, uppercase: true, default: "" },

    paymentTerms: { type: String, required: true, trim: true },
    notes: { type: String, trim: true, default: "" },

    contacts: { type: [contactSchema], default: [] },

    address: { type: addressSchema, default: () => ({}) },

    assignedProducts: { type: [assignedProductSchema], default: [] },

    bankAccounts: { type: [bankAccountSchema], default: [] },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

stockVendorSchema.index({ name: 1 });

stockVendorSchema.index(
  { vendorCode: 1 },
  { unique: true, partialFilterExpression: { vendorCode: { $type: "string" } } }
);

stockVendorSchema.index({ "gst.gstNumber": 1 }, { sparse: true });
stockVendorSchema.index({ isActive: 1 });

stockVendorSchema.index({ "assignedProducts.categoryId": 1 });
stockVendorSchema.index({ "assignedProducts.products.productId": 1 });

const StockVendorModel = mongoose.model(
  "vendors",
  stockVendorSchema,
  "vendors"
);

export default StockVendorModel;