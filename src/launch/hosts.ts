/**
 * Pure helpers for the launch-readiness checks. Host classification encodes the
 * two-TLD trust boundary + the Set-Cookie carve-out (LAUNCH_ALIGNMENT §1/§6); the
 * parse helpers turn raw `curl -D -` / `openssl x509` output into structured data.
 * All deterministic + unit-tested; the tools do the I/O and call these.
 */

/** The 8 public hosts the front-door Caddy serves (the SITE_ADDRESS set). */
export const DEFAULT_LAUNCH_HOSTS = [
  "account.adpix.io",
  "tagmanager.adpix.io",
  "analytics.adpix.io",
  "api.adpix.io",
  "cdn.adpix.net",
  "collect.adpix.net",
  "config.adpix.net",
  "gateway.adpix.net",
];

export interface HostClass {
  host: string;
  plane: "control" | "data";
  product: string;
  /** false → a Set-Cookie on this host is a FAIL (cookieless data plane). */
  setCookieAllowed: boolean;
  /** Expected Cache-Control posture, or "" when not host-level checkable. */
  cache: "" | "no-store" | "cacheable";
  note: string;
}

/**
 * Classify a launch host. The security-relevant rule: cdn/collect/config.adpix.net
 * are cookieless (Set-Cookie must be stripped); gateway.adpix.net is the exception —
 * its first-party server cookies are legitimate (ADR-0033). Everything on adpix.io
 * is the cookied control plane.
 */
export function classifyHost(host: string): HostClass {
  const h = host.trim().toLowerCase();
  if (h === "cdn.adpix.net")
    return { host: h, plane: "data", product: "shared-cdn", setCookieAllowed: false, cache: "cacheable", note: "cookieless delivery — Set-Cookie must be stripped" };
  if (h === "collect.adpix.net")
    return { host: h, plane: "data", product: "analytics-ingest", setCookieAllowed: false, cache: "no-store", note: "cookieless write path — Set-Cookie stripped, no-store" };
  if (h === "config.adpix.net")
    return { host: h, plane: "data", product: "analytics-ingest", setCookieAllowed: false, cache: "cacheable", note: "cookieless config — Set-Cookie stripped, cacheable (max-age=60+SWR)" };
  if (h === "gateway.adpix.net" || h === "sgtm.adpix.net")
    return { host: h, plane: "data", product: "tag-gateway", setCookieAllowed: true, cache: "", note: "first-party Tag-Gateway — Set-Cookie is LEGITIMATE (ADR-0033), do not strip" };
  if (h.endsWith(".adpix.net"))
    return { host: h, plane: "data", product: "unknown", setCookieAllowed: false, cache: "", note: "data plane" };
  // control plane (adpix.io)
  const product = h.startsWith("account.")
    ? "idp"
    : h.startsWith("tagmanager.")
      ? "tagmanager"
      : h.startsWith("analytics.")
        ? "analytics"
        : h.startsWith("api.")
          ? "shared-api"
          : "control";
  return { host: h, plane: "control", product, setCookieAllowed: true, cache: "", note: "cookied control plane" };
}

export interface ParsedResponse {
  /** Final HTTP status (last block wins across redirects); 0 if none parsed. */
  status: number;
  /** Header name (lowercased) → all values seen across every response block. */
  headers: Record<string, string[]>;
}

/**
 * Parse `curl -D -` header dump. Merges headers across redirect blocks (so a
 * Set-Cookie on any hop is caught) and keeps the LAST status line.
 */
export function parseHeaders(raw: string): ParsedResponse {
  const headers: Record<string, string[]> = {};
  let status = 0;
  for (const line of raw.split(/\r?\n/)) {
    const sm = line.match(/^HTTP\/[\d.]+\s+(\d+)/);
    if (sm) {
      status = Number(sm[1]);
      continue;
    }
    const m = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (m) {
      const k = m[1].toLowerCase();
      (headers[k] ??= []).push(m[2].trim());
    }
  }
  return { status, headers };
}

/** Days until the cert in `openssl x509 -enddate` output expires (null if unparseable). */
export function certDaysFromEnddate(out: string, nowMs: number): number | null {
  const m = out.match(/notAfter=(.*)/);
  if (!m) return null;
  const t = Date.parse(m[1].trim());
  if (Number.isNaN(t)) return null;
  return Math.floor((t - nowMs) / 86_400_000);
}

/** Required env keys + their known demo-default sentinels (fail-fast in prod). */
export interface SecretSpec {
  key: string;
  /** A value equal to this means "still the insecure default". Empty string ⇒ "must be non-empty". */
  demoDefault?: string;
  note?: string;
}

export const ANALYTICS_SECRETS: SecretSpec[] = [
  { key: "SESSION_SECRET", demoDefault: "dev-insecure-change-me" },
  { key: "S2S_ENC_KEY", demoDefault: "dev-insecure-change-me" },
  { key: "ADMIN_PASSWORD", demoDefault: "sovereign-admin" },
  { key: "SERVER_API_KEY", demoDefault: "demo_server_key" },
  { key: "CLICKHOUSE_PASSWORD", demoDefault: "", note: "empty fails APP_ENV=production boot (ADR-0039)" },
  { key: "OIDC_ISSUER", note: "https://account.adpix.io — the shared IdP" },
  { key: "SITE_ADDRESS", note: "the full Caddy host list" },
];

export const TAGMANAGER_SECRETS: SecretSpec[] = [
  { key: "OIDC_PRIVATE_KEY_PEM", note: "stable RS256 key — ephemeral churns SSO tokens on restart" },
  { key: "DATABASE_URL" },
  { key: "AUTH_ISSUER", note: "https://account.adpix.io" },
  { key: "S3_ACCESS_KEY" },
  { key: "S3_SECRET_KEY" },
  { key: "PURGE_TOKEN" },
  { key: "COOKIE_DOMAIN", note: ".adpix.io — shared SSO cookie + /session/check" },
];

/** The 7 Analytics P1 release-blockers (2026-06-20 audit) — the Gate 0 list. */
export const ANALYTICS_P1_BLOCKERS = [
  "auth takeover",
  "privilege escalation (vector 1)",
  "privilege escalation (vector 2)",
  "consent fails OPEN (should fail closed)",
  "P1 #5 (see 2026-06-20 audit)",
  "P1 #6 (see 2026-06-20 audit)",
  "P1 #7 (see 2026-06-20 audit)",
];
