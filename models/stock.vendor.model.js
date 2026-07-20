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
    // Spec 8.4 lists gst.state as auto-filled on verify, but it was missing
    // from this schema — so Mongoose (strict mode) silently DROPPED it on
    // every save. That also broke the PO GST split, which reads
    // `vendor.gst.state.code || vendor.address.state.code` and always fell
    // through to the address. Restored here.
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
    // area is OPTIONAL in the form (VendorForm.jsx). Keeping required:true
    // here threw a ValidationError for any vendor saved without a locality.
    area: { type: String, trim: true, default: "" },
    city: { type: String, required: true, trim: true },
    pinCode: { type: String, required: true, trim: true },
    state: { type: stateSchema, default: () => ({}) },
  },
  { _id: false }
);

// Open-ended per-assignment overrides — vendor-specific values that supersede
// the product's own defaults (e.g. warrantyYears today, price/leadTime later)
// without requiring a schema migration each time a new override is added.
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

    /*
      vendorCode — optional, unique WHEN PRESENT, IMMUTABLE after create
      (mirrors fieldDefinition.code, Rule 10).

      E11000 BUG FIX (duplicate key: { vendorCode: null }):
      `default: null` + a `sparse` unique index do NOT work together. `sparse`
      only skips documents where the key is ABSENT — a stored `null` is a real
      value, so the second vendor saved without a code collided with the first.
      Fix = no default (field simply stays undefined/absent) + a PARTIAL index
      that only covers string values (see below). The service should also
      `delete payload.vendorCode` / unset it when it comes in empty, so an
      empty string never gets stored either.
    */
    vendorCode: { type: String, trim: true, uppercase: true },

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

/*
  PARTIAL unique index — only indexes documents where vendorCode is an actual
  string. Vendors saved without a code are not in the index at all, so any
  number of them can coexist. This REPLACES the old
  `{ unique: true, sparse: true }` index, which broke on stored nulls.

  MIGRATION (run once, backend stopped — same posture as RULE 28):
    db.vendors.dropIndex("vendorCode_1")
    db.vendors.updateMany({ vendorCode: null }, { $unset: { vendorCode: "" } })
    db.vendors.updateMany({ vendorCode: "" },   { $unset: { vendorCode: "" } })
  Then restart — Mongoose recreates the index in its new partial form.
  (Changing the index definition in code does NOT alter an existing index.)
*/
stockVendorSchema.index(
  { vendorCode: 1 },
  { unique: true, partialFilterExpression: { vendorCode: { $type: "string" } } }
);

stockVendorSchema.index({ "gst.gstNumber": 1 }, { sparse: true });
stockVendorSchema.index({ isActive: 1 });

// Hot paths for the Vendors list filters (Rule 23 — the category/product
// pickers in Vendors.jsx send ?categoryId= / ?productId= and the filter is
// applied in StockVendorService.getAllVendors). Without these, every filtered
// list request is a full collection scan on the vendors master.
stockVendorSchema.index({ "assignedProducts.categoryId": 1 });
stockVendorSchema.index({ "assignedProducts.products.productId": 1 });

// 3rd arg pins the collection explicitly — no pluralization guessing.
// NOTE: "vendors" (correct spelling) — keep it consistent everywhere.
const StockVendorModel = mongoose.model(
  "vendors",
  stockVendorSchema,
  "vendors"
);

export default StockVendorModel;