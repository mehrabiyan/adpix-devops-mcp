import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { OAuthProvider, safeEqual, type HttpReply, type Scope } from "./oauth.js";

/**
 * Remote-hosting mode: Streamable HTTP transport on /mcp, stateless (a fresh
 * McpServer per request — fine for a tools-only server). Two auth modes coexist:
 *   - the static MCP_AUTH_TOKEN (Authorization: Bearer …) → full scope, for
 *     header-capable clients (Claude Code/Desktop);
 *   - OAuth 2.1 (opt-in via `oauth`) for clients that require it — the provider
 *     issues scoped access tokens accepted here.
 * TLS is terminated by Caddy in front, so the default bind is loopback.
 */

export interface HttpOpts {
  port: number;
  host: string;
  /** Static admin token. Empty = loopback-only tokenless dev mode. */
  token: string;
  /** Enable the OAuth authorization server (metadata + /authorize + /token + /register). */
  oauth?: OAuthProvider;
}

const MAX_BODY = 8 * 1024 * 1024;

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseForm(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(s)) out[k] = v;
  return out;
}

/** Parse a body as form or JSON per content-type (token/register accept both). */
async function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  const raw = await readRawBody(req);
  const ct = req.headers["content-type"] ?? "";
  if (ct.includes("application/json")) {
    try {
      return JSON.parse(raw || "{}") as Record<string, string>;
    } catch {
      return {};
    }
  }
  return parseForm(raw);
}

function sendReply(res: ServerResponse, r: HttpReply): void {
  const headers: Record<string, string> = { ...(r.headers ?? {}) };
  if (r.location) headers["location"] = r.location;
  if (r.json !== undefined) headers["content-type"] = "application/json";
  if (r.html !== undefined) headers["content-type"] = "text/html; charset=utf-8";
  res.writeHead(r.status, headers);
  res.end(r.json !== undefined ? JSON.stringify(r.json) : (r.html ?? ""));
}

function deny(res: ServerResponse, status: number, message: string, wwwAuth?: string): void {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (status === 401) headers["www-authenticate"] = wwwAuth ?? "Bearer";
  res.writeHead(status, headers);
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

/**
 * Resolve the scope a request is authorized for, or null (401):
 *  - bearer == static admin token → full;
 *  - bearer is a valid OAuth access token → its scope;
 *  - no auth configured at all (loopback dev) → full.
 */
function resolveScope(authHeader: string | undefined, opts: HttpOpts): Scope | null {
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (opts.token && bearer && safeEqual(bearer, opts.token)) return "mcp:full";
  if (opts.oauth && bearer) {
    const s = opts.oauth.verifyAccessToken(bearer);
    if (s) return s;
  }
  if (!opts.token && !opts.oauth) return "mcp:full"; // tokenless loopback dev
  return null;
}

export function serveHttp(buildScoped: (scope: Scope) => McpServer, opts: HttpOpts): Promise<Server> {
  const oauth = opts.oauth;
  const httpServer = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const query = Object.fromEntries(new URL(req.url ?? "", "http://x").searchParams) as Record<string, string>;

    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }

    // ---- OAuth authorization server (opt-in) ---------------------------------
    if (oauth) {
      try {
        if (req.method === "GET" && path === "/.well-known/oauth-protected-resource") return sendReply(res, oauth.protectedResourceMetadata());
        if (req.method === "GET" && (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration")) return sendReply(res, oauth.authServerMetadata());
        if (req.method === "POST" && path === "/register") return sendReply(res, oauth.register(await readBody(req)));
        if (req.method === "GET" && path === "/authorize") return sendReply(res, oauth.authorizeGet(query));
        if (req.method === "POST" && path === "/authorize") return sendReply(res, oauth.authorizePost(await readBody(req)));
        if (req.method === "POST" && path === "/token") return sendReply(res, oauth.token(await readBody(req)));
      } catch (err) {
        return sendReply(res, { status: 400, json: { error: "invalid_request", error_description: err instanceof Error ? err.message : "bad request" } });
      }
    }

    if (path !== "/mcp") {
      deny(res, 404, "not found — the MCP endpoint is /mcp");
      return;
    }

    const scope = resolveScope(req.headers.authorization, opts);
    if (!scope) {
      const www = oauth
        ? `Bearer resource_metadata="${oauth.resourceMetadataUrl()}"`
        : "Bearer";
      deny(res, 401, "unauthorized: authenticate with a Bearer token or OAuth", www);
      return;
    }
    if (req.method !== "POST") {
      deny(res, 405, "method not allowed — POST JSON-RPC messages to /mcp");
      return;
    }

    try {
      const body = JSON.parse(await readRawBody(req));
      const server = buildScoped(scope);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) deny(res, 400, err instanceof Error ? err.message : "bad request");
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, () => resolve(httpServer));
  });
}
