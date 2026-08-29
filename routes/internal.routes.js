import express from "express";
import { verifyInternalServiceKey } from "../middlewares/stock.internal.auth.middleware.js";
import StockBranchModel from "../models/stock.branch.model.js";

const router = express.Router();

// Consumed by HRMS's admin UI to populate the branch-assignment dropdown
// when an admin assigns a branch to a Login — see the "Branch
// prerequisite" phase of the access-control plan. Branch data stays
// owned here; HRMS only ever stores the id it gets back from this list.
router.get("/branches", verifyInternalServiceKey, async (req, res) => {
  try {
    const branches = await StockBranchModel.find({ isActive: true })
      .select("_id name code city state")
      .sort({ name: 1 })
      .lean();
    return res.json({ success: true, data: branches });
  } catch (err) {
    console.error("Internal /branches error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch branches" });
  }
});

export default router;
