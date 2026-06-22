import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/index.js";
import { allTools } from "../src/tools/index.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";

/**
 * Integration tests that drive the REAL MCP server end to end: a SDK Client talks to
 * buildServer() over an in-memory transport, so we exercise tool registration, the
 * tools/list contract, JSON-Schema input validation, the call dispatch, and the
 * error-mapping wrapper — none of which the per-handler unit tests touch. The SSH/
 * registry/local seam is faked, so nothing hits a network.
 */

const SERVER: ServerConfig = { name: "prod", host: "10.0.0.1", port: 22, username: "root", adpixDir: "/opt/adpix" };

/** A permissive deps: connect succeeds, every exec/local returns benign empty output. */
function benignDeps(): Deps {
  const session: Session = { server: SERVER, authMethod: "publickey", close: () => {}, exec: async (): Promise<ExecResult> => ({ code: 0, stdout: "", stderr: "" }) };
  return { resolve: () => SERVER, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) };
}

/** A deps whose resolve() throws — to prove the server maps a handler throw to isError. */
function throwingDeps(): Deps {
  return { resolve: () => { throw new Error("no such server \"prod\""); }, connect: async () => { throw new Error("unreachable"); }, local: async () => ({ code: 0, stdout: "", stderr: "" }) };
}

async function connectClient(deps: Deps): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "integration-test", version: "0" });
  await Promise.all([client.connect(clientT), buildServer(deps).connect(serverT)]);
  return client;
}

const text = (res: { content?: unknown }) => ((res.content as { type: string; text: string }[])?.[0]?.text ?? "");

// ---------------------------------------------------------------- tools/list contract
describe("MCP tools/list contract", () => {
  it("advertises every registered tool with a well-formed object input schema", async () => {
    const client = await connectClient(benignDeps());
    const { tools } = await client.listTools();
    expect(tools.length).toBe(allTools.length);

    const advertised = new Set(tools.map((t) => t.name));
    for (const t of allTools) expect(advertised.has(t.name)).toBe(true);

    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z0-9_]+$/);
      expect(typeof t.description).toBe("string");
      expect((t.description ?? "").length).toBeGreaterThan(10);
      // every tool takes a JSON-Schema object (the SDK derived it from the Zod shape)
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("preserves read-only and destructive annotations through registration", async () => {
    const client = await connectClient(benignDeps());
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("pg_health")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("ch_restore_db")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("pg_restore_db")?.annotations?.destructiveHint).toBe(true);
  });

  it("exposes a healthy tool count (no accidental drop)", () => {
    expect(allTools.length).toBeGreaterThanOrEqual(68);
    expect(new Set(allTools.map((t) => t.name)).size).toBe(allTools.length);
  });
});

// ---------------------------------------------------------------- call dispatch + error mapping
describe("MCP tools/call dispatch", () => {
  it("runs a read-only tool through the protocol and returns text content", async () => {
    const client = await connectClient(benignDeps());
    const res = await client.callTool({ name: "launch_gate", arguments: { mode: "status" } });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/Launch gate/);
  });

  it("runs a pure (no-deps) tool — capacity_plan — through the protocol", async () => {
    const client = await connectClient(benignDeps());
    const res = await client.callTool({ name: "capacity_plan", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(text(res).length).toBeGreaterThan(50);
  });

  it("maps a handler throw to an isError result (not a transport crash)", async () => {
    const client = await connectClient(throwingDeps());
    const res = await client.callTool({ name: "pg_health", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("ERROR (pg_health)");
  });

  it("rejects calls with schema-invalid arguments (wrong types)", async () => {
    const client = await connectClient(benignDeps());
    let rejected = false;
    try {
      const res = await client.callTool({ name: "run_command", arguments: { command: 123, timeoutSeconds: "soon" } });
      rejected = res.isError === true;
    } catch {
      rejected = true; // SDK surfaces invalid params as a rejected request
    }
    expect(rejected).toBe(true);
  });

  it("rejects calls to an unknown tool", async () => {
    const client = await connectClient(benignDeps());
    let rejected = false;
    try {
      const res = await client.callTool({ name: "does_not_exist", arguments: {} });
      rejected = res.isError === true;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});

// ---------------------------------------------------------------- exhaustive every-tool smoke
/**
 * Minimal valid arguments for EVERY tool (safe values: confirm:false, apply:false, advisory
 * actions, dry-runs). Drives each handler through the real protocol dispatch with a benign
 * fake seam: proves the Zod→JSON-Schema accepts the args, the handler runs, and it returns
 * text content (or a mapped isError) — never a transport crash. Fixtures came from a parallel
 * per-group source audit; destructive/heavy paths are asserted in the per-handler unit tests.
 */
const FIXTURES: Record<string, Record<string, unknown>> = {
  server_add: { name: "prod", host: "203.0.113.7", verify: false },
  server_list: {},
  server_remove: { name: "ghost" },
  run_command: { command: "df -h /", confirm: false },
  adpix_install: { skipPreflight: true },
  adpix_update: {},
  adpix_status: {},
  adpix_restart: {},
  adpix_logs: { lines: 50 },
  adpix_backup: {},
  adpix_restore: { backupDir: "backups/x", confirm: false },
  health_check: {},
  system_metrics: {},
  performance_report: { runs: 1 },
  tls_status: {},
  security_audit: {},
  harden_server: { apply: false },
  patch_system: { confirm: false },
  watchdog_install: {},
  watchdog_status: {},
  uptime_report: {},
  cicd_enable: {},
  cicd_status: {},
  cicd_run_now: {},
  cicd_disable: {},
  ai_setup: {},
  ai_fix: { problem: "ingest is 502ing", mode: "diagnose" },
  mcp_self_update: {},
  capacity_plan: {},
  consult_topic: { topic: "roadmap" },
  scale_assessment: {},
  pg_health: {},
  pg_tune: { apply: false },
  pg_optimize: { apply: false },
  pg_harden: { apply: false },
  pg_backup: {},
  pg_restore_db: { dumpPath: "backups/pg-x/sovereign.dump", confirm: false },
  pg_replication: { mode: "status" },
  pg_redeploy: { action: "upgrade-plan" },
  ch_health: {},
  ch_tune: { apply: false },
  ch_optimize: { apply: false },
  ch_harden: {},
  ch_backup: {},
  ch_restore_db: { backupDir: "backups/ch-x", confirm: false },
  ch_replication: { mode: "status" },
  ch_retention: { mode: "status" },
  ch_redeploy: { action: "upgrade-plan" },
  cluster_define: { name: "prod" },
  cluster_list: {},
  cluster_status: {},
  bluegreen_deploy: { confirm: false },
  ha_quorum: { mode: "plan" },
  launch_gate: { mode: "status" },
  secrets_preflight: {},
  oidc_health: {},
  edge_validate: {},
  launch_smoke: {},
  predeploy_gate: { stack: "tagmanager" },
  tm_install: {},
  tm_status: {},
  tm_health: {},
  tm_logs: {},
  tm_restart: {},
  tm_update: {},
  pop_add: { coreRedisHost: "10.0.0.2", objectStore: "http://10.0.0.2:9000", s3AccessKey: "k", s3SecretKey: "s", purgeToken: "p" },
  obs_deploy: {},
  obs_status: {},
  dns_plan: {},
  ha_standup: {},
  connect_configs: {},
  mcp_status: {},
  stack_update: { stack: "analytics", confirm: false },
  container_control: { service: "api", action: "status", confirm: false },
  metrics_query: { query: "up" },
  schedule_job: { action: "list" },
  server_resize: {},
  data_move: {},
};

describe("MCP exhaustive every-tool smoke (protocol dispatch)", () => {
  let tmpHome: string;
  const savedHome = process.env.ADPIX_DEVOPS_HOME;
  beforeAll(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-int-smoke-"));
    process.env.ADPIX_DEVOPS_HOME = tmpHome; // isolate registry writes (server_add/cluster_define/launch_gate)
  });
  afterAll(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.ADPIX_DEVOPS_HOME;
    else process.env.ADPIX_DEVOPS_HOME = savedHome;
  });

  it("has a fixture for every registered tool", () => {
    const missing = allTools.map((t) => t.name).filter((n) => !(n in FIXTURES));
    expect(missing).toEqual([]);
  });

  it("dispatches every tool through the real server and returns content (no crash, no schema rejection)", async () => {
    const client = await connectClient(benignDeps());
    const failures: string[] = [];
    for (const t of allTools) {
      try {
        const res = await client.callTool({ name: t.name, arguments: FIXTURES[t.name] ?? {} });
        const body = text(res);
        if (!body || body.length === 0) failures.push(`${t.name}: empty content`);
      } catch (e) {
        // a throw here = the protocol rejected the call (bad schema / missing required arg)
        failures.push(`${t.name}: REJECTED — ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
