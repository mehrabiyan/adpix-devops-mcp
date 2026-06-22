import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { request, type Server } from "node:http";
import { z } from "zod";
import { JobEngine } from "../src/panel/engine.js";
import { redactArgs, loadJobs, saveJobs, type JobRecord } from "../src/panel/store.js";
import { buildCatalog } from "../src/panel/catalog.js";
import { servePanel } from "../src/panel/server.js";
import { allTools } from "../src/tools/index.js";
import { totpCode } from "../src/panel/auth.js";
import type { ToolDef } from "../src/tools/types.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";

let tmp: string;
const SAVED = process.env.ADPIX_DEVOPS_HOME;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-panel-")); process.env.ADPIX_DEVOPS_HOME = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

const benignDeps = (): Deps => {
  const session: Session = { server: { name: "prod", host: "10.0.0.1", port: 22, username: "root", adpixDir: "/opt/adpix" }, authMethod: "publickey", close: () => {}, exec: async (): Promise<ExecResult> => ({ code: 0, stdout: "ok-output", stderr: "" }) };
  return { resolve: () => session.server, connect: async () => session, local: async () => ({ code: 0, stdout: "local-ok", stderr: "" }) };
};

// ---------------------------------------------------------------- store
describe("panel store", () => {
  it("redacts secret-looking arg values by key", () => {
    const r = redactArgs({ host: "1.2.3.4", purgeToken: "abc", s3SecretKey: "xyz", count: 3 });
    expect(r.host).toBe("1.2.3.4");
    expect(r.count).toBe(3);
    expect(r.purgeToken).toBe("[redacted]");
    expect(r.s3SecretKey).toBe("[redacted]");
  });
  it("persists + reloads jobs atomically (mode 600)", () => {
    const job: JobRecord = { id: "a", tool: "x", args: {}, status: "succeeded", key: "_", createdAt: "t", logTail: [] };
    saveJobs([job]);
    expect((fs.statSync(path.join(tmp, "jobs.json")).mode & 0o777)).toBe(0o600);
    expect(loadJobs()[0].id).toBe("a");
  });
});

// ---------------------------------------------------------------- catalog
describe("panel catalog", () => {
  it("derives one entry per tool with params + annotation flags", () => {
    const cat = buildCatalog(allTools);
    expect(cat.length).toBe(allTools.length);
    const hc = cat.find((e) => e.name === "health_check")!;
    expect(hc.readOnly).toBe(true);
    expect(hc.params).toBeTruthy();
    const restore = cat.find((e) => e.name === "pg_restore_db")!;
    expect(restore.destructive).toBe(true);
    expect(restore.group).toBe("backups");
  });
});

// ---------------------------------------------------------------- engine
const fakeTool = (over: Partial<ToolDef> = {}): ToolDef => ({
  name: "fake", title: "Fake", description: "fake tool", schema: {},
  handler: async (deps) => { await deps.local("echo step-1"); await deps.local("echo step-2"); return "FAKE DONE"; },
  ...over,
});

function waitForDone(engine: JobEngine, id: string): Promise<JobRecord> {
  return new Promise((resolve) => engine.subscribe(id, (e) => { if (e.type === "done" && e.job) resolve(e.job); }));
}

describe("panel job engine", () => {
  it("runs a job, streams redacted logs, and returns the result", async () => {
    const engine = new JobEngine(benignDeps());
    const logs: string[] = [];
    const r = engine.enqueue(fakeTool(), {});
    expect("error" in r).toBe(false);
    const id = (r as JobRecord).id;
    engine.subscribe(id, (e) => { if (e.type === "log") logs.push(e.line!); });
    const done = await waitForDone(engine, id);
    expect(done.status).toBe("succeeded");
    expect(done.result).toBe("FAKE DONE");
    expect(logs.some((l) => /echo step-1/.test(l))).toBe(true);
  });

  it("refuses a destructive tool without confirm, accepts with confirm", () => {
    const engine = new JobEngine(benignDeps());
    const t = fakeTool({ name: "boom", annotations: { destructiveHint: true } });
    expect(engine.enqueue(t, {})).toEqual({ error: expect.stringContaining("confirm:true required") });
    expect("error" in engine.enqueue(t, {}, { confirm: true })).toBe(false);
  });

  it("rejects schema-invalid args", () => {
    const engine = new JobEngine(benignDeps());
    const t = fakeTool({ schema: { name: z.string() } }); // required
    expect(engine.enqueue(t, {})).toEqual({ error: expect.stringContaining("invalid args") });
  });

  it("dedupes by idempotency key while in flight", () => {
    const engine = new JobEngine(benignDeps());
    const a = engine.enqueue(fakeTool(), {}, { idempotencyKey: "k1" }) as JobRecord;
    const b = engine.enqueue(fakeTool(), {}, { idempotencyKey: "k1" }) as JobRecord;
    expect(b.id).toBe(a.id);
  });

  it("reconciles in-flight jobs to interrupted on boot", () => {
    saveJobs([{ id: "z", tool: "x", args: {}, status: "running", key: "_", createdAt: "t", logTail: [] }]);
    const engine = new JobEngine(benignDeps());
    expect(engine.get("z")!.status).toBe("interrupted");
  });

  it("marks a job failed when the handler throws (ERROR-wrapped)", async () => {
    const engine = new JobEngine(benignDeps());
    const t = fakeTool({ name: "thrower", handler: async () => { throw new Error("boom"); } });
    const id = (engine.enqueue(t, {}) as JobRecord).id;
    const done = await waitForDone(engine, id);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("ERROR (thrower): boom");
  });
});

// ---------------------------------------------------------------- live server
async function withServer(fn: (base: string, token: string) => Promise<void>) {
  const token = "a".repeat(64);
  const server: Server = await servePanel({ port: 0, host: "127.0.0.1", token, deps: benignDeps() });
  const port = (server.address() as { port: number }).port;
  try { await fn(`http://127.0.0.1:${port}`, token); } finally { server.close(); }
}
const H = (token: string) => ({ "x-adpix-token": token });

describe("panel server (live)", () => {
  it("serves the catalog only with a valid token", async () => {
    await withServer(async (base, token) => {
      const no = await fetch(`${base}/api/catalog`);
      expect(no.status).toBe(401);
      const ok = await fetch(`${base}/api/catalog`, { headers: H(token) });
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body.tools.length).toBe(allTools.length);
    });
  });

  it("rejects a foreign Host header (DNS-rebind guard)", async () => {
    // fetch() forbids setting Host, so use a raw request to actually spoof it through the guard
    const token = "a".repeat(64);
    const server: Server = await servePanel({ port: 0, host: "127.0.0.1", token, deps: benignDeps() });
    const port = (server.address() as { port: number }).port;
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/api/catalog", method: "GET", headers: { host: "evil.com", "x-adpix-token": token } }, (res) => { res.resume(); resolve(res.statusCode!); });
        req.on("error", reject); req.end();
      });
      expect(status).toBe(421);
    } finally { server.close(); }
  });

  it("runs a read-only tool synchronously", async () => {
    await withServer(async (base, token) => {
      const r = await fetch(`${base}/api/tools/health_check`, { method: "POST", headers: { ...H(token), "content-type": "application/json" }, body: JSON.stringify({ args: {} }) });
      expect(r.status).toBe(200);
      expect((await r.json()).result.length).toBeGreaterThan(0);
    });
  });

  it("refuses to run a non-read-only tool synchronously (409 → use jobs)", async () => {
    await withServer(async (base, token) => {
      const r = await fetch(`${base}/api/tools/adpix_restart`, { method: "POST", headers: { ...H(token), "content-type": "application/json" }, body: JSON.stringify({ args: {} }) });
      expect(r.status).toBe(409);
    });
  });

  it("enqueues a job and reports it terminal via the jobs API", async () => {
    await withServer(async (base, token) => {
      const r = await fetch(`${base}/api/jobs`, { method: "POST", headers: { ...H(token), "content-type": "application/json" }, body: JSON.stringify({ tool: "adpix_status", args: {} }) });
      expect(r.status).toBe(202);
      const id = (await r.json()).job.id;
      let status = "queued";
      for (let i = 0; i < 40 && status !== "succeeded" && status !== "failed"; i++) {
        await new Promise((res) => setTimeout(res, 25));
        status = (await (await fetch(`${base}/api/jobs/${id}`, { headers: H(token) })).json()).job.status;
      }
      expect(["succeeded", "failed"]).toContain(status);
    });
  });

  it("blocks a destructive job without a re-auth nonce (428)", async () => {
    await withServer(async (base, token) => {
      const r = await fetch(`${base}/api/jobs`, { method: "POST", headers: { ...H(token), "content-type": "application/json" }, body: JSON.stringify({ tool: "pg_restore_db", args: { dumpPath: "x.dump" } }) });
      expect(r.status).toBe(428);
    });
  });

  it("preview mints a nonce that lets the destructive job through", async () => {
    await withServer(async (base, token) => {
      const pv = await (await fetch(`${base}/api/preview`, { method: "POST", headers: { ...H(token), "content-type": "application/json" }, body: JSON.stringify({ tool: "pg_restore_db", args: { dumpPath: "x.dump" } }) })).json();
      expect(pv.nonce).toBeTruthy();
      const r = await fetch(`${base}/api/jobs`, { method: "POST", headers: { ...H(token), "content-type": "application/json" }, body: JSON.stringify({ tool: "pg_restore_db", args: { dumpPath: "x.dump" }, nonce: pv.nonce }) });
      expect(r.status).toBe(202);
    });
  });
});

// ---------------------------------------------------------------- Phase 2: auth + RBAC
const J = (extra: Record<string, string> = {}) => ({ "content-type": "application/json", ...extra });
async function setupAndLogin(base: string, token: string, username: string, password: string, role?: string) {
  // first owner uses the bootstrap token; subsequent users created via the admin API
  const ownerSetup = await fetch(`${base}/api/setup`, { method: "POST", headers: J(H(token)), body: JSON.stringify({ username, password }) });
  const sec = (await ownerSetup.json()).totpSecret;
  return login(base, username, password, sec);
}
async function login(base: string, username: string, password: string, secret: string) {
  const r = await fetch(`${base}/api/login`, { method: "POST", headers: J(), body: JSON.stringify({ username, password, totp: totpCode(secret) }) });
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  const { csrf } = await r.json();
  return { status: r.status, cookie, csrf, auth: (mut = false) => ({ cookie, ...(mut ? { "x-adpix-csrf": csrf, "content-type": "application/json" } : {}) }) };
}

describe("panel auth + RBAC (live)", () => {
  it("token works only until the first admin exists, then login is required", async () => {
    await withServer(async (base, token) => {
      expect((await fetch(`${base}/api/me`, { headers: H(token) })).status).toBe(200); // token mode
      await fetch(`${base}/api/setup`, { method: "POST", headers: J(H(token)), body: JSON.stringify({ username: "ali", password: "pw" }) });
      expect((await fetch(`${base}/api/me`, { headers: H(token) })).status).toBe(401); // token now disabled
    });
  });

  it("owner can log in with password + TOTP and is owner", async () => {
    await withServer(async (base, token) => {
      const s = await setupAndLogin(base, token, "ali", "pw");
      expect(s.status).toBe(200);
      const me = await (await fetch(`${base}/api/me`, { headers: { cookie: s.cookie } })).json();
      expect(me.actor.role).toBe("owner");
      expect(me.mode).toBe("session");
    });
  });

  it("rejects login with a bad TOTP", async () => {
    await withServer(async (base, token) => {
      await fetch(`${base}/api/setup`, { method: "POST", headers: J(H(token)), body: JSON.stringify({ username: "ali", password: "pw" }) });
      const r = await fetch(`${base}/api/login`, { method: "POST", headers: J(), body: JSON.stringify({ username: "ali", password: "pw", totp: "000000" }) });
      expect(r.status).toBe(401);
    });
  });

  it("a viewer is denied a mutating job (server-side RBAC)", async () => {
    await withServer(async (base, token) => {
      const owner = await setupAndLogin(base, token, "ali", "pw");
      // owner creates a viewer
      const made = await (await fetch(`${base}/api/admin/users`, { method: "POST", headers: owner.auth(true), body: JSON.stringify({ username: "vic", password: "pw", role: "viewer" }) })).json();
      const viewer = await login(base, "vic", "pw", made.totpSecret);
      const r = await fetch(`${base}/api/jobs`, { method: "POST", headers: viewer.auth(true), body: JSON.stringify({ tool: "adpix_update", args: {} }) });
      expect(r.status).toBe(403);
      // and a read-only tool is allowed
      const ro = await fetch(`${base}/api/tools/health_check`, { method: "POST", headers: viewer.auth(true), body: JSON.stringify({ args: {} }) });
      expect(ro.status).toBe(200);
    });
  });

  it("audit log records actions in a verifiable chain (owner-only)", async () => {
    await withServer(async (base, token) => {
      const owner = await setupAndLogin(base, token, "ali", "pw");
      await fetch(`${base}/api/tools/health_check`, { method: "POST", headers: owner.auth(true), body: JSON.stringify({ args: {} }) });
      const a = await (await fetch(`${base}/api/admin/audit`, { headers: { cookie: owner.cookie } })).json();
      expect(a.chain.ok).toBe(true);
      expect(a.entries.some((e: { tool: string }) => e.tool === "panel.login")).toBe(true);
      expect(a.entries.some((e: { tool: string }) => e.tool === "health_check")).toBe(true);
    });
  });

  it("kill-switch engages and revokes all sessions", async () => {
    await withServer(async (base, token) => {
      const owner = await setupAndLogin(base, token, "ali", "pw");
      const k = await fetch(`${base}/api/admin/kill`, { method: "POST", headers: owner.auth(true), body: JSON.stringify({ on: true }) });
      expect((await k.json()).killed).toBe(true);
      // revokeAll fired → the owner's cookie is now dead
      expect((await fetch(`${base}/api/admin/audit`, { headers: { cookie: owner.cookie } })).status).toBe(401);
    });
  });
});
