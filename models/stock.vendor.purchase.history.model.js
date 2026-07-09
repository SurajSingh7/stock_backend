import mongoose from "mongoose";

const { Schema } = mongoose;

/*
  vendor_product_purchase_history — FUTURE-WRITE, READ-NOW.

  This collection is written by the future "Inventory Receive" module, NOT by
  Quotation. Quotation only READS the latest record per (vendorId,
  productDefinitionId) to snapshot previousQuantity + previousPrice onto a new
  quotation line. Until Inventory Receive ships, this collection is empty and
  every quotation line shows "-" for previous values — which is correct, not a bug.

  Building the real schema now (instead of mocking) means the eventual write path
  just starts inserting; no Quotation code changes.

  refs use prefix-free registered names (RULE 27).
*/

const vendorProductPurchaseHistorySchema = new Schema(
  {
    vendorId: {
      type: Schema.Types.ObjectId,
      ref: "vendors",
      required: true,
    },
    productDefinitionId: {
      type: Schema.Types.ObjectId,
      ref: "product_definitions",
      required: true,
    },

    receivedQuantity: { type: Number, required: true, min: 0 },
    purchasePrice: { type: Number, required: true, min: 0 },
    purchaseDate: { type: Date, required: true },

    // trace back to what this purchase came from, once those modules exist
    sourceQuotationId: { type: Schema.Types.ObjectId, ref: "quotations", default: null },

    // audit
    createdBy: { type: Schema.Types.ObjectId, ref: "users", default: null },
    createdByName: { type: String, trim: true, default: "" },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

// The hot query is "latest record for this vendor+product" — this compound index
// with purchaseDate descending makes that a covered, single-direction lookup.
vendorProductPurchaseHistorySchema.index({
  vendorId: 1,
  productDefinitionId: 1,
  purchaseDate: -1,
});

const StockVendorPurchaseHistoryModel = mongoose.model(
  "vendor_product_purchase_history",
  vendorProductPurchaseHistorySchema,
  "vendor_product_purchase_history"
);

export default StockVendorPurchaseHistoryModel;