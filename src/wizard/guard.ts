import { timingSafeEqual, randomBytes } from "node:crypto";

/**
 * The web wizard's request guard — the security-critical core. The wizard collects SSH
 * credentials for the whole fleet over a browser, so a single bypass = fleet root. These
 * are the non-negotiable controls (from the adversarial review): loopback Host allowlist
 * (anti-DNS-rebind), a single-use token in a request HEADER (anti-CSRF; no cookies),
 * Origin/Sec-Fetch same-origin, JSON-only mutations. Pure + exhaustively unit-tested.
 */

/** 256-bit CSPRNG session token, fresh per launch. */
export function newToken(): string {
  return randomBytes(32).toString("hex");
}

export function constTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export interface GuardInput {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
}

export interface GuardResult {
  ok: boolean;
  status: number;
  reason: string;
}

const ALLOWED_HOST_NAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Decide whether a request may proceed. The SPA page (GET, non-/api) loads without a token
 * (it then reads the token from the URL fragment); every /api/* call must carry the token
 * header and pass the CSRF/rebind checks.
 */
export function guard(input: GuardInput, token: string, port: number): GuardResult {
  const host = (input.headers["host"] ?? "").toLowerCase();
  const [hostName, hostPort] = host.split(":");
  // 1. anti-DNS-rebind: strict Host allowlist (exact name + the wizard's port)
  if (!ALLOWED_HOST_NAMES.has(hostName) || hostPort !== String(port)) {
    return { ok: false, status: 421, reason: `Host "${host}" not allowed (DNS-rebind guard)` };
  }

  const isApi = input.path.startsWith("/api/");
  if (!isApi) return { ok: true, status: 200, reason: "page (no token needed to load)" };

  // 2. CSRF: a valid token HEADER on every API call (cookies are never used)
  const provided = input.headers["x-adpix-token"] ?? "";
  if (!constTimeEq(provided, token)) return { ok: false, status: 401, reason: "missing/invalid token header" };

  // 3. Origin / Sec-Fetch same-origin
  const origin = (input.headers["origin"] ?? "").toLowerCase();
  if (origin && origin !== `http://${hostName}:${port}`) return { ok: false, status: 403, reason: `cross-origin: ${origin}` };
  const sfs = input.headers["sec-fetch-site"];
  if (sfs && sfs !== "same-origin" && sfs !== "none") return { ok: false, status: 403, reason: `Sec-Fetch-Site: ${sfs}` };

  // 4. mutating requests must be application/json (escapes the simple-request CORS bypass)
  if (input.method !== "GET") {
    const ct = (input.headers["content-type"] ?? "").split(";")[0].trim();
    if (ct !== "application/json") return { ok: false, status: 415, reason: "mutations require application/json" };
  }

  return { ok: true, status: 200, reason: "ok" };
}

/** Security headers applied to EVERY wizard response. */
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store, no-cache, must-revalidate",
  "x-content-type-options": "nosniff",
};

/** True only for a loopback bind address. */
export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
