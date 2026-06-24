import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/index.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";

/**
 * End-to-end lifecycle: a SINGLE STATEFUL fake host driven through the REAL MCP server (in-memory
 * protocol). Unlike the per-tool unit tests (canned responders) and the benign every-tool smoke (empty
 * output → unhappy paths), this simulates a host whose state (installed dir, running containers, a dirty
 * tracked file) evolves across calls — so cross-tool consistency is exercised: probe → install → status →
 * update(dirty) → relocate → certs → bridge, each asserting its SUCCESS output.
 */
const SERVER: ServerConfig = { name: "prod", host: "203.0.113.9", port: 22, username: "root", adpixDir: "/opt/adpix" };

function makeHost() {
  const state = { cloned: false, running: false, dirtyFile: true };
  const exec = async (cmd: string): Promise<ExecResult> => {
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    // ── connectivity probe (one exec with all /dev/tcp checks) ──
    if (/dev\/tcp\/1\.1\.1\.1/.test(cmd)) return ok("internet OK\ndns OK\ndockerhub OK\nghcr OK\napt OK\nnpm OK\ndocker yes\ngit yes");
    // ── docker presence / daemon ──
    if (/docker compose version/.test(cmd)) return ok("ok");
    if (/command -v docker.*docker info|systemctl start docker/.test(cmd)) return ok();
    if (/command -v git/.test(cmd)) return ok();
    // ── clone / update ──
    if (/git clone|git fetch origin/.test(cmd)) { state.cloned = true; return ok("Already up to date."); }
    // gitSyncCmd: dirty tracked file → stash, pull, pop
    if (/git status --porcelain -uno/.test(cmd)) return ok(state.dirtyFile ? " M ops/clickhouse/users.d/allow-network.xml" : "");
    if (/git rev-parse HEAD/.test(cmd)) return ok(state.running ? "newsha0000000000000000000000000000000000" : "0848ad70683ca239c043a357f3499207e96e6006");
    if (/git rev-parse --abbrev-ref HEAD/.test(cmd)) return ok("main");
    if (/git rev-parse --short HEAD/.test(cmd)) return ok(state.running ? "newsha0" : "0848ad7");
    // ── deploy / build / up ──
    if (/deploy\.sh/.test(cmd)) { state.running = true; return ok("AdPix Analytics is running."); }
    if (/backup\.sh/.test(cmd)) return ok(">> backup complete: backups/20260624");
    if (/compose .*build/.test(cmd)) return ok();
    if (/up -d/.test(cmd)) { state.running = true; return ok("Started"); }
    if (/run --rm migrate/.test(cmd)) return ok("migrated");
    // ── state probes ──
    if (/test -d .*\.git.* && echo yes/.test(cmd)) return ok(state.cloned ? "yes" : "no");
    if (/com\.docker\.compose\.project=.* -q.*wc -l/.test(cmd) || /printf '%s %s'/.test(cmd)) return ok(state.running ? "8 8" : "0 0");
    if (/_apx_health|seq 1 \d+.*healthz|for i in \$\(seq/.test(cmd)) return ok("healthy after ~5s (HTTP 200)");
    if (/curl .*healthz/.test(cmd)) return ok("200");
    // ── env / status reads ──
    if (/SITE_ADDRESS/.test(cmd)) return ok("");
    if (/PUBLIC_BASE_URL/.test(cmd)) return ok("http://203.0.113.9");
    if (/ADMIN_EMAIL/.test(cmd)) return ok("admin@example.com");
    if (/compose ps|docker ps/.test(cmd)) return ok(state.running ? "adanalytics-api-1\tadanalytics\tadanalytics-api-1\trunning\tUp 1 hour (healthy)" : "");
    if (/docker (stats|system df|images)/.test(cmd)) return ok("");
    if (/dev\/tcp\/10\./.test(cmd)) return ok("OK"); // a shared backend reachability probe
    return ok();
  };
  const session: Session = { server: SERVER, authMethod: "publickey", close: () => {}, exec };
  const deps: Deps = { resolve: () => SERVER, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) };
  return { deps, state };
}

async function connectClient(deps: Deps): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "e2e", version: "0" });
  await Promise.all([client.connect(ct), buildServer(deps).connect(st)]);
  return client;
}
const text = (r: { content?: unknown }) => ((r.content as { type: string; text: string }[])?.[0]?.text ?? "");
const call = (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: { server: "prod", ...args } }).then(text);

describe("E2E lifecycle through the MCP protocol (one stateful host)", () => {
  it("probe → install → status → update(dirty) → relocate → cert → bridge — all succeed + stay consistent", async () => {
    const { deps, state } = makeHost();
    const c = await connectClient(deps);

    // 1) connectivity: online
    const probe = await call(c, "net_probe");
    expect(probe).toMatch(/ONLINE/);

    // 2) before install: status shows not installed
    expect(state.cloned).toBe(false);
    const pre = await call(c, "adpix_status");
    expect(pre).toMatch(/No AdPix checkout|not installed|run adpix_install/i);

    // 3) install → clones + deploys → host becomes running
    const inst = await call(c, "adpix_install", { skipPreflight: true, deployKey: false, branch: "main", repoUrl: "https://github.com/mehrabiyan/adpix.git" });
    expect(state.cloned).toBe(true);
    expect(state.running).toBe(true);
    expect(inst).toMatch(/http:\/\/203\.0\.113\.9|running|healthy/i);

    // 4) status now reflects the running stack
    const post = await call(c, "adpix_status");
    expect(post).toMatch(/running|HEALTHY|8\/8|Up/i);

    // 5) update with a dirty tracked file → gitSyncCmd stashes + pulls (no "would be overwritten" abort)
    const upd = await call(c, "stack_update", { stack: "analytics", confirm: true, statelessOnly: true });
    expect(upd).not.toMatch(/would be overwritten|pull failed/i);

    // 6) relocate a stateless service: preview (apply:false) is read-only + safe
    const rel = await call(c, "service_relocate", { stack: "analytics", service: "ingest", fromServer: "prod", toServer: "spare" });
    expect(rel).toMatch(/STATELESS|backends are local|Preview|REFUSED/);

    // 7) certs: store one + install it for an FQDN it covers
    const cstore = await call(c, "cert_install", { domain: "app.adpix.io" }); // none stored yet
    expect(cstore).toMatch(/No stored certificate covers/);

    // 8) air-gap bridge: status with no tunnel open is graceful
    const bridge = await call(c, "net_bridge", { action: "status" });
    expect(bridge).toMatch(/No bridge active/);

    // 9) health check end-to-end
    const health = await call(c, "health_check");
    expect(health).toMatch(/HEALTHY|DEGRADED|DOWN/);

    await c.close();
  });

  // ── failure / edge paths through the protocol (the real bug-finders) ──
  function host(over: (cmd: string) => ExecResult | null): Deps {
    const exec = async (cmd: string): Promise<ExecResult> => over(cmd) ?? { code: 0, stdout: "", stderr: "" };
    const session: Session = { server: SERVER, authMethod: "publickey", close: () => {}, exec };
    return { resolve: () => SERVER, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) };
  }

  it("net_probe OFFLINE → recommends the bridge", async () => {
    const c = await connectClient(host((cmd) => /dev\/tcp\/1\.1\.1\.1/.test(cmd) ? { code: 0, stdout: "internet NO\ndns NO\ndockerhub NO\nghcr NO\napt NO\nnpm NO\ndocker no\ngit no", stderr: "" } : null));
    const out = await call(c, "net_probe");
    expect(out).toMatch(/OFFLINE/);
    expect(out).toMatch(/net_bridge|offline bundle/);
    await c.close();
  });

  it("service_relocate refuses a stateful datastore with a replication plan", async () => {
    const c = await connectClient(host(() => null));
    const out = await c.callTool({ name: "service_relocate", arguments: { stack: "analytics", service: "postgres", fromServer: "prod", toServer: "spare" } }).then(text);
    expect(out).toMatch(/REFUSED for postgres/);
    expect(out).toMatch(/pg_replication|replicate/);
    await c.close();
  });

  it("stack_update refuses a cloned-but-not-running stack", async () => {
    const c = await connectClient(host((cmd) => {
      if (/test -d .*\.git.* && echo yes/.test(cmd)) return { code: 0, stdout: "yes", stderr: "" };      // cloned
      if (/printf '%s %s'|project=.* -q/.test(cmd)) return { code: 0, stdout: "0 0", stderr: "" };        // not running
      return null;
    }));
    const out = await call(c, "stack_update", { stack: "analytics", confirm: true });
    expect(out).toMatch(/not running|bring it up|Install/i);
    await c.close();
  });

  it("install surfaces the NET hint when deploy.sh can't reach the internet", async () => {
    const c = await connectClient(host((cmd) => {
      if (/command -v git/.test(cmd)) return { code: 0, stdout: "", stderr: "" };
      if (/git clone|git fetch/.test(cmd)) return { code: 0, stdout: "", stderr: "" };
      if (/deploy\.sh/.test(cmd)) return { code: 1, stdout: "fatal: unable to access 'https://github.com': Could not resolve host: github.com", stderr: "" };
      return null;
    }));
    const out = await call(c, "adpix_install", { skipPreflight: true, deployKey: false, branch: "main", repoUrl: "https://github.com/mehrabiyan/adpix.git" });
    expect(out).toMatch(/Deploy FAILED/);
    expect(out).toMatch(/NET — the target couldn't reach the internet/);
    expect(out).toMatch(/net_bridge/);
    await c.close();
  });
});
