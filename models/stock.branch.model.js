import mongoose from "mongoose";
import { BRANCH_ROLE, BRANCH_ROLE_ARRAY } from "../constants/stock.enums.js";
import { actorStampPlugin } from "./plugins/actor.stamp.plugin.js";

const { Schema } = mongoose;

const branchSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    address: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, default: "" },

    city: { type: String, trim: true, default: "" },
    // State is picked from the shared Indian-state list on the client, which is
    // also the only place that knows the GST state code — so both halves are
    // stored together (flat, the same shape purchase/tracking orders use for
    // their buyer entity) rather than re-deriving the code here.
    state: { type: String, trim: true, default: "" },
    stateCode: { type: String, trim: true, default: "" },
    // Descriptive role in the network (CENTRAL/REGIONAL/NORMAL) — used for
    // reporting/filtering only, never restricts transfer eligibility.
    branchRole: {
      type: String,
      enum: BRANCH_ROLE_ARRAY,
      default: BRANCH_ROLE.NORMAL,
    },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

branchSchema.index({ code: 1 }, { unique: true });
branchSchema.index({ isActive: 1 });
branchSchema.index({ name: 1 });
branchSchema.index({ branchRole: 1 });

// who created / last touched this — see the plugin for why it is a hook
branchSchema.plugin(actorStampPlugin);

const StockBranchModel = mongoose.model("branches", branchSchema, "branches");

export default StockBranchModel;
