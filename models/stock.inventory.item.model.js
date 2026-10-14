import mongoose from "mongoose";
import { ITEM_STATUS_ARRAY, ITEM_APPROVAL_STATUS_ARRAY, ITEM_APPROVAL_STATUS } from "../constants/stock.enums.js";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";

const stockInventoryItemSchema = new mongoose.Schema(
  {
    productDefinitionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "product_definitions", // ← was "stock_product_definitions"
      required: true,
    },
    // Optional — who the stock was received from (Section 8.4 / 9 of spec).
    // Add here now so the vendor delete-guard can be uncommented later.
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "vendors", // ← matches the vendor model's registered name
      default: null,
    },
    // Where this stock physically sits. Nullable for pre-branch-feature
    // records; the invoice-receiving flow always sets it going forward.
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "branches",
      default: null,
    },
    // Set only when this item was created by the invoice-receiving flow —
    // lets Product/Item Inventory trace an item back to the invoice/PO it
    // arrived on, and lets invoice edit/reject bulk-manage its items.
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "invoices",
      default: null,
    },
    // Partial-submit invoices: the entry (embedded in the invoice) this item
    // arrived on — entries are approved one at a time, so approval acts on it.
    invoiceEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    status: {
      type: String,
      enum: ITEM_STATUS_ARRAY,
      default: "AVAILABLE",
    },
    // Independent of `status` above. Defaults APPROVED so every existing/
    // direct-create caller (createInventoryItem/bulkCreateInventoryItems used
    // outside the invoice flow) behaves exactly as before; the invoice-
    // receiving flow is the only caller that explicitly passes PENDING, and
    // only APPROVED items count toward "available quantity".
    approvalStatus: {
      type: String,
      enum: ITEM_APPROVAL_STATUS_ARRAY,
      default: ITEM_APPROVAL_STATUS.APPROVED,
    },
    // True when this unit arrived free-of-cost on an invoice line (never
    // priced, never counted toward that line's ordered-quantity cap).
    isFoc: {
      type: Boolean,
      default: false,
    },
    fieldValues: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    quantity: {
      type: Number,
      default: null,
    },
    receivedAt: {
      type: Date,
      required: true,
    },
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
  },
  { timestamps: true }
);

stockInventoryItemSchema.index({ productDefinitionId: 1, isActive: 1 });
stockInventoryItemSchema.index({ vendorId: 1 });
stockInventoryItemSchema.index({ status: 1 });
stockInventoryItemSchema.index({ approvalStatus: 1 });
stockInventoryItemSchema.index({ branchId: 1 });
stockInventoryItemSchema.index({ invoiceId: 1 });
stockInventoryItemSchema.index({ invoiceEntryId: 1 }, { sparse: true });
stockInventoryItemSchema.index({ "fieldValues.imei": 1 }, { sparse: true });
stockInventoryItemSchema.index({ "fieldValues.serial_no": 1 }, { sparse: true });

// 3rd arg pins the collection explicitly — no pluralization guessing.
// who created / last touched this — see the plugin for why it is a hook
stockInventoryItemSchema.plugin(actorStampPlugin);

const StockInventoryItemModel = mongoose.model(
  "inventory_items",
  stockInventoryItemSchema,
  "inventory_items"
);

export default StockInventoryItemModel;