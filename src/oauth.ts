import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { registryDir } from "./registry.js";

/**
 * Minimal MCP OAuth 2.1 authorization server so remote MCP clients that require
 * OAuth (e.g. web chatbots doing Dynamic Client Registration) can connect. It is
 * deliberately small and standards-shaped:
 *   - RFC 9728 protected-resource metadata + RFC 8414 auth-server metadata
 *   - RFC 7591 dynamic client registration (public clients, PKCE)
 *   - authorization-code + PKCE(S256) and refresh_token grants
 *
 * The human-authentication step reuses the existing MCP admin bearer token
 * (MCP_AUTH_TOKEN): whoever approves the consent screen must enter it, and there
 * chooses the granted scope. So the chatbot can start the flow, but a human with
 * the admin token gates every authorization and picks least privilege by default.
 *
 * Scopes:  mcp:read → read-only tools only   ·   mcp:full → every tool.
 * Issued access tokens are accepted by the /mcp endpoint; the static
 * MCP_AUTH_TOKEN keeps working (full scope) for header-based clients.
 */

export const SCOPES = ["mcp:read", "mcp:full"] as const;
export type Scope = (typeof SCOPES)[number];

export interface OAuthClient {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  created_at: number;
}

interface TokenRecord {
  tokenHash: string;
  clientId: string;
  scope: Scope;
  expiresAt: number;
  refreshHash?: string;
}

interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: Scope;
  expiresAt: number;
}

export interface HttpReply {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  html?: string;
  location?: string;
}

const ACCESS_TTL_MS = 60 * 60 * 1000; // 1h
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
const CODE_TTL_MS = 60 * 1000; // 1m

export function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}
function randTok(bytes = 32): string {
  return b64url(randomBytes(bytes));
}
/** Constant-time string compare via fixed-width hashes (no length leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}
/** PKCE S256 check: base64url(sha256(verifier)) === challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const computed = b64url(sha256(verifier));
  // constant-time over equal-length base64url strings
  if (computed.length !== challenge.length) return false;
  return timingSafeEqual(Buffer.from(computed), Buffer.from(challenge));
}

/** Which scope grants a given tool. Read-only tools need only mcp:read. */
export function scopeAllows(scope: Scope, readOnly: boolean): boolean {
  return scope === "mcp:full" || readOnly;
}

export interface OAuthOptions {
  /** Public base URL, e.g. https://dev.adpix.io (no trailing slash). */
  issuer: string;
  /** The admin bearer token used to gate the consent screen. */
  adminToken: string;
  /** Where to persist registered clients + issued tokens. Defaults to the registry dir. */
  storePath?: string;
}

export class OAuthProvider {
  private issuer: string;
  private adminToken: string;
  private storePath: string;
  private clients = new Map<string, OAuthClient>();
  private tokens: TokenRecord[] = [];
  private codes = new Map<string, AuthCode>(); // in-memory only (short TTL)

  constructor(opts: OAuthOptions) {
    this.issuer = opts.issuer.replace(/\/$/, "");
    this.adminToken = opts.adminToken;
    this.storePath = opts.storePath ?? path.join(registryDir(), "oauth.json");
    this.load();
  }

  /** URL a 401 points clients at for OAuth discovery (RFC 9728). */
  resourceMetadataUrl(): string {
    return `${this.issuer}/.well-known/oauth-protected-resource`;
  }

  // ---- persistence (clients + tokens; codes are ephemeral) --------------------
  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.storePath, "utf8")) as {
        clients?: OAuthClient[];
        tokens?: TokenRecord[];
      };
      for (const c of raw.clients ?? []) this.clients.set(c.client_id, c);
      this.tokens = (raw.tokens ?? []).filter((t) => t.expiresAt > Date.now());
    } catch {
      /* fresh store */
    }
  }
  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true, mode: 0o700 });
      const body = JSON.stringify(
        { clients: [...this.clients.values()], tokens: this.tokens.filter((t) => t.expiresAt > Date.now()) },
        null,
        2
      );
      fs.writeFileSync(this.storePath, body, { mode: 0o600 });
    } catch {
      /* best-effort; tokens still valid in memory this process */
    }
  }

  // ---- discovery metadata -----------------------------------------------------
  protectedResourceMetadata(): HttpReply {
    return {
      status: 200,
      json: {
        resource: `${this.issuer}/mcp`,
        authorization_servers: [this.issuer],
        scopes_supported: SCOPES,
        bearer_methods_supported: ["header"],
      },
    };
  }
  authServerMetadata(): HttpReply {
    return {
      status: 200,
      json: {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        registration_endpoint: `${this.issuer}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: SCOPES,
      },
    };
  }

  // ---- dynamic client registration (RFC 7591) ---------------------------------
  register(body: Record<string, unknown>): HttpReply {
    const redirect_uris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]).filter((u) => typeof u === "string") : [];
    if (redirect_uris.length === 0) {
      return { status: 400, json: { error: "invalid_client_metadata", error_description: "redirect_uris is required" } };
    }
    for (const u of redirect_uris) {
      try {
        const url = new URL(u);
        if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
          return { status: 400, json: { error: "invalid_redirect_uri", error_description: `redirect_uri must be https (or localhost): ${u}` } };
        }
      } catch {
        return { status: 400, json: { error: "invalid_redirect_uri", error_description: `not a URL: ${u}` } };
      }
    }
    const client: OAuthClient = {
      client_id: `mcp_${randTok(12)}`,
      redirect_uris,
      client_name: typeof body.client_name === "string" ? body.client_name : undefined,
      created_at: Date.now(),
    };
    this.clients.set(client.client_id, client);
    this.save();
    return {
      status: 201,
      json: {
        client_id: client.client_id,
        client_id_issued_at: Math.floor(client.created_at / 1000),
        redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: SCOPES.join(" "),
      },
    };
  }

  getClient(id: string): OAuthClient | undefined {
    return this.clients.get(id);
  }

  // ---- authorization endpoint -------------------------------------------------
  /** GET /authorize → validate, then render the consent + admin-auth screen. */
  authorizeGet(q: Record<string, string>): HttpReply {
    const client = q.client_id ? this.clients.get(q.client_id) : undefined;
    if (!client) return htmlError(400, "Unknown client_id. The app must register first (dynamic registration).");
    if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) {
      return htmlError(400, "redirect_uri does not match this client's registration.");
    }
    // From here, errors go BACK to the client via redirect (per OAuth).
    if (q.response_type !== "code") return this.redirectError(q, "unsupported_response_type");
    if (q.code_challenge_method !== "S256" || !q.code_challenge) return this.redirectError(q, "invalid_request", "PKCE S256 required");
    return { status: 200, html: consentPage({ issuer: this.issuer, client, query: q }) };
  }

  /** POST /authorize (consent submit) → verify admin token, mint an auth code. */
  authorizePost(form: Record<string, string>): HttpReply {
    const client = form.client_id ? this.clients.get(form.client_id) : undefined;
    if (!client || !form.redirect_uri || !client.redirect_uris.includes(form.redirect_uri)) {
      return htmlError(400, "Invalid client or redirect_uri.");
    }
    if (form.decision === "deny") return this.redirectError(form, "access_denied");
    if (!form.admin_token || !this.adminToken || !safeEqual(form.admin_token, this.adminToken)) {
      // re-render consent with an error (don't leak whether the token was close)
      return { status: 401, html: consentPage({ issuer: this.issuer, client, query: form, error: "Incorrect admin token." }) };
    }
    if (form.code_challenge_method !== "S256" || !form.code_challenge) return this.redirectError(form, "invalid_request", "PKCE S256 required");
    const scope: Scope = form.scope === "mcp:full" ? "mcp:full" : "mcp:read";
    const code = randTok(24);
    this.codes.set(code, {
      code,
      clientId: client.client_id,
      redirectUri: form.redirect_uri,
      codeChallenge: form.code_challenge,
      scope,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const loc = new URL(form.redirect_uri);
    loc.searchParams.set("code", code);
    if (form.state) loc.searchParams.set("state", form.state);
    return { status: 302, location: loc.toString() };
  }

  private redirectError(q: Record<string, string>, error: string, desc?: string): HttpReply {
    try {
      const loc = new URL(q.redirect_uri);
      loc.searchParams.set("error", error);
      if (desc) loc.searchParams.set("error_description", desc);
      if (q.state) loc.searchParams.set("state", q.state);
      return { status: 302, location: loc.toString() };
    } catch {
      return htmlError(400, `${error}${desc ? `: ${desc}` : ""}`);
    }
  }

  // ---- token endpoint ---------------------------------------------------------
  token(form: Record<string, string>): HttpReply {
    if (form.grant_type === "authorization_code") return this.tokenFromCode(form);
    if (form.grant_type === "refresh_token") return this.tokenFromRefresh(form);
    return { status: 400, json: { error: "unsupported_grant_type" } };
  }

  private issue(clientId: string, scope: Scope): HttpReply {
    const access = randTok(32);
    const refresh = randTok(32);
    this.tokens.push({
      tokenHash: b64url(sha256(access)),
      refreshHash: b64url(sha256(refresh)),
      clientId,
      scope,
      expiresAt: Date.now() + ACCESS_TTL_MS,
    });
    // prune expired
    this.tokens = this.tokens.filter((t) => t.expiresAt > Date.now() || t.refreshHash);
    this.save();
    return {
      status: 200,
      headers: { "cache-control": "no-store" },
      json: { access_token: access, token_type: "Bearer", expires_in: Math.floor(ACCESS_TTL_MS / 1000), refresh_token: refresh, scope },
    };
  }

  private tokenFromCode(form: Record<string, string>): HttpReply {
    const rec = form.code ? this.codes.get(form.code) : undefined;
    if (!rec) return { status: 400, json: { error: "invalid_grant", error_description: "unknown or used code" } };
    this.codes.delete(rec.code); // single-use, even on failure below
    if (rec.expiresAt < Date.now()) return { status: 400, json: { error: "invalid_grant", error_description: "code expired" } };
    if (rec.clientId !== form.client_id) return { status: 400, json: { error: "invalid_grant", error_description: "client mismatch" } };
    if (rec.redirectUri !== form.redirect_uri) return { status: 400, json: { error: "invalid_grant", error_description: "redirect_uri mismatch" } };
    if (!verifyPkceS256(form.code_verifier ?? "", rec.codeChallenge)) {
      return { status: 400, json: { error: "invalid_grant", error_description: "PKCE verification failed" } };
    }
    return this.issue(rec.clientId, rec.scope);
  }

  private tokenFromRefresh(form: Record<string, string>): HttpReply {
    const hash = form.refresh_token ? b64url(sha256(form.refresh_token)) : "";
    const idx = this.tokens.findIndex((t) => t.refreshHash && t.refreshHash === hash);
    if (idx < 0) return { status: 400, json: { error: "invalid_grant", error_description: "unknown refresh_token" } };
    const old = this.tokens[idx];
    if (form.client_id && old.clientId !== form.client_id) return { status: 400, json: { error: "invalid_grant" } };
    this.tokens.splice(idx, 1); // rotate
    return this.issue(old.clientId, old.scope);
  }

  // ---- resource-server check (used by /mcp) -----------------------------------
  /** Validate an access token; returns its scope or null. Prunes on the way. */
  verifyAccessToken(token: string): Scope | null {
    if (!token) return null;
    const hash = b64url(sha256(token));
    const now = Date.now();
    const rec = this.tokens.find((t) => t.tokenHash === hash && t.expiresAt > now);
    return rec ? rec.scope : null;
  }
}

function htmlError(status: number, msg: string): HttpReply {
  return { status, html: `<!doctype html><meta charset=utf8><title>Error</title><body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1>Authorization error</h1><p>${escapeHtml(msg)}</p></body>` };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The consent + admin-auth screen. Carries the OAuth params in hidden fields. */
function consentPage(o: { issuer: string; client: OAuthClient; query: Record<string, string>; error?: string }): string {
  const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method"]
    .map((k) => `<input type=hidden name="${k}" value="${escapeHtml(o.query[k] ?? "")}">`)
    .join("");
  const redirectHost = (() => {
    try {
      return new URL(o.query.redirect_uri).host;
    } catch {
      return o.query.redirect_uri ?? "";
    }
  })();
  return `<!doctype html><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Authorize — AdPix DevOps MCP</title>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a">
<h1 style="font-size:1.4rem">Authorize access to your infrastructure</h1>
<p><b>${escapeHtml(o.client.client_name || o.client.client_id)}</b> (redirecting to <code>${escapeHtml(redirectHost)}</code>) is requesting access to the AdPix DevOps MCP at <code>${escapeHtml(o.issuer)}</code>.</p>
<p style="background:#fff4e5;border:1px solid #f0c98a;padding:.75rem 1rem;border-radius:8px">⚠️ This grants an external app control over your servers. Prefer <b>read-only</b> unless you fully trust it. Approving requires your MCP admin token.</p>
${o.error ? `<p style="color:#b00020"><b>${escapeHtml(o.error)}</b></p>` : ""}
<form method=post action="/authorize">
${hidden}
<fieldset style="border:1px solid #ddd;border-radius:8px;padding:.5rem 1rem;margin:1rem 0">
<legend>Access level</legend>
<label style="display:block;margin:.4rem 0"><input type=radio name=scope value="mcp:read" checked> <b>Read-only</b> — health, status, capacity, consult (recommended)</label>
<label style="display:block;margin:.4rem 0"><input type=radio name=scope value="mcp:full"> <b>Full access</b> — every tool, including root run_command, deploys, secret rotation</label>
</fieldset>
<label style="display:block;margin:1rem 0">MCP admin token<br><input type=password name=admin_token autocomplete=off style="width:100%;padding:.5rem;font-size:1rem;box-sizing:border-box" required></label>
<div style="display:flex;gap:.75rem;margin-top:1rem">
<button type=submit name=decision value=approve style="padding:.6rem 1.2rem;font-size:1rem;background:#0a7;color:#fff;border:0;border-radius:6px;cursor:pointer">Approve</button>
<button type=submit name=decision value=deny style="padding:.6rem 1.2rem;font-size:1rem;background:#eee;border:0;border-radius:6px;cursor:pointer">Deny</button>
</div>
</form>
</body>`;
}
