import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { realDeps, type Deps } from "../deps.js";
import { allTools } from "../tools/index.js";
import { isLoopback } from "../wizard/guard.js";
import { buildCatalog, type CatalogEntry } from "./catalog.js";
import { JobEngine } from "./engine.js";
import { SessionStore } from "./sessions.js";
import { NonceStore } from "./nonce.js";
import { loadAdmins, getAdmin, createAdmin, removeAdmin, ROLES, type Role } from "./admins.js";
import { verifyPassword, totpVerify, totpUri } from "./auth.js";
import { authorize } from "./rbac.js";
import { appendAudit, readAudit, verifyChain } from "./audit.js";
import { argsHash } from "./hash.js";
import { resolveAccess, parseCookies, SESSION_COOKIE, type Actor, type AccessCtx } from "./access.js";
import { buildFleet, listClusters } from "./fleet.js";
import { diagnoseServer } from "./diagnose.js";
import { buildDnsView } from "./aggregate/dns.js";
import { buildDbView } from "./aggregate/db.js";
import { buildSecurityView } from "./aggregate/security.js";
import { buildMonitorView } from "./aggregate/monitor.js";
import { buildQuorumView } from "./aggregate/cluster.js";
import { buildDeployView } from "./aggregate/deploy.js";
import { buildMcpStatus } from "./aggregate/mcp.js";
import { buildStacksStatus } from "./aggregate/stacks.js";
import { classifyError } from "./errors.js";
import { loadRegistry, saveRegistry } from "../registry.js";
import { panelMcpKeyPath, ensureMcpKey, saveUploadedKey } from "./keys.js";
import { shq } from "../util.js";

/**
 * The control-panel HTTP server. Phase 1 (loopback job engine + SPA) + Phase 2 hardening:
 * per-admin login (password + TOTP) with server-side sessions, default-deny RBAC + tenant
 * scoping, per-action re-auth nonces for destructive ops, a hash-chained audit log, and a
 * break-glass kill-switch. A bootstrap token grants owner on loopback ONLY until the first
 * admin is created, after which login is required. See docs/control-panel.md.
 */

export interface PanelOpts {
  port: number;
  host: string;
  token: string;
  deps?: Deps;
  /** Set Secure on the session cookie (required when behind TLS; off for loopback http). */
  secureCookies?: boolean;
  /** Extra Host header values to accept (the public FQDN when exposed). */
  allowedHosts?: string[];
}

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const MAX_BODY = 4 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-frame-options": "DENY", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "cache-control": "no-store",
};

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("invalid JSON body")); } });
    req.on("error", reject);
  });
}
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...HEADERS, ...extra, "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function serveStatic(res: ServerResponse, urlPath: string): void {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const full = fileURLToPath(new URL(rel, "file://" + PUBLIC_DIR));
  const idx = PUBLIC_DIR + "index.html";
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full)) {
    if (fs.existsSync(idx)) { res.writeHead(200, { ...HEADERS, "content-type": CONTENT_TYPES[".html"] }); res.end(fs.readFileSync(idx)); return; }
    res.writeHead(404, HEADERS).end("not found"); return;
  }
  const ext = full.slice(full.lastIndexOf("."));
  res.writeHead(200, { ...HEADERS, "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
  res.end(fs.readFileSync(full));
}
const ip = (req: IncomingMessage) => req.socket.remoteAddress ?? "?";
const targetOf = (args: Record<string, unknown>) => String(args.cluster ?? args.server ?? "_global");

export function createPanelServer(opts: PanelOpts): Server {
  const deps = opts.deps ?? realDeps;
  const engine = new JobEngine(deps);
  const sessions = new SessionStore();
  const nonces = new NonceStore();
  const toolByName = new Map(allTools.map((t) => [t.name, t]));
  const catByName = new Map<string, CatalogEntry>(buildCatalog().map((c) => [c.name, c]));
  let killed = false;

  const allowedHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]", ...(opts.allowedHosts ?? [])]);
  const audit = (actor: Actor, tool: string, target: string, args: Record<string, unknown>, outcome: string) =>
    appendAudit({ actor: actor.username, role: actor.role, ip: "", tool, target, argsHash: argsHash(args), outcome });

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";
    if (path === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }).end("ok"); return; }

    const ctx: AccessCtx = { token: opts.token, boundPort: req.socket.localPort ?? opts.port, allowedHosts, sessions, adminsExist: () => loadAdmins().length > 0 };
    const access = resolveAccess(req, path, ctx);
    if (access.status === 421) { sendJson(res, 421, { error: access.reason }); return; }

    try {
      // ---- unauthenticated status + auth endpoints (login / first-run setup) ----
      if (path === "/api/status" && method === "GET") { sendJson(res, 200, { adminsExist: loadAdmins().length > 0, killed }); return; }
      if (path === "/api/login" && method === "POST") return await handleLogin(req, res, opts, sessions);
      if (path === "/api/logout" && method === "POST") {
        const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        if (sid) sessions.revoke(sid);
        sendJson(res, 200, { ok: true }, { "set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
        return;
      }

      // ---- static page ----
      if (access.page) { serveStatic(res, path); return; }
      if (!access.actor) { sendJson(res, access.status, { error: access.reason }); return; }
      const actor = access.actor;

      // first-run: create the initial owner from the bootstrap token (then token is disabled)
      if (path === "/api/setup" && method === "POST") {
        if (loadAdmins().length > 0) { sendJson(res, 409, { error: "already set up — log in" }); return; }
        if (!actor.viaToken) { sendJson(res, 403, { error: "setup needs the bootstrap token" }); return; }
        const b = await readBody(req);
        if (!b.username || !b.password) { sendJson(res, 400, { error: "username + password required" }); return; }
        const { admin, totpSecret } = createAdmin(String(b.username), String(b.password), "owner");
        audit(actor, "panel.setup", admin.username, {}, "created owner");
        sendJson(res, 200, { username: admin.username, totpSecret, totpUri: totpUri(totpSecret, admin.username) });
        return;
      }

      if (path === "/api/me" && method === "GET") {
        const csrf = actor.viaToken ? undefined : sessions.get(actor.sessionId)?.csrf;
        sendJson(res, 200, { actor: { username: actor.username, role: actor.role, scopes: actor.scopes }, mode: actor.viaToken ? "token" : "session", csrf, killed, adminsExist: loadAdmins().length > 0 });
        return;
      }
      if (path === "/api/catalog" && method === "GET") { sendJson(res, 200, { tools: buildCatalog() }); return; }

      // ---- structured fleet model (dashboard + servers); cluster-scoped ----
      if (path === "/api/fleet" && method === "GET") {
        try { sendJson(res, 200, await buildFleet(deps, engine.list(), url.searchParams.get("cluster") ?? undefined)); }
        catch (e) { sendJson(res, 200, { cluster: { name: "", vip: "", servers: 0 }, counts: { healthy: 0, degraded: 0, down: 0, activeJobs: 0 }, nodes: [], recentJobs: [], alerts: [], error: classifyError(e).message }); }
        return;
      }
      // ---- clusters (for the switcher) ----
      if (path === "/api/clusters" && method === "GET") {
        sendJson(res, 200, { clusters: listClusters() });
        return;
      }
      // ---- DNS records (structured) ----
      if (path === "/api/dns" && method === "GET") {
        const az = authorize(actor.role, actor.scopes, catByName.get("dns_plan")!, {});
        if (!az.ok) { sendJson(res, 403, { error: az.reason }); return; }
        sendJson(res, 200, buildDnsView(url.searchParams.get("cluster") ?? undefined));
        return;
      }
      // ---- security audit + launch gate (structured) ----
      if (path === "/api/security" && method === "GET") {
        const az = authorize(actor.role, actor.scopes, catByName.get("security_audit")!, {});
        if (!az.ok) { sendJson(res, 403, { error: az.reason }); return; }
        sendJson(res, 200, await buildSecurityView(deps, url.searchParams.get("server") ?? undefined));
        return;
      }
      // ---- monitoring: front-door probes + TLS expiry (structured) ----
      if (path === "/api/monitoring" && method === "GET") {
        const az = authorize(actor.role, actor.scopes, catByName.get("health_check")!, {});
        if (!az.ok) { sendJson(res, 403, { error: az.reason }); return; }
        sendJson(res, 200, await buildMonitorView(deps, url.searchParams.get("server") ?? undefined, url.searchParams.get("cluster") ?? undefined));
        return;
      }
      // ---- HA quorum (structured) ----
      if (path === "/api/ha" && method === "GET") {
        const az = authorize(actor.role, actor.scopes, catByName.get("ha_quorum")!, {});
        if (!az.ok) { sendJson(res, 403, { error: az.reason }); return; }
        sendJson(res, 200, await buildQuorumView(deps, url.searchParams.get("cluster") ?? undefined));
        return;
      }
      // ---- deploys: version + CI/CD + history (structured) ----
      if (path === "/api/deploys" && method === "GET") {
        const az = authorize(actor.role, actor.scopes, catByName.get("cicd_status")!, {});
        if (!az.ok) { sendJson(res, 403, { error: az.reason }); return; }
        sendJson(res, 200, await buildDeployView(deps, url.searchParams.get("server") ?? undefined));
        return;
      }
      // ---- this MCP's own version + update status ----
      if (path === "/api/mcp" && method === "GET") {
        const az = authorize(actor.role, actor.scopes, catByName.get("mcp_status")!, {});
        if (!az.ok) { sendJson(res, 403, { error: az.reason }); return; }
        sendJson(res, 200, await buildMcpStatus(deps));
        return;
      }
      // ---- product stacks: per-stack version + commits-behind origin ----
      if (path === "/api/stacks" && method === "GET") {
        const az = authorize(actor.role, actor.scopes, catByName.get("stack_status")!, {});
        if (!az.ok) { sendJson(res, 403, { error: az.reason }); return; }
        sendJson(res, 200, await buildStacksStatus(deps, url.searchParams.get("server") ?? undefined));
        return;
      }
      // ---- databases view (structured stat cards + tune diff) ----
      if (path === "/api/db" && method === "GET") {
        const eng = url.searchParams.get("engine") === "ch" ? "ch" : "pg";
        const az = authorize(actor.role, actor.scopes, catByName.get(`${eng}_health`)!, {});
        if (!az.ok) { sendJson(res, 403, { error: az.reason }); return; }
        sendJson(res, 200, await buildDbView(deps, eng, url.searchParams.get("server") ?? undefined));
        return;
      }
      // ---- add-server wizard: full connectivity DIAGNOSIS (key or password) ----
      if ((path === "/api/wizard/diagnose" || path === "/api/wizard/verify-server") && method === "POST") {
        if (!["owner", "operator"].includes(actor.role)) { sendJson(res, 403, { error: "owner/operator only" }); return; }
        const b = await readBody(req);
        try {
          // pasted/uploaded private key → persist to a mode-600 file, use its path
          const keyPath = b.privateKey ? saveUploadedKey(String(b.name || b.host || "server"), String(b.privateKey)) : (b.privateKeyPath ? String(b.privateKeyPath) : undefined);
          const diag = await diagnoseServer(deps, { host: String(b.host || ""), port: Number(b.port) || 22, username: String(b.username || "root"), password: b.password ? String(b.password) : undefined, privateKeyPath: keyPath });
          sendJson(res, 200, diag);
        } catch (e) { sendJson(res, 200, { reachable: false, fingerprint: "", checks: [{ name: "Diagnose", ok: false, detail: classifyError(e).message, soft: false }], summary: classifyError(e).message, canAdd: false }); }
        return;
      }
      // ---- add a server (diagnosed first); if password-auth, authorize the MCP key then store the KEY PATH ----
      if (path === "/api/wizard/add-server" && method === "POST") {
        if (!["owner"].includes(actor.role)) { sendJson(res, 403, { error: "owner only" }); return; }
        const b = await readBody(req);
        const name = String(b.name || ""); const host = String(b.host || ""); const port = Number(b.port) || 22; const username = String(b.username || "root");
        const role = b.role === "witness" ? "witness" : "node"; const clusterName = b.cluster ? String(b.cluster) : "";
        if (!name || !host) { sendJson(res, 400, { error: "name + host are required" }); return; }
        try {
          // pasted/uploaded key → persist to a mode-600 file; else a path; else (password) the MCP key below
          let keyPath = b.privateKey ? saveUploadedKey(name, String(b.privateKey)) : (b.privateKeyPath ? String(b.privateKeyPath) : "");
          if (b.password) {
            // password bootstrap: generate the panel's MCP key if needed, append its pubkey to the
            // target's authorized_keys, then store the KEY PATH (the password is never persisted)
            const mcp = await ensureMcpKey(deps);
            const pub = (await deps.local(`cat ${shq(mcp + ".pub")} 2>/dev/null || true`)).stdout.trim();
            if (!pub.startsWith("ssh-")) { sendJson(res, 400, { error: `could not read the MCP public key at ${panelMcpKeyPath()}.pub` }); return; }
            const s = await deps.connect({ name, host, port, username, adpixDir: "/opt/adpix" }, { password: String(b.password) });
            try { await s.exec(`umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF ${shq(pub)} ~/.ssh/authorized_keys || echo ${shq(pub)} >> ~/.ssh/authorized_keys; echo OK`, { timeoutMs: 15000 }); } finally { s.close(); }
            keyPath = mcp;
          }
          const addTool = toolByName.get("server_add")!;
          const result = await addTool.handler(deps, { name, host, port, username, privateKeyPath: keyPath || undefined, verify: !b.password && !keyPath ? false : true });
          // assign to a cluster (create if new)
          if (clusterName) {
            const reg = loadRegistry();
            reg.clusters = reg.clusters ?? {};
            const c = reg.clusters[clusterName] ?? { nodes: [], hosts: [], idpIssuer: "https://account.adpix.io" };
            if (role === "witness") c.witness = name; else if (!c.nodes.includes(name)) c.nodes.push(name);
            reg.clusters[clusterName] = c; saveRegistry(reg);
          }
          audit(actor, "panel.add-server", name, { host, role, cluster: clusterName }, "added");
          sendJson(res, 200, { ok: true, result });
        } catch (e) { sendJson(res, 400, { error: classifyError(e).message }); }
        return;
      }

      // ---- admin (owner-only) ----
      if (path.startsWith("/api/admin/")) {
        if (actor.role !== "owner") { sendJson(res, 403, { error: "owner only" }); return; }
        return await handleAdmin(req, res, path, method, { sessions, audit: (t, tg, o) => audit(actor, t, tg, {}, o), getKilled: () => killed, setKilled: (v) => { killed = v; if (v) sessions.revokeAll(); } });
      }

      // ---- read-only tool, synchronous ----
      const syncM = path.match(/^\/api\/tools\/([a-z0-9_]+)$/);
      if (syncM && method === "POST") {
        const tool = toolByName.get(syncM[1]); const cat = catByName.get(syncM[1]);
        if (!tool || !cat) { sendJson(res, 404, { error: `unknown tool` }); return; }
        if (!cat.readOnly) { sendJson(res, 409, { error: `${tool.name} is not read-only — POST it to /api/jobs` }); return; }
        const b = await readBody(req); const args = (b.args as Record<string, unknown>) ?? {};
        const az = authorize(actor.role, actor.scopes, cat, args);
        if (!az.ok) { audit(actor, tool.name, targetOf(args), args, `denied: ${az.reason}`); sendJson(res, 403, { error: az.reason }); return; }
        const parsed = z.object(tool.schema).safeParse(args);
        if (!parsed.success) { sendJson(res, 400, { error: `invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}` }); return; }
        try {
          const result = await tool.handler(deps, parsed.data as Record<string, unknown>);
          audit(actor, tool.name, targetOf(args), args, "ran (read-only)");
          sendJson(res, 200, { result });
        } catch (e) { sendJson(res, 200, { result: `ERROR (${tool.name}): ${e instanceof Error ? e.message : String(e)}`, isError: true }); }
        return;
      }

      // ---- preview a destructive action → mint a single-use nonce ----
      if (path === "/api/preview" && method === "POST") {
        const b = await readBody(req); const tool = b.tool ? catByName.get(String(b.tool)) : undefined;
        const args = (b.args as Record<string, unknown>) ?? {};
        if (!tool) { sendJson(res, 404, { error: "unknown tool" }); return; }
        const az = authorize(actor.role, actor.scopes, tool, args);
        if (!az.ok) { sendJson(res, 403, { error: az.reason }); return; }
        const target = targetOf(args);
        const nonce = nonces.mint(actor.sessionId, tool.name, target, argsHash({ ...args, confirm: true }));
        sendJson(res, 200, { nonce, target, tool: tool.name, destructive: tool.destructive, summary: `${tool.name} → ${target}` });
        return;
      }

      // ---- enqueue a job ----
      if (path === "/api/jobs" && method === "POST") {
        const b = await readBody(req); const tool = b.tool ? toolByName.get(String(b.tool)) : undefined; const cat = b.tool ? catByName.get(String(b.tool)) : undefined;
        const args = (b.args as Record<string, unknown>) ?? {};
        if (!tool || !cat) { sendJson(res, 404, { error: `unknown tool "${b.tool}"` }); return; }
        const az = authorize(actor.role, actor.scopes, cat, args);
        if (!az.ok) { audit(actor, tool.name, targetOf(args), args, `denied: ${az.reason}`); sendJson(res, 403, { error: az.reason }); return; }
        if (killed && cat.destructive) { sendJson(res, 423, { error: "kill-switch engaged — destructive ops are disabled" }); return; }
        if (cat.destructive) {
          const cz = nonces.consume(String(b.nonce ?? ""), actor.sessionId, tool.name, targetOf(args), argsHash({ ...args, confirm: true }));
          if (!cz.ok) { sendJson(res, 428, { error: cz.reason }); return; }
        }
        const r = engine.enqueue(tool, cat.destructive ? { ...args, confirm: true } : args, { confirm: true, idempotencyKey: b.idempotencyKey as string, actor: actor.username });
        if ("error" in r) { sendJson(res, 400, r); return; }
        audit(actor, tool.name, targetOf(args), args, `job ${r.id} enqueued`);
        sendJson(res, 202, { job: r });
        return;
      }
      if (path === "/api/jobs" && method === "GET") { sendJson(res, 200, { jobs: engine.list() }); return; }

      const idM = path.match(/^\/api\/jobs\/([a-f0-9-]+)(\/cancel|\/stream)?$/);
      if (idM) {
        const [, id, sub] = idM;
        if (!sub && method === "GET") { const job = engine.get(id); return job ? sendJson(res, 200, { job }) : sendJson(res, 404, { error: "no such job" }); }
        if (sub === "/cancel" && method === "POST") { const ok = engine.cancel(id); if (ok) audit(actor, "job.cancel", id, {}, "canceled"); sendJson(res, ok ? 200 : 409, { canceled: ok }); return; }
        if (sub === "/stream" && method === "GET") {
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

async function handleLogin(req: IncomingMessage, res: ServerResponse, opts: PanelOpts, sessions: SessionStore): Promise<void> {
  if ((req.headers["content-type"] ?? "").split(";")[0].trim() !== "application/json") { sendJson(res, 415, { error: "json only" }); return; }
  const b = await readBody(req);
  const admin = b.username ? getAdmin(String(b.username)) : undefined;
  // constant-ish work whether or not the user exists
  const pwOk = admin ? verifyPassword(String(b.password ?? ""), admin.pwHash) : verifyPassword("x", "scrypt$00$00");
  if (!admin || !pwOk || !totpVerify(admin.totpSecret, String(b.totp ?? ""))) {
    sendJson(res, 401, { error: "invalid credentials or TOTP code" });
    return;
  }
  const s = sessions.create(admin, ip(req));
  appendAudit({ actor: admin.username, role: admin.role, ip: ip(req), tool: "panel.login", target: "-", argsHash: "-", outcome: "ok" });
  const secure = opts.secureCookies ? " Secure;" : "";
  sendJson(res, 200, { csrf: s.csrf, actor: { username: s.username, role: s.role, scopes: s.scopes } },
    { "set-cookie": `${SESSION_COOKIE}=${s.id}; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=${8 * 3600}` });
}

interface AdminCtx { sessions: SessionStore; audit: (tool: string, target: string, outcome: string) => void; getKilled: () => boolean; setKilled: (v: boolean) => void }
async function handleAdmin(req: IncomingMessage, res: ServerResponse, path: string, method: string, ctx: AdminCtx): Promise<void> {
  if (path === "/api/admin/sessions" && method === "GET") { sendJson(res, 200, { sessions: ctx.sessions.list().map((s) => ({ username: s.username, role: s.role, ip: s.ip, createdAt: s.createdAt, lastSeen: s.lastSeen })) }); return; }
  if (path === "/api/admin/sessions/revoke" && method === "POST") { const b = await readBody(req); const ok = ctx.sessions.revoke(String(b.id)); ctx.audit("panel.session.revoke", String(b.id), ok ? "revoked" : "missing"); sendJson(res, 200, { ok }); return; }
  if (path === "/api/admin/users" && method === "GET") { sendJson(res, 200, { users: loadAdmins().map((a) => ({ username: a.username, role: a.role, scopes: a.scopes, createdAt: a.createdAt })) }); return; }
  if (path === "/api/admin/users" && method === "POST") {
    const b = await readBody(req);
    if (!b.username || !b.password) { sendJson(res, 400, { error: "username + password required" }); return; }
    const role = (ROLES.includes(b.role as Role) ? b.role : "viewer") as Role;
    const scopes = Array.isArray(b.scopes) && b.scopes.length ? (b.scopes as string[]) : ["*"];
    try { const { admin, totpSecret } = createAdmin(String(b.username), String(b.password), role, scopes); ctx.audit("panel.user.create", admin.username, role); sendJson(res, 200, { username: admin.username, totpSecret, totpUri: totpUri(totpSecret, admin.username) }); }
    catch (e) { sendJson(res, 400, { error: e instanceof Error ? e.message : "failed" }); }
    return;
  }
  if (path === "/api/admin/users/remove" && method === "POST") { const b = await readBody(req); const ok = removeAdmin(String(b.username)); ctx.audit("panel.user.remove", String(b.username), ok ? "removed" : "missing"); sendJson(res, 200, { ok }); return; }
  if (path === "/api/admin/audit" && method === "GET") { sendJson(res, 200, { entries: readAudit(300), chain: verifyChain() }); return; }
  if (path === "/api/admin/kill" && method === "POST") { const b = await readBody(req); const on = b.on === true; ctx.setKilled(on); ctx.audit("panel.killswitch", "-", on ? "ENGAGED" : "released"); sendJson(res, 200, { killed: on }); return; }
  sendJson(res, 404, { error: "not found" });
}

export function servePanel(opts: PanelOpts): Promise<Server> {
  if (!isLoopback(opts.host) && !opts.token && loadAdmins().length === 0) {
    throw new Error("refusing non-loopback bind with neither a token nor any admin configured");
  }
  const server = createPanelServer(opts);
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(opts.port, opts.host, () => resolve(server)); });
}
