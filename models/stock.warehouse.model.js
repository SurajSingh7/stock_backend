import mongoose from "mongoose";

const { Schema } = mongoose;

const warehouseSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    address: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, default: "" },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

warehouseSchema.index({ code: 1 }, { unique: true });
warehouseSchema.index({ isActive: 1 });
warehouseSchema.index({ name: 1 });

const StockWarehouseModel = mongoose.model("warehouses", warehouseSchema, "warehouses");

export default StockWarehouseModel;
