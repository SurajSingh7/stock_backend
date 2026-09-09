import jwt from "jsonwebtoken";
import { runWithActor } from "../helpers/request.context.js";
import {
  hrmsApiUrl,
  hrmsSvcApiKey,
  hrmsJwtSharedSecret,
  adminRoleId,
} from "../config/env.config.js";
import { createHttpClient } from "../helpers/http.helper.js";

const hrmsApi = createHttpClient({
  baseURL: hrmsApiUrl,
  headers: { "x-api-key": hrmsSvcApiKey },
  timeout: 5000,
});

// Short-TTL cache so a burst of requests from the same user doesn't hit HRMS
// on every single call — HRMS being briefly slow/unreachable shouldn't take
// this whole service down with it. 30s is a deliberate tradeoff: fresh enough
// that a role change shows up almost immediately, cheap enough to matter.
const USER_CONTEXT_TTL_MS = 30_000;
const userContextCache = new Map(); // userId -> { user, expiresAt }

function getCachedUser(userId) {
  const entry = userContextCache.get(userId);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.user;
}

function setCachedUser(userId, user) {
  userContextCache.set(userId, { user, expiresAt: Date.now() + USER_CONTEXT_TTL_MS });
}

/* ── Branch prerequisite ───────────────────────────────────────────────────
 * Stock is branch-scoped from top to bottom: inventory, transfers and invoices
 * all filter on branchId, and vendors/products are written against one. A user
 * with no branch is not a restricted user — they are an unusable one. Every
 * list comes back empty with nothing on screen to explain why, and any write
 * that stores a branch either fails deep in a service or saves a row its own
 * author can no longer read back.
 *
 * So it is refused once, here, rather than surfacing as ten different
 * confusing symptoms. The branch itself lives in HRMS (see routes/internal.routes.js
 * — HRMS reads the branch list from this service and stores the chosen id), so
 * this is the only place that can see it arrive missing.
 *
 * WHY IN authenticate: every stock route calls authenticate individually — there
 * is no app-level auth layer to hang this off. A router.use() would re-run
 * authenticate for every request, and adding a middleware to 120+ route lines
 * would be a large diff for one rule. This is the single choke point.
 *
 * The two exempt paths are what lets the frontend explain the problem rather
 * than just breaking: /access-control/my-permissions is what PermissionContext
 * calls on boot, and it must be able to answer with branchId: null so the UI can
 * show the "no branch assigned" screen. /me is the matching diagnostic. Both are
 * read-only and return nothing but the caller's own identity.
 *
 * Admins are NOT exempt, deliberately: an admin with no branch hits the same
 * empty lists and unusable writes as anyone else, and the fix lives in HRMS
 * rather than in this app, so blocking them locks nobody out of anything they
 * could have repaired from here. To exempt them, add `&& !req.user.isAdmin`
 * to the condition below.
 */
const BRANCH_EXEMPT_PATHS = new Set(["/me", "/access-control/my-permissions"]);

export const BRANCH_REQUIRED_CODE = "BRANCH_NOT_ASSIGNED";

export async function authenticate(req, res, next) {
  try {
    const token = req.cookies?.userSession;
    if (!token) {
      return res.status(401).json({ success: false, message: "Unauthenticated user" });
    }

    let payload;
    try {
      payload = jwt.verify(token, hrmsJwtSharedSecret, { algorithms: ["HS256"] });
    } catch (err) {
      const message =
        err.name === "TokenExpiredError"
          ? "Session expired, please log in again"
          : "Invalid session";
      return res.status(401).json({ success: false, message });
    }

    const userId = payload._id || payload.id || payload.sub;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Invalid token payload" });
    }

    let hrmsUser = getCachedUser(userId);
    if (!hrmsUser) {
      let userCtx;
      try {
        userCtx = await hrmsApi.get(`/internal/user-context/${encodeURIComponent(userId)}`);
      } catch (err) {
        if (err.status) {
          // HRMS answered — trust its status (e.g. 404 = no such user, token
          // for a deleted account). Not the same failure as HRMS being down.
          return res.status(401).json({ success: false, message: "User not found" });
        }
        // No answer at all — network error/timeout/connection refused.
        return res
          .status(503)
          .json({ success: false, message: "Identity service unavailable, please try again shortly" });
      }

      hrmsUser = userCtx?.data?.user;
      if (!hrmsUser) {
        return res.status(401).json({ success: false, message: "User not found" });
      }
      setCachedUser(userId, hrmsUser);
    }


    const branchId = hrmsUser.branch ?? null;

    req.user = {
      // `_id` — matches the actingUser(req) shape already used across the
      // existing controllers (req.user?._id, req.user?.name).
      _id: hrmsUser._id,
      // The company-facing identifier (payroll / ID card). Snapshotted onto
      // every createdBy-updatedBy-deletedBy stamp, so a row names the person
      // the way HR does, not just by a display name two people can share.
      employeeCode: hrmsUser.basicemployees?.employeeCode ?? "",
      name: `${hrmsUser.basicemployees?.firstName ?? ""} ${hrmsUser.basicemployees?.lastName ?? ""}`.trim(),
      email: hrmsUser.email,
      phone: hrmsUser.personal?.phone,
      roleId: hrmsUser.role?._id,
      roleName: hrmsUser.role?.name,
      // HRMS has always returned department in the user context; captured here
      // because the permission layer intersects role actions with the
      // department's restriction (see stock.permission.middleware.js).
      departmentId: hrmsUser.department?._id ?? null,
      departmentName: hrmsUser.department?.name ?? "",
      branchId,
      isAdmin: hrmsUser.role?._id?.toString() === adminRoleId,
      ipAddress: req.ip || req.connection?.remoteAddress || null,
      userAgent: req.headers["user-agent"] || "",
    };

    // Checked AFTER req.user is built, so the exempt endpoints still answer with
    // a fully populated user (carrying branchId: null) instead of a bare 403 the
    // frontend could not interpret. `code` is what the client keys off — the
    // message is for humans and may be reworded.
    if (!req.user.branchId && !BRANCH_EXEMPT_PATHS.has(req.path)) {
      return res.status(403).json({
        success: false,
        code: BRANCH_REQUIRED_CODE,
        message:
          "Your account has no branch assigned, so Stock cannot be used yet. Ask an administrator to set your branch in HRMS, then sign in again.",
      });
    }

    // Everything downstream of here runs inside a context carrying the actor,
    // so the actor-stamp plugin can fill createdBy/updatedBy on any write
    // without every service having to thread the user down to the model layer.
    // runWithActor wraps next(), so the context covers the whole rest of the
    // request — including work that resumes after an await.
    return runWithActor(req.user, () => next());
  } catch (err) {
    console.error("Auth middleware error:", err);
    return res.status(500).json({ success: false, message: "Authentication failed" });
  }
}

// Composes on top of authenticate — reads the flag it already derived,
// never re-verifies the token itself. One code path for "is admin", ever.
export function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Unauthenticated user" });
  }
  if (!req.user.isAdmin) {
    return res.status(403).json({ success: false, message: "You are not authorized to perform this action" });
  }
  next();
}
