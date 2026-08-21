import express from "express";
import { verifyInternalServiceKey } from "../middlewares/stock.internal.auth.middleware.js";
import StockWarehouseModel from "../models/stock.warehouse.model.js";

const router = express.Router();

// Consumed by HRMS's admin UI to populate the branch-assignment dropdown
// when an admin assigns a warehouse to a Login — see the "Branch
// prerequisite" phase of the access-control plan. Warehouse data stays
// owned here; HRMS only ever stores the id it gets back from this list.
router.get("/warehouses", verifyInternalServiceKey, async (req, res) => {
  try {
    const warehouses = await StockWarehouseModel.find({ isActive: true })
      .select("_id name code city state")
      .sort({ name: 1 })
      .lean();
    return res.json({ success: true, data: warehouses });
  } catch (err) {
    console.error("Internal /warehouses error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch warehouses" });
  }
});

export default router;
