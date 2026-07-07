import mongoose from "mongoose";

const { Schema } = mongoose;

/*
  vendors — Section 8.4 of INVENTORY_SYSTEM_SPEC.md

  NOTE: This is intentionally richer than the original flat spec draft
  (name/contact/GST/address) because the actual UI requirement expanded to:
  GST verification block, multi-contact, structured address, assigned
  products (by leaf category), and multi bank-account. All additive —
  nothing in Section 8.4's original flat fields was removed, they've just
  been reorganized into nested sub-documents where the UI needed structure.

  refs below match the EXACT first argument passed to mongoose.model(...)
  in the referenced model files (prefix-free convention):
    stock.category.model.js           → mongoose.model("categories", ...)
    stock.product.definition.model.js → mongoose.model("product_definitions", ...)
*/

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
    // auto-filled once GST verify succeeds (see Vendors frontend mockVerifyGST)
    legalName: { type: String, trim: true, default: "" },
    tradeName: { type: String, trim: true, default: "" },
    gstAddress: { type: String, trim: true, default: "" },
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
    area: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    pinCode: { type: String, required: true, trim: true },
    state: { type: stateSchema, default: () => ({}) },
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
    productIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "product_definitions", // ← was "StockProductDefinitionModel" / "stock_product_definitions"
      },
    ],
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

    // Optional, unique when present, IMMUTABLE after create — mirrors
    // fieldDefinition.code (Rule 10). Not required at create time in the UI,
    // so sparse unique index rather than a hard required+unique constraint.
    vendorCode: { type: String, trim: true, uppercase: true, default: null },

    vendorAlias: { type: String, trim: true, default: "" },

    gst: { type: gstSchema, default: () => ({}) },

    panNumber: { type: String, trim: true, uppercase: true, default: "" },

    // Frontend-only enum (PAYMENT_TERMS constant) — same "no DB validation
    // yet" posture as productDefinition.unit. Keep as plain String so new
    // terms can be added in the frontend constant without a migration.
    paymentTerms: { type: String, required: true, trim: true },

    // Doubles as blacklist/inactive reason once vendor is deactivated —
    // same field, no schema change needed (see spec doc note).
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
stockVendorSchema.index({ vendorCode: 1 }, { unique: true, sparse: true });
stockVendorSchema.index({ "gst.gstNumber": 1 }, { sparse: true });
stockVendorSchema.index({ isActive: 1 });

// 3rd arg pins the collection explicitly — no pluralization guessing.
// NOTE: "vendors" (correct spelling) — keep it consistent everywhere.
const StockVendorModel = mongoose.model(
  "vendors",
  stockVendorSchema,
  "vendors"
);

export default StockVendorModel;