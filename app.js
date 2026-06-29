import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import stockRoutes from "./routes/v1.stock.routes.js";

dotenv.config();

const app = express();
app.use(express.json());

// Health check
app.get("/", (req, res) => res.json({ status: "Stock API running" }));

app.use("/api/v1/stock", stockRoutes);

// 404 handler
app.use((req, res) => res.status(404).json({ success: false, message: "Route not found" }));

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected");
    app.listen(process.env.PORT || 5000, () => {
      console.log(`🚀 Server running on http://localhost:${process.env.PORT || 5000}`);
    });
  })
  .catch((err) => {
    console.error("❌ DB connection failed:", err.message);
    process.exit(1);
  });
