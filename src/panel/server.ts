import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { realDeps, type Deps } from "../deps.js";
import { allTools } from "../tools/index.js";
import { guard, isLoopback } from "../wizard/guard.js";
import { buildCatalog } from "./catalog.js";
import { JobEngine } from "./engine.js";

/**
 * The control-panel HTTP server (Phase 1, loopback-first). Serves the SPA + a thin JSON API
 * over allTools: read-only tools run inline, mutating/slow tools become async JOBS with live
 * SSE log streaming. Reuses the wizard guard (Host allowlist anti-DNS-rebind, token header
 * anti-CSRF, Origin/Sec-Fetch, JSON-only mutations). Reached via an SSH tunnel; the
 * internet-facing hardening (OIDC+MFA, RBAC, off-host audit) is Phase 2.
 */

export interface PanelOpts {
  port: number;
  host: string;
  token: string;
  deps?: Deps;
}

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const MAX_BODY = 4 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Panel security headers — like the wizard's, but allows Google Fonts + inline style attrs the design uses. */
const HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...HEADERS, "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function serveStatic(res: ServerResponse, urlPath: string): void {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  // contain to the public dir (no traversal)
  const full = fileURLToPath(new URL(rel, "file://" + PUBLIC_DIR));
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full)) {
    // SPA fallback to index.html for client routes
    const idx = PUBLIC_DIR + "index.html";
    if (fs.existsSync(idx)) { res.writeHead(200, { ...HEADERS, "content-type": CONTENT_TYPES[".html"] }); res.end(fs.readFileSync(idx)); return; }
    res.writeHead(404, HEADERS).end("not found");
    return;
  }
  const ext = full.slice(full.lastIndexOf("."));
  res.writeHead(200, { ...HEADERS, "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
  res.end(fs.readFileSync(full));
}

export function createPanelServer(opts: PanelOpts): Server {
  const deps = opts.deps ?? realDeps;
  const engine = new JobEngine(deps);
  const toolByName = new Map(allTools.map((t) => [t.name, t]));

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    if (path === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }).end("ok"); return; }

    // validate the Host header port against the port the client actually connected to
    const boundPort = req.socket.localPort ?? opts.port;
    const g = guard({ method: req.method ?? "GET", path, headers: req.headers as Record<string, string | undefined> }, opts.token, boundPort);
    if (!g.ok) { sendJson(res, g.status, { error: g.reason }); return; }

    // static SPA
    if (!path.startsWith("/api/")) { serveStatic(res, path); return; }

    try {
      // GET /api/catalog
      if (path === "/api/catalog" && req.method === "GET") {
        sendJson(res, 200, { tools: buildCatalog() });
        return;
      }
      // GET /api/jobs
      if (path === "/api/jobs" && req.method === "GET") {
        sendJson(res, 200, { jobs: engine.list() });
        return;
      }
      // POST /api/jobs  { tool, args, confirm, idempotencyKey }
      if (path === "/api/jobs" && req.method === "POST") {
        const body = (await readBody(req)) as { tool?: string; args?: Record<string, unknown>; confirm?: boolean; idempotencyKey?: string };
        const tool = body.tool ? toolByName.get(body.tool) : undefined;
        if (!tool) { sendJson(res, 404, { error: `unknown tool "${body.tool}"` }); return; }
        const r = engine.enqueue(tool, body.args ?? {}, { confirm: body.confirm, idempotencyKey: body.idempotencyKey });
        if ("error" in r) { sendJson(res, 400, r); return; }
        sendJson(res, 202, { job: r });
        return;
      }
      // POST /api/tools/:name  — synchronous run, READ-ONLY tools only
      const syncM = path.match(/^\/api\/tools\/([a-z0-9_]+)$/);
      if (syncM && req.method === "POST") {
        const tool = toolByName.get(syncM[1]);
        if (!tool) { sendJson(res, 404, { error: `unknown tool "${syncM[1]}"` }); return; }
        if (!tool.annotations?.readOnlyHint) { sendJson(res, 409, { error: `${tool.name} is not read-only — POST it to /api/jobs` }); return; }
        const body = (await readBody(req)) as { args?: Record<string, unknown> };
        const parsed = z.object(tool.schema).safeParse(body.args ?? {});
        if (!parsed.success) { sendJson(res, 400, { error: `invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}` }); return; }
        try {
          const result = await tool.handler(deps, parsed.data as Record<string, unknown>);
          sendJson(res, 200, { result });
        } catch (e) {
          sendJson(res, 200, { result: `ERROR (${tool.name}): ${e instanceof Error ? e.message : String(e)}`, isError: true });
        }
        return;
      }
      // job by id  /api/jobs/:id  (+ /cancel, /stream)
      const idM = path.match(/^\/api\/jobs\/([a-f0-9-]+)(\/cancel|\/stream)?$/);
      if (idM) {
        const [, id, sub] = idM;
        if (!sub && req.method === "GET") {
          const job = engine.get(id);
          if (!job) { sendJson(res, 404, { error: "no such job" }); return; }
          sendJson(res, 200, { job });
          return;
        }
        if (sub === "/cancel" && req.method === "POST") {
          const ok = engine.cancel(id);
          sendJson(res, ok ? 200 : 409, { canceled: ok });
          return;
        }
        if (sub === "/stream" && req.method === "GET") {
          if (!engine.get(id)) { sendJson(res, 404, { error: "no such job" }); return; }
          res.writeHead(200, { ...HEADERS, "content-type": "text/event-stream", connection: "keep-alive" });
          const unsub = engine.subscribe(id, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
          req.on("close", unsub);
          return;
        }
      }
      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) sendJson(res, 400, { error: e instanceof Error ? e.message : "bad request" });
    }
  });
}

export function servePanel(opts: PanelOpts): Promise<Server> {
  if (!isLoopback(opts.host) && !opts.token) {
    throw new Error("refusing non-loopback bind without a token — the panel holds fleet-root access");
  }
  const server = createPanelServer(opts);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve(server));
  });
}
