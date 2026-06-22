import { describe, expect, it } from "vitest";
import { allTools } from "../src/tools/index.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";

const SRV: ServerConfig = { name: "prod", host: "10.0.0.1", port: 22, username: "root", adpixDir: "/opt/adpix" };
const tool = (n: string) => { const t = allTools.find((t) => t.name === n); if (!t) throw new Error(n); return t; };

function deps(responses: [RegExp, Partial<ExecResult>][]) {
  const calls: string[] = [];
  const session: Session = {
    server: SRV, authMethod: "publickey", close: () => {},
    exec: async (cmd) => { calls.push(cmd); for (const [re, r] of responses) if (re.test(cmd)) return { code: 0, stdout: "", stderr: "", ...r }; return { code: 0, stdout: "", stderr: "" }; },
  };
  return { deps: { resolve: () => SRV, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) } as Deps, calls };
}

describe("container_control", () => {
  it("status reads compose ps (read path)", async () => {
    const { deps: d, calls } = deps([[/ps /, { stdout: "api running" }]]);
    const out = await tool("container_control").handler(d, { service: "api", action: "status", confirm: false });
    expect(out).toMatch(/api running/);
    expect(calls.some((c) => /ps 'api'/.test(c))).toBe(true);
  });
  it("stop without confirm is refused (verify-before-destroy)", async () => {
    const { deps: d, calls } = deps([]);
    const out = await tool("container_control").handler(d, { service: "api", action: "stop", confirm: false });
    expect(out).toMatch(/REFUSED/);
    expect(calls).toHaveLength(0);
  });
  it("stop with confirm runs + warns it is now stopped", async () => {
    const { deps: d, calls } = deps([[/stop /, { stdout: "Stopped" }]]);
    const out = await tool("container_control").handler(d, { service: "api", action: "stop", confirm: true });
    expect(calls.some((c) => /stop 'api'/.test(c))).toBe(true);
    expect(out).toMatch(/STOPPED/);
  });
  it("restart re-checks health", async () => {
    const { deps: d, calls } = deps([[/restart /, { stdout: "Restarted" }], [/wait|curl|healthy/i, { stdout: "ok" }]]);
    const out = await tool("container_control").handler(d, { service: "api", action: "restart", confirm: true });
    expect(out).toMatch(/Health:/);
    expect(calls.some((c) => /restart 'api'/.test(c))).toBe(true);
  });
});

describe("metrics_query", () => {
  it("curls the Prometheus instant API (read-only)", async () => {
    const { deps: d, calls } = deps([[/api\/v1\/query/, { stdout: '{"status":"success","data":{"result":[]}}' }]]);
    const out = await tool("metrics_query").handler(d, { query: "up", port: 9090 });
    expect(out).toMatch(/success/);
    expect(calls.some((c) => /9090\/api\/v1\/query/.test(c))).toBe(true);
  });
});

describe("schedule_job", () => {
  it("list reads systemd timers", async () => {
    const { deps: d } = deps([[/list-timers/, { stdout: "adpix-nightly-backup.timer" }]]);
    const out = await tool("schedule_job").handler(d, { action: "list", schedule: "daily", confirm: false });
    expect(out).toMatch(/nightly-backup/);
  });
  it("add without confirm refused", async () => {
    const { deps: d, calls } = deps([]);
    const out = await tool("schedule_job").handler(d, { action: "add", name: "nb", task: "backup", schedule: "daily", confirm: false });
    expect(out).toMatch(/REFUSED/);
    expect(calls).toHaveLength(0);
  });
  it("add writes a .timer + .service unit and enables it", async () => {
    const { deps: d, calls } = deps([[/base64 -d/, { code: 0 }], [/enable --now/, { stdout: "enabled" }]]);
    const out = await tool("schedule_job").handler(d, { action: "add", name: "nb", task: "backup", schedule: "daily", confirm: true });
    expect(out).toMatch(/Scheduled backup/);
    expect(calls.filter((c) => /base64 -d/.test(c)).length).toBe(2); // .service + .timer uploaded
    expect(calls.some((c) => /enable --now 'adpix-nb.timer'/.test(c))).toBe(true);
  });
});

describe("advisory plans", () => {
  it("server_resize inspects + outputs a safe sequence", async () => {
    const { deps: d } = deps([[/nproc/, { stdout: "cpu=4\nmem=16GB\ndisk=80GB used=30GB" }]]);
    const out = await tool("server_resize").handler(d, { memoryGb: 32 });
    expect(out).toMatch(/resize plan/i);
    expect(out).toMatch(/snapshot|backup/i);
    expect(out).toMatch(/mem=32GB/);
  });
  it("data_move outputs a backup-first migration plan", async () => {
    const { deps: d } = deps([[/docker system df|du -sh/, { stdout: "clickhouse 2.4GB" }]]);
    const out = await tool("data_move").handler(d, { to: "node-b", dataset: "clickhouse" });
    expect(out).toMatch(/migration plan/i);
    expect(out).toMatch(/ch_backup/);
    expect(out).toMatch(/advisory/i);
  });
});
