import { describe, expect, it } from "vitest";
import type { Deps } from "../src/deps.js";
import type { ServerConfig } from "../src/registry.js";
import type { ExecResult, Session } from "../src/ssh.js";
import { allTools } from "../src/tools/index.js";

type Resp = [RegExp, Partial<ExecResult> | ((c: string) => Partial<ExecResult>)];
function pick(responses: Resp[], cmd: string): ExecResult {
  for (const [re, res] of responses) if (re.test(cmd)) return { code: 0, stdout: "", stderr: "", ...(typeof res === "function" ? res(cmd) : res) };
  return { code: 0, stdout: "", stderr: "" };
}
// A fake with MULTIPLE servers — service_relocate connects to both the source and the destination.
function multiDeps(servers: Record<string, Resp[]>) {
  const calls: Record<string, string[]> = {};
  const cfgs: Record<string, ServerConfig> = {};
  for (const name of Object.keys(servers)) { cfgs[name] = { name, host: `${name}.h`, port: 22, username: "root", adpixDir: "/opt/adpix" }; calls[name] = []; }
  const deps: Deps = {
    resolve: (n) => { const c = cfgs[n ?? ""]; if (!c) throw new Error(`no such server "${n}"`); return c; },
    connect: async (srv: ServerConfig): Promise<Session> => ({ server: srv, authMethod: "publickey", close: () => {}, exec: async (cmd: string) => { calls[srv.name].push(cmd); return pick(servers[srv.name], cmd); } }),
    local: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  return { deps, calls };
}
const tool = (name: string) => { const t = allTools.find((t) => t.name === name); if (!t) throw new Error(`tool ${name} not registered`); return t; };
const run = (deps: Deps, args: Record<string, unknown>) => tool("service_relocate").handler(deps, { stack: "analytics", apply: false, confirm: false, removeSource: false, drainSeconds: 20, timeoutSeconds: 1800, ...args });

// shared backends on a real, reachable DB host → a stateless service CAN move
const SHARED_ENV = "DATABASE_URL=postgres://u:p@10.0.9.9:5432/db\nREDIS_URL=redis://10.0.9.9:6379\n";
const srcRunning: Resp[] = [[/ps 'ingest'/, { stdout: "up" }], [/cat .*\/\.env/, { stdout: SHARED_ENV }], [/base64 < /, { stdout: "QkFTRTY0" }]];
const tgtReady = (envPresent: boolean, healthy = true): Resp[] => [
  [/command -v docker/, { stdout: "ok" }],
  [/test -d .*\.git/, { stdout: "yes" }],
  [/test -f .*\.env/, { stdout: envPresent ? "yes" : "no" }],
  [/df -m/, { stdout: "50000" }],
  [/dev\/tcp\/10\.0\.9\.9\//, { stdout: "OK" }],
  [/up -d --build --no-deps 'ingest'/, { code: 0 }],
  [/_apx_health/, healthy ? { code: 0, stdout: "healthy after ~5s (HTTP 200)" } : { code: 1, stdout: "NOT healthy after 150s" }],
  [/base64 -d > /, { code: 0 }],
];

describe("service_relocate", () => {
  it("is registered as a destructive tool", () => {
    expect(allTools.some((t) => t.name === "service_relocate")).toBe(true);
    expect(tool("service_relocate").annotations?.destructiveHint).toBe(true);
  });

  it("refuses a same-server move", async () => {
    const { deps } = multiDeps({ a: [] });
    expect(await run(deps, { service: "ingest", fromServer: "a", toServer: "a" })).toMatch(/REFUSED: fromServer and toServer are the same/);
  });

  it("rejects an unknown service with the stateless/stateful lists", async () => {
    const { deps } = multiDeps({ a: [], b: [] });
    const out = await run(deps, { service: "wat", fromServer: "a", toServer: "b" });
    expect(out).toMatch(/Unknown service "wat"/);
    expect(out).toMatch(/ingest/); // stateless list
  });

  // ── stateful: never moved, returns the replication plan ──
  it("REFUSES a Postgres move and returns a replicate→promote→fence plan", async () => {
    const { deps, calls } = multiDeps({ a: [], b: [] });
    const out = await run(deps, { service: "postgres", fromServer: "a", toServer: "b" });
    expect(out).toMatch(/REFUSED for postgres/);
    expect(out).toMatch(/pg_replication/);
    expect(out).toMatch(/promote/);
    expect(calls.a).toHaveLength(0); // never even connects — pure planning
  });

  it("REFUSES moving the IdP auth (embedded PGlite) and explains the volume copy", async () => {
    const { deps } = multiDeps({ a: [], b: [] });
    const out = await run(deps, { stack: "idp", service: "auth", fromServer: "a", toServer: "b" });
    expect(out).toMatch(/REFUSED for auth/);
    expect(out).toMatch(/PGlite|authdata/);
  });

  // ── the data-locality guard ──
  it("refuses to live-move a stateless service whose backends are docker-internal to the source", async () => {
    const { deps } = multiDeps({
      a: [[/ps 'ingest'/, { stdout: "Up" }], [/cat .*\/\.env/, { stdout: "DATABASE_URL=postgres://u:p@postgres:5432/db\nREDIS_URL=redis://redis:6379\n" }]],
      b: tgtReady(true),
    });
    const out = await run(deps, { service: "ingest", fromServer: "a", toServer: "b" });
    expect(out).toMatch(/backends are local to a/);
    expect(out).toMatch(/DATABASE_URL → postgres:5432/);
    expect(out).toMatch(/Relocate the WHOLE stack|managed\/networked DB/);
  });

  // ── preview (read-only) ──
  it("apply:false returns a preview with the plan + downtime estimate (no mutations)", async () => {
    const { deps, calls } = multiDeps({ a: srcRunning, b: tgtReady(true) });
    const out = await run(deps, { service: "ingest", fromServer: "a", toServer: "b" });
    expect(out).toMatch(/STATELESS → live blue-green relocate/);
    expect(out).toMatch(/Estimated downtime: ~0s/);
    expect(out).toMatch(/Preview only/);
    expect(calls.b.some((c) => /up -d/.test(c))).toBe(false);    // nothing started
    expect(calls.a.some((c) => /stop 'ingest'/.test(c))).toBe(false); // source untouched
  });

  it("apply:true without confirm is refused", async () => {
    const { deps } = multiDeps({ a: srcRunning, b: tgtReady(true) });
    expect(await run(deps, { service: "ingest", fromServer: "a", toServer: "b", apply: true })).toMatch(/needs confirm:true/);
  });

  // ── happy path: target up + healthy BEFORE the source is drained ──
  it("apply+confirm: brings up the target, health-gates, drains + stops the source (kept for rollback)", async () => {
    const { deps, calls } = multiDeps({ a: srcRunning, b: tgtReady(true) });
    const out = await run(deps, { service: "ingest", fromServer: "a", toServer: "b", apply: true, confirm: true, drainSeconds: 0 });
    // sequence: target up -> health -> source stop
    expect(calls.b.some((c) => /up -d --build --no-deps 'ingest'/.test(c))).toBe(true);
    expect(calls.a.some((c) => /stop 'ingest'/.test(c))).toBe(true);
    expect(calls.a.some((c) => /rm -sf 'ingest'/.test(c))).toBe(false); // not fenced (removeSource:false)
    expect(out).toMatch(/✅ Relocated ingest: a → b/);
    expect(out).toMatch(/STOPPED \(not removed\)/);
  });

  it("removeSource:true fences the source after verification", async () => {
    const { deps, calls } = multiDeps({ a: srcRunning, b: tgtReady(true) });
    await run(deps, { service: "ingest", fromServer: "a", toServer: "b", apply: true, confirm: true, removeSource: true, drainSeconds: 0 });
    expect(calls.a.some((c) => /rm -sf 'ingest'/.test(c))).toBe(true);
  });

  it("copies the .env to the target when missing", async () => {
    const { deps, calls } = multiDeps({ a: srcRunning, b: tgtReady(false) });
    await run(deps, { service: "ingest", fromServer: "a", toServer: "b", apply: true, confirm: true, drainSeconds: 0 });
    expect(calls.a.some((c) => /base64 < /.test(c))).toBe(true);     // read source env
    expect(calls.b.some((c) => /base64 -d > .*\/\.env/.test(c))).toBe(true); // wrote target env
  });

  // ── failure: target never healthy → abort with the source untouched (zero downtime) ──
  it("aborts (source untouched) when the target never becomes healthy", async () => {
    const { deps, calls } = multiDeps({ a: srcRunning, b: tgtReady(true, false) });
    const out = await run(deps, { service: "ingest", fromServer: "a", toServer: "b", apply: true, confirm: true, drainSeconds: 0 });
    expect(out).toMatch(/did not become healthy/);
    expect(out).toMatch(/still serving \(zero downtime\)/);
    expect(calls.a.some((c) => /stop 'ingest'/.test(c))).toBe(false); // source NEVER stopped
    expect(calls.b.some((c) => /stop 'ingest'/.test(c))).toBe(true);  // target instance cleaned up
  });

  it("refuses when a shared backend is unreachable from the target", async () => {
    const tgt = tgtReady(true).map((r) => (/tcp/.test(r[0].source) ? [r[0], { stdout: "NO" }] as Resp : r));
    const { deps } = multiDeps({ a: srcRunning, b: tgt });
    const out = await run(deps, { service: "ingest", fromServer: "a", toServer: "b", apply: true, confirm: true });
    expect(out).toMatch(/cannot reach 10\.0\.9\.9/);
  });
});
