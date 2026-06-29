/**
 * HOW TO REGISTER STOCK ROUTES IN YOUR EXISTING app.js / globalRoutes
 *
 * Add this import at the top of your existing route registration file:
 *
 *   import stockRoutes from "./stock/routes/v1.stock.routes.js";
 *
 * Then register with your existing router, e.g.:
 *
 *   app.use("/api/v1/stock", stockRoutes);
 *
 * Or if using a globalRoutes pattern, add inside the existing registration block:
 *
 *   router.use("/stock", stockRoutes);
 *
 * ─── Optional: run seeder on startup ─────────────────────────────────────────
 *
 * Import and call once after DB connection:
 *
 *   import { seedFieldDefinitions } from "./stock/seeders/stock.field.definition.seeder.js";
 *   await seedFieldDefinitions();
 *
 * Or run standalone:
 *
 *   node src/stock/seeders/stock.field.definition.seeder.js
 */
