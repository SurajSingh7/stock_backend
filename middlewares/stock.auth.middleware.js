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

    // Branch comes from HRMS and nowhere else — it's whatever an admin picked
    // in the staff-registration Login step. null is a legitimate value: most
    // HRMS users (sales, HR) are not branch staff and never get one.
    //
    // Deliberately NOT a 403 here. Blocking at this layer would also lock out
    // admins and anyone holding ALL_BRANCHES scope, since authenticate runs
    // before requirePermission. A branchless user is let through and the scope
    // layer resolves them to zero rows — restrictive, but not a lockout.
    const branchId = hrmsUser.branch ?? null;

    req.user = {
      // `_id` — matches the actingUser(req) shape already used across the
      // existing controllers (req.user?._id, req.user?.name).
      _id: hrmsUser._id,
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
