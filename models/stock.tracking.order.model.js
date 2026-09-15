import mongoose from "mongoose";
import { TRACKING_STATUS, TRACKING_STATUS_ARRAY, MAIL_MODE_ARRAY } from "../constants/stock.enums.js";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";

const { Schema } = mongoose;

// Same shape as StockPurchaseOrderModel.buyerEntity — snapshotted from the
// internal-companies source at "+ Add Entity" time on the Tracking Orders page.
const buyerEntitySchema = new Schema(
  {
    entityId: { type: Schema.Types.ObjectId, default: null },
    name: { type: String, trim: true, default: "" },
    alias: { type: String, trim: true, default: "" },
    gstNumber: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    stateCode: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const mailResultSchema = new Schema(
  {
    mode: { type: String, enum: MAIL_MODE_ARRAY, default: null },
    channel: { type: String, trim: true, default: "" },
    sentAt: { type: Date, default: null },
    notificationId: { type: Schema.Types.ObjectId, ref: "notifications", default: null },
    // Array like cc: a PO can address several of the vendor's contacts.
    // Mongoose casts an older single-string value into a one-element array on
    // read, so existing rows keep working.
    to: { type: [String], default: [] },
    cc: { type: [String], default: [] },
    from: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

/*
  One approved quotation line this vendor will NOT be ordered.

  The quotation records what was APPROVED and never changes after review. This
  records what we actually decided to buy, which is a later and separate fact —
  so it lives here, on the vendor's order, not back on the quotation.

  Set in one place only: "Not Required" on the Tracking Orders page, while the
  order is still ENTITY_PENDING. The accounts team cannot edit these — if they
  need a change they reset the order, which sends it back to that screen.

  The product/quantity/amount are snapshotted so the Not Required register can
  list a line without joining back to the quotation.
*/
const excludedItemSchema = new Schema(
  {
    quotationItemId: { type: Schema.Types.ObjectId, required: true }, // -> quotation.items[]._id
    productDefinitionId: { type: Schema.Types.ObjectId, ref: "product_definitions", default: null },
    productName: { type: String, trim: true, default: "" },
    categoryId: { type: Schema.Types.ObjectId, ref: "categories", default: null },
    categoryName: { type: String, trim: true, default: "" },
    quantity: { type: Number, default: 0 },
    lineTotal: { type: Number, default: 0 },

    reason: { type: String, trim: true, default: "" },
    excludedBy: { type: Schema.Types.ObjectId, default: null },
    excludedByName: { type: String, trim: true, default: "" },
    excludedAt: { type: Date, default: null },
  },
  { _id: false }
);

const trackingOrderSchema = new Schema(
  {
    sourceQuotationId: { type: Schema.Types.ObjectId, ref: "quotations", required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "vendors", required: true },

    buyerEntity: { type: buyerEntitySchema, default: () => ({}) },

    status: {
      type: String,
      enum: TRACKING_STATUS_ARRAY,
      default: TRACKING_STATUS.ENTITY_PENDING,
    },

    poId: { type: Schema.Types.ObjectId, ref: "purchase_orders", default: null },

    // Lines this vendor will not be ordered. When every approved line ends up
    // here the row becomes NOT_REQUIRED — "drop the whole vendor" and "uncheck
    // every line" are deliberately the same state, not two look-alike ones.
    excludedItems: { type: [excludedItemSchema], default: [] },

    // Why the WHOLE vendor was dropped, and by whom. Kept separate from the
    // per-line reasons above because the Not Required register lists a dropped
    // vendor as ONE row, not one row per line, and that row needs its own
    // reason and author.
    notRequiredReason: { type: String, trim: true, default: "" },
    disabledBy: { type: Schema.Types.ObjectId, default: null },
    disabledByName: { type: String, trim: true, default: "" },
    disabledAt: { type: Date, default: null },

    /*
      What was decided about this vendor's products, as a timeline.

      excludedItems above is the CURRENT state — it is wiped when a vendor is
      marked Required again, and that is correct: it exists to stop a PO, not
      to remember. This is the part that must survive, so someone can still see
      who took which decision months later.

      Kept thin, but NOT nameless: "1 product removed" does not answer the only
      question anyone opens this to ask — which one. Names are stored and
      nothing else; quantity, price and category all still live on the
      quotation, and the audit log keeps the full before/after.

      productCount stays alongside for entries written before names were kept.
    */
    activity: {
      type: [
        new Schema(
          {
            type: { type: String, enum: ["NOT_REQUIRED", "REQUIRED"], required: true },
            scope: { type: String, enum: ["WHOLE_VENDOR", "SOME_PRODUCTS"], required: true },
            products: { type: [String], default: [] },
            productCount: { type: Number, default: 0 },
            reason: { type: String, trim: true, default: "" },
            byName: { type: String, trim: true, default: "" },
            at: { type: Date, default: null },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    // Every time the accounts team sent this order back to the start.
    // An array, not a flag: the whole point is that someone can look later and
    // see how often an order was restarted and why. What it destroyed — the PO
    // number and the entity — is recorded here because those are exactly the
    // things the reset throws away.
    resets: {
      type: [
        new Schema(
          {
            reason: { type: String, trim: true, default: "" },
            voidedPoNumber: { type: String, trim: true, default: "" },
            clearedEntityAlias: { type: String, trim: true, default: "" },
            resetBy: { type: Schema.Types.ObjectId, default: null },
            resetByName: { type: String, trim: true, default: "" },
            resetAt: { type: Date, default: null },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    mailResult: { type: mailResultSchema, default: null },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

trackingOrderSchema.index({ sourceQuotationId: 1, vendorId: 1 }, { unique: true });
trackingOrderSchema.index({ status: 1, isActive: 1 });
trackingOrderSchema.index({ poId: 1 });


// who created / last touched this — see the plugin for why it is a hook
trackingOrderSchema.plugin(actorStampPlugin);

const StockTrackingOrderModel = mongoose.model(
  "tracking_orders",
  trackingOrderSchema,
  "tracking_orders"
);

export default StockTrackingOrderModel;
