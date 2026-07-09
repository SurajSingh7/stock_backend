import mongoose from "mongoose";

const { Schema } = mongoose;

/*
  vendor_reviews — FUTURE-WRITE, READ-NOW.

  Written by the future "Vendor Review" step (after delivery completes), NOT by
  Quotation. Quotation only READS these to compute an average rating per
  (vendorId, productDefinitionId) and snapshots that number onto the quotation
  line. Empty today => averageRating snapshot is null => UI shows "-".

  refs use prefix-free registered names (RULE 27).
*/

const vendorReviewSchema = new Schema(
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

    rating: { type: Number, required: true, min: 0, max: 5 },
    comment: { type: String, trim: true, default: "" },

    // audit
    createdBy: { type: Schema.Types.ObjectId, ref: "users", default: null },
    createdByName: { type: String, trim: true, default: "" },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

// Average-rating aggregation groups by vendor+product over active reviews.
vendorReviewSchema.index({ vendorId: 1, productDefinitionId: 1, isActive: 1 });

const StockVendorReviewModel = mongoose.model(
  "vendor_reviews",
  vendorReviewSchema,
  "vendor_reviews"
);

export default StockVendorReviewModel;