import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { request, type Server } from "node:http";
import { servePanel } from "../src/panel/server.js";
import { totpCode } from "../src/panel/auth.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";

const SRV: ServerConfig = { name: "prod", host: "10.0.0.1", port: 22, username: "root", adpixDir: "/opt/adpix" };
function benignDeps(): Deps {
  const s: Session = { server: SRV, authMethod: "publickey", close: () => {}, exec: async (): Promise<ExecResult> => ({ code: 0, stdout: "ok", stderr: "" }) };
  return { resolve: () => SRV, connect: async () => s, local: async () => ({ code: 0, stdout: "ok", stderr: "" }) };
}

let tmp: string; const SAVED = process.env.ADPIX_DEVOPS_HOME;
let server: Server; let base: string; const TOKEN = "t".repeat(64);
beforeEach(async () => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-fail-")); process.env.ADPIX_DEVOPS_HOME = tmp; server = await servePanel({ port: 0, host: "127.0.0.1", token: TOKEN, deps: benignDeps() }); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
afterEach(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

const TOK = { "x-adpix-token": TOKEN };
const J = (h: Record<string, string> = {}) => ({ "content-type": "application/json", ...h });
const post = (p: string, body: unknown, h: Record<string, string> = {}) => fetch(`${base}${p}`, { method: "POST", headers: J(h), body: typeof body === "string" ? body : JSON.stringify(body) });
async function owner() { // setup + login → {cookie, csrf}
  const sec = (await (await post("/api/setup", { username: "ali", password: "pw" }, TOK)).json()).totpSecret;
  const r = await post("/api/login", { username: "ali", password: "pw", totp: totpCode(sec) });
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0]; const { csrf } = await r.json();
  return { cookie, csrf, sec, mut: () => ({ cookie, "content-type": "application/json", "x-adpix-csrf": csrf }) };
}

// ---------------------------------------------------------------- DNS-rebind / transport
describe("transport + host guard", () => {
  it("rejects a spoofed Host header (421)", async () => {
    const port = (server.address() as { port: number }).port;
    const status = await new Promise<number>((res, rej) => { const r = request({ host: "127.0.0.1", port, path: "/api/me", method: "GET", headers: { host: "evil.test", "x-adpix-token": TOKEN } }, (x) => { x.resume(); res(x.statusCode!); }); r.on("error", rej); r.end(); });
    expect(status).toBe(421);
  });
  it("healthz needs no auth; unknown api route 404; unknown tool 404", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/api/nope`, { headers: TOK })).status).toBe(404);
    expect((await post("/api/tools/does_not_exist", { args: {} }, TOK)).status).toBe(404);
  });
});

// ---------------------------------------------------------------- input validation
describe("malformed + oversized input", () => {
  it("refuses a >4MB body (dropped at the socket, not buffered)", async () => {
    let refused = false;
    try { const r = await post("/api/jobs", "x".repeat(5 * 1024 * 1024), TOK); refused = r.status >= 400; }
    catch { refused = true; } // server destroys the connection on flood → fetch rejects
    expect(refused).toBe(true);
  });
  it("rejects malformed JSON (400)", async () => {
    expect((await post("/api/jobs", "{not json", TOK)).status).toBe(400);
  });
  it("rejects schema-invalid job args (400)", async () => {
    const r = await post("/api/jobs", { tool: "adpix_logs", args: { lines: "lots" } }, TOK);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/invalid args/);
  });
  it("non-read-only tool via the sync endpoint is 409", async () => {
    expect((await post("/api/tools/adpix_restart", { args: {} }, TOK)).status).toBe(409);
  });
  it("mutation without application/json is 415", async () => {
    const r = await fetch(`${base}/api/jobs`, { method: "POST", headers: { ...TOK, "content-type": "text/plain" }, body: "{}" });
    expect(r.status).toBe(415);
  });
});

// ---------------------------------------------------------------- auth failures
describe("auth failure modes", () => {
  it("token stops working once the first admin exists", async () => {
    expect((await fetch(`${base}/api/me`, { headers: TOK })).status).toBe(200);
    await post("/api/setup", { username: "ali", password: "pw" }, TOK);
    expect((await fetch(`${base}/api/me`, { headers: TOK })).status).toBe(401);
  });
  it("login rejects non-JSON, wrong password, wrong TOTP, unknown user", async () => {
    const sec = (await (await post("/api/setup", { username: "ali", password: "pw" }, TOK)).json()).totpSecret;
    expect((await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })).status).toBe(415);
    expect((await post("/api/login", { username: "ali", password: "WRONG", totp: totpCode(sec) })).status).toBe(401);
    expect((await post("/api/login", { username: "ali", password: "pw", totp: "000000" })).status).toBe(401);
    expect((await post("/api/login", { username: "ghost", password: "pw", totp: "000000" })).status).toBe(401);
  });
  it("a forged session cookie is not accepted", async () => {
    await post("/api/setup", { username: "ali", password: "pw" }, TOK);
    expect((await fetch(`${base}/api/me`, { headers: { cookie: "adpix_sess=deadbeef" } })).status).toBe(401);
  });
  it("a session mutation without the CSRF token is 403", async () => {
    const o = await owner();
    const r = await fetch(`${base}/api/jobs`, { method: "POST", headers: { cookie: o.cookie, "content-type": "application/json" }, body: JSON.stringify({ tool: "adpix_status", args: {} }) });
    expect(r.status).toBe(403);
  });
  it("setup is refused once an admin exists (with a valid owner session → 409)", async () => {
    const o = await owner();
    expect((await fetch(`${base}/api/setup`, { method: "POST", headers: o.mut(), body: JSON.stringify({ username: "x", password: "y" }) })).status).toBe(409);
  });
});

// ---------------------------------------------------------------- RBAC
describe("RBAC enforcement", () => {
  async function viewer() {
    const o = await owner();
    const made = await (await fetch(`${base}/api/admin/users`, { method: "POST", headers: o.mut(), body: JSON.stringify({ username: "vic", password: "pw", role: "viewer" }) })).json();
    const r = await post("/api/login", { username: "vic", password: "pw", totp: totpCode(made.totpSecret) });
    const cookie = (r.headers.get("set-cookie") || "").split(";")[0]; const { csrf } = await r.json();
    return { cookie, mut: () => ({ cookie, "content-type": "application/json", "x-adpix-csrf": csrf }) };
  }
  it("a viewer cannot run a mutating job (403) but can read", async () => {
    const v = await viewer();
    expect((await fetch(`${base}/api/jobs`, { method: "POST", headers: v.mut(), body: JSON.stringify({ tool: "adpix_update", args: {} }) })).status).toBe(403);
    expect((await fetch(`${base}/api/tools/health_check`, { method: "POST", headers: v.mut(), body: JSON.stringify({ args: {} }) })).status).toBe(200);
  });
  it("a viewer cannot reach owner-only admin endpoints (403)", async () => {
    const v = await viewer();
    expect((await fetch(`${base}/api/admin/audit`, { headers: { cookie: v.cookie } })).status).toBe(403);
  });
});

// ---------------------------------------------------------------- destructive gating
describe("destructive op gating", () => {
  it("blocks a destructive job without / with a bad nonce (428)", async () => {
    expect((await post("/api/jobs", { tool: "pg_restore_db", args: { dumpPath: "x" } }, TOK)).status).toBe(428);
    expect((await post("/api/jobs", { tool: "pg_restore_db", args: { dumpPath: "x" }, nonce: "garbage" }, TOK)).status).toBe(428);
  });
  it("a nonce minted for different args does not authorize (428)", async () => {
    const pv = await (await post("/api/preview", { tool: "pg_restore_db", args: { dumpPath: "a" } }, TOK)).json();
    const r = await post("/api/jobs", { tool: "pg_restore_db", args: { dumpPath: "DIFFERENT" }, nonce: pv.nonce }, TOK);
    expect(r.status).toBe(428);
  });
  it("kill-switch blocks destructive ops (423) even with a fresh nonce", async () => {
    const o = await owner();
    await fetch(`${base}/api/admin/kill`, { method: "POST", headers: o.mut(), body: JSON.stringify({ on: true }) });
    // the kill-switch revoked all sessions → re-login the existing admin
    const r = await post("/api/login", { username: "ali", password: "pw", totp: totpCode(o.sec) });
    const cookie = (r.headers.get("set-cookie") || "").split(";")[0]; const { csrf } = await r.json();
    const mut = { cookie, "content-type": "application/json", "x-adpix-csrf": csrf };
    const pv = await (await fetch(`${base}/api/preview`, { method: "POST", headers: mut, body: JSON.stringify({ tool: "pg_restore_db", args: { dumpPath: "x" } }) })).json();
    const job = await fetch(`${base}/api/jobs`, { method: "POST", headers: mut, body: JSON.stringify({ tool: "pg_restore_db", args: { dumpPath: "x" }, nonce: pv.nonce }) });
    expect(job.status).toBe(423);
  });
});

// ---------------------------------------------------------------- job routes
describe("job route edge cases", () => {
  it("unknown job id / cancel / stream behave", async () => {
    expect((await fetch(`${base}/api/jobs/deadbeef`, { headers: TOK })).status).toBe(404);
    expect((await post("/api/jobs/deadbeef/cancel", {}, TOK)).status).toBe(409);
    expect((await fetch(`${base}/api/jobs/deadbeef/stream`, { headers: TOK })).status).toBe(404);
  });
  it("unknown tool on the job + preview endpoints is 404", async () => {
    expect((await post("/api/jobs", { tool: "nope" }, TOK)).status).toBe(404);
    expect((await post("/api/preview", { tool: "nope", args: {} }, TOK)).status).toBe(404);
  });
});
