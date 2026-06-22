import type { IncomingMessage } from "node:http";
import { constTimeEq } from "../wizard/guard.js";
import type { Role } from "./admins.js";
import type { Session, SessionStore } from "./sessions.js";

/**
 * Panel access control: Host allowlist (anti-DNS-rebind) + dual auth — a bootstrap TOKEN
 * (loopback dev, single owner; disabled once admins exist) OR a per-admin SESSION cookie with
 * double-submit CSRF + Origin checks. Default-deny. Returns the resolved actor for RBAC/audit.
 */

export interface Actor {
  username: string;
  role: Role;
  scopes: string[];
  sessionId: string;
  viaToken: boolean;
}

export interface AccessCtx {
  token: string;
  boundPort: number;
  allowedHosts: Set<string>;
  sessions: SessionStore;
  adminsExist: () => boolean;
}

export interface AccessResult {
  status: number;
  reason: string;
  actor?: Actor;
  /** true for a non-/api page request (served without auth; the SPA then authenticates). */
  page?: boolean;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const SESSION_COOKIE = "adpix_sess";

export function sessionToActor(s: Session): Actor {
  return { username: s.username, role: s.role, scopes: s.scopes, sessionId: s.id, viaToken: false };
}

export function resolveAccess(req: IncomingMessage, path: string, ctx: AccessCtx): AccessResult {
  const headers = req.headers;
  const host = (headers.host ?? "").toLowerCase();
  const [hostName, hostPort] = host.split(":");
  if (!ctx.allowedHosts.has(hostName) || (hostPort && hostPort !== String(ctx.boundPort)) || (!hostPort && ctx.boundPort !== 80)) {
    return { status: 421, reason: `Host "${host}" not allowed (DNS-rebind guard)` };
  }

  if (!path.startsWith("/api/")) return { status: 200, reason: "page", page: true };

  const method = req.method ?? "GET";
  // mutations must be JSON (escapes the simple-request CORS bypass)
  if (method !== "GET") {
    const ct = (headers["content-type"] ?? "").split(";")[0].trim();
    if (ct !== "application/json") return { status: 415, reason: "mutations require application/json" };
  }

  // 1) bootstrap token (loopback dev) — only while no admins are configured
  const tokenHdr = (headers["x-adpix-token"] as string) ?? "";
  if (tokenHdr && !ctx.adminsExist() && ctx.token && constTimeEq(tokenHdr, ctx.token)) {
    return { status: 200, reason: "token", actor: { username: "local", role: "owner", scopes: ["*"], sessionId: "bootstrap-token", viaToken: true } };
  }

  // 2) session cookie
  const cookies = parseCookies(headers.cookie);
  const session = ctx.sessions.get(cookies[SESSION_COOKIE]);
  if (session) {
    if (method !== "GET") {
      const origin = (headers.origin ?? "").toLowerCase();
      if (origin && origin !== `http://${hostName}:${ctx.boundPort}` && origin !== `https://${hostName}`) {
        return { status: 403, reason: `cross-origin: ${origin}` };
      }
      const csrf = (headers["x-adpix-csrf"] as string) ?? "";
      if (!constTimeEq(csrf, session.csrf)) return { status: 403, reason: "missing/invalid CSRF token" };
    }
    return { status: 200, reason: "session", actor: sessionToActor(session) };
  }

  return { status: 401, reason: ctx.adminsExist() ? "login required" : "missing/invalid token" };
}

export { SESSION_COOKIE };
