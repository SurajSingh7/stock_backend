import mongoose from "mongoose";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";
import {
  ITEM_MOVEMENT_TYPE_ARRAY,
  ITEM_MOVEMENT_REF_ARRAY,
  ITEM_STATUS_ARRAY,
} from "../constants/stock.enums.js";

const { Schema } = mongoose;

/*
  inventory_item_movements — one unit's timeline, one row per event.

  Append-only: a row is never edited or deleted, because it is a statement of
  what happened. Correcting a mistake is a new row.

  Why a collection of its own and not an array on the item: a laptop that goes
  through ten people over five years would carry its whole history on every
  stock list read, and "everything that moved out of Delhi last month" would
  mean scanning every item. Here it is an indexed query.

  The audit log already records raw before/after documents; this is the
  business view of the same unit — received, transferred, and, in later
  phases, assigned, returned, repaired, replaced.
*/
const refSchema = new Schema(
  {
    type: { type: String, enum: ITEM_MOVEMENT_REF_ARRAY, default: null },
    refId: { type: Schema.Types.ObjectId, default: null },
    refNumber: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const itemMovementSchema = new Schema(
  {
    inventoryItemId: { type: Schema.Types.ObjectId, ref: "inventory_items", required: true },
    productDefinitionId: { type: Schema.Types.ObjectId, ref: "product_definitions", required: true },
    type: { type: String, enum: ITEM_MOVEMENT_TYPE_ARRAY, required: true },
    at: { type: Date, default: Date.now },

    // Quantity-tracked batches only — how much this event moved.
    quantity: { type: Number, default: null, min: 0 },
    fromBranchId: { type: Schema.Types.ObjectId, ref: "branches", default: null },
    toBranchId: { type: Schema.Types.ObjectId, ref: "branches", default: null },
    // The unit's status straight after this event.
    status: { type: String, enum: ITEM_STATUS_ARRAY, default: null },

    ref: { type: refSchema, default: () => ({}) },
    // A batch transfer splits stock: the source batch and the new one at the
    // destination each point at the other.
    relatedItemId: { type: Schema.Types.ObjectId, ref: "inventory_items", default: null },
    note: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

itemMovementSchema.index({ inventoryItemId: 1, at: 1 });
itemMovementSchema.index({ "ref.refId": 1 });
itemMovementSchema.index({ type: 1, at: -1 });

// createdBy is the person who did it — see the plugin.
itemMovementSchema.plugin(actorStampPlugin);

const StockInventoryItemMovementModel = mongoose.model(
  "inventory_item_movements",
  itemMovementSchema,
  "inventory_item_movements"
);

export default StockInventoryItemMovementModel;
