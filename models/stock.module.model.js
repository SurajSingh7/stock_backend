import mongoose from "mongoose";
import { STANDARD_ACTIONS } from "../constants/stock.enums.js";

const { Schema } = mongoose;

// One doc per resource area (warehouses, purchase-orders, ...). `actions` is
// that module's full action vocabulary — not fixed to CRUD, a module can
// define its own (APPROVE, REJECT, SEND_MAIL, PROCESS, ...). This is the
// vocabulary requirePermission() checks role/override grants against.
const moduleSchema = new Schema(
  {
    key: { type: String, required: true, trim: true, lowercase: true }, // matches the route prefix, e.g. "warehouses"
    name: { type: String, required: true, trim: true },
    actions: { type: [String], required: true, default: STANDARD_ACTIONS },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

moduleSchema.index({ key: 1 }, { unique: true });

const StockModuleModel = mongoose.model("modules", moduleSchema, "modules");

export default StockModuleModel;
