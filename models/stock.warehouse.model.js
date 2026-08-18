import mongoose from "mongoose";
import { LOCATION_ROLE, LOCATION_ROLE_ARRAY } from "../constants/stock.enums.js";

const { Schema } = mongoose;

const warehouseSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    address: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, default: "" },

    city: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    // Descriptive role in the network (CENTRAL/REGIONAL/NORMAL) — used for
    // reporting/filtering only, never restricts transfer eligibility.
    locationRole: {
      type: String,
      enum: LOCATION_ROLE_ARRAY,
      default: LOCATION_ROLE.NORMAL,
    },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

warehouseSchema.index({ code: 1 }, { unique: true });
warehouseSchema.index({ isActive: 1 });
warehouseSchema.index({ name: 1 });
warehouseSchema.index({ locationRole: 1 });

const StockWarehouseModel = mongoose.model("warehouses", warehouseSchema, "warehouses");

export default StockWarehouseModel;
