// Structural safety net for the exact bug class that slipped into
// erp-backend: a route that quietly ships with no permission check because
// someone forgot to add it. Walks every route actually registered in
// routes/v1.stock.routes.js and fails if one is missing its expected
// middleware. Run with `npm run check:routes` — wire into CI once one exists.
import router from "../routes/v1.stock.routes.js";

// Routes intentionally requiring only authenticate (self-info reads, no
// module action to check permission against).
const AUTH_ONLY_ROUTES = [
  { path: "/me", method: "get" },
  { path: "/access-control/my-permissions", method: "get" },
  // Reference data with no per-user dimension, read by every GST dropdown in
  // the app. Gating it on `gst-rates:READ` would make the Master > GST Rates
  // management permission a prerequisite for pricing anything — see the route
  // comment in routes/v1.stock.routes.js.
  { path: "/gst-rates/active", method: "get" },
];

const ADMIN_ONLY_PREFIXES = ["/access-control", "/audit-log"];

const isAuthOnly = (path, method) =>
  AUTH_ONLY_ROUTES.some((r) => r.path === path && r.method === method);

const failures = [];
let checked = 0;

for (const layer of router.stack) {
  if (!layer.route) continue;

  const path = layer.route.path;
  const middlewareNames = layer.route.stack.map((s) => s.name);
  const hasAuth = middlewareNames.includes("authenticate");
  const hasPermissionCheck = middlewareNames.includes("permissionCheck");
  const hasRequireAdmin = middlewareNames.includes("requireAdmin");

  for (const method of Object.keys(layer.route.methods)) {
    checked++;

    if (isAuthOnly(path, method)) {
      if (!hasAuth) failures.push(`${method.toUpperCase()} ${path} — missing authenticate`);
      continue;
    }

    if (ADMIN_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      if (!hasAuth || !hasRequireAdmin) {
        failures.push(`${method.toUpperCase()} ${path} — admin route missing authenticate/requireAdmin`);
      }
      continue;
    }

    if (!hasAuth || !hasPermissionCheck) {
      failures.push(`${method.toUpperCase()} ${path} — missing authenticate/requirePermission`);
    }
  }
}

console.log(`Checked ${checked} route(s).`);
if (failures.length) {
  console.error(`${failures.length} route(s) missing required middleware:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("All routes have the expected auth/permission middleware.");
process.exit(0);
