import dotenv from "dotenv";
dotenv.config();

export const mongoUri = process.env.MONGO_URI;
export const port = process.env.PORT || 5000;
export const environment = process.env.NODE_ENV || "development";

// HRMS — the identity provider all @wibro services trust. Same shared
// secret/key as erp-backend and portal-backend use between themselves.
export const hrmsApiUrl = process.env.HRMS_API_URL;
export const hrmsSvcApiKey = process.env.HRMS_SVC_API_KEY;
export const hrmsJwtSharedSecret = process.env.HRMS_JWT_SHARED_SECRET;
export const adminRoleId = process.env.ADMIN_ROLE_ID;

// Guards the /internal routes this service exposes for other services
// (HRMS's admin UI, for the branch dropdown) to call into.
export const internalApiKey = process.env.INTERNAL_API_KEY;

// NOTE: there is deliberately no default/fallback branch. A user's branch is
// whatever HRMS has on their Login (assigned in the staff-registration form),
// or null. A hardcoded fallback would silently hand every branchless user one
// specific warehouse's data — and would break outright the moment that
// warehouse is deleted, which is exactly what happened while it existed.
