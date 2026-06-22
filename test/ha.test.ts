import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { vrrpAuthPass, renderKeepalivedConf, renderSentinelConf, keepalivedSetup, sentinelSetup } from "../src/remote/ha.js";
import { saveRegistry, loadRegistry, resolveServer } from "../src/registry.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import { allTools } from "../src/tools/index.js";

const tool = (name: string) => {
  const t = allTools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};

// ---------------------------------------------------------------- pure renderers
describe("HA templates", () => {
  it("vrrpAuthPass is deterministic per cluster+vip", () => {
    expect(vrrpAuthPass("prod", "10.0.0.9")).toBe(vrrpAuthPass("prod", "10.0.0.9"));
    expect(vrrpAuthPass("prod", "10.0.0.9")).not.toBe(vrrpAuthPass("prod", "10.0.0.8"));
    expect(vrrpAuthPass("prod", "10.0.0.9")).toHaveLength(16);
  });

  it("keepalived MASTER vs BACKUP differ correctly", () => {
    const m = renderKeepalivedConf({ role: "MASTER", vip: "10.0.0.9", iface: "eth0", vrid: 51, priority: 150, authPass: "x", selfIp: "10.0.0.2", peerIp: "10.0.0.3" });
    const b = renderKeepalivedConf({ role: "BACKUP", vip: "10.0.0.9", iface: "eth0", vrid: 51, priority: 100, authPass: "x", selfIp: "10.0.0.3", peerIp: "10.0.0.2" });
    expect(m).toMatch(/state MASTER/);
    expect(m).toMatch(/priority 150/);
    expect(m).toMatch(/unicast_src_ip 10\.0\.0\.2/);
    expect(m).toMatch(/10\.0\.0\.9/); // VIP
    expect(m).toMatch(/chk_frontdoor/);
    expect(m).not.toMatch(/nopreempt/); // master preempts
    expect(b).toMatch(/state BACKUP/);
    expect(b).toMatch(/nopreempt/); // backup doesn't steal back
  });

  it("sentinel conf monitors the primary with the quorum", () => {
    const c = renderSentinelConf({ name: "adpix", primaryIp: "10.0.0.2", port: 6379, quorum: 2 });
    expect(c).toMatch(/sentinel monitor adpix 10\.0\.0\.2 6379 2/);
    expect(c).toMatch(/down-after-milliseconds adpix 5000/);
  });

  it("setup scripts install + restart the right services", () => {
    expect(keepalivedSetup()).toMatch(/apt-get install -y -qq keepalived/);
    expect(keepalivedSetup()).toMatch(/systemctl restart keepalived/);
    expect(sentinelSetup()).toMatch(/redis-sentinel/);
    expect(sentinelSetup()).toMatch(/chown redis:redis/);
  });
});

// ---------------------------------------------------------------- ha_standup tool
let tmp: string;
const SAVED = process.env.ADPIX_DEVOPS_HOME;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-ha-test-")); process.env.ADPIX_DEVOPS_HOME = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

function cluster3() {
  saveRegistry({
    version: 1,
    servers: {
      w1: { host: "10.0.0.1", port: 22, username: "root", adpixDir: "/opt/adpix" },
      "node-a": { host: "10.0.0.2", port: 22, username: "root", adpixDir: "/opt/adpix" },
      "node-b": { host: "10.0.0.3", port: 22, username: "root", adpixDir: "/opt/adpix" },
    },
  });
  const reg = loadRegistry();
  reg.clusters = { prod: { witness: "w1", nodes: ["node-a", "node-b"], hosts: [], idpIssuer: "https://account.adpix.io", vip: "10.0.0.9" } };
  saveRegistry(reg);
}

function haDeps(responses: [RegExp, Partial<ExecResult>][]) {
  const calls: { name: string; cmd: string }[] = [];
  const deps: Deps = {
    resolve: resolveServer,
    connect: async (srv) => {
      const name = (srv as { name: string }).name;
      const s: Session = {
        server: srv as never, authMethod: "publickey", close: () => {},
        exec: async (cmd) => { calls.push({ name, cmd }); for (const [re, r] of responses) if (re.test(cmd)) return { code: 0, stdout: "", stderr: "", ...r }; return { code: 0, stdout: "", stderr: "" }; },
      };
      return s;
    },
    local: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  return { deps, calls };
}

describe("ha_standup", () => {
  it("plan lays out the full standup (read-only)", async () => {
    cluster3();
    const { deps } = haDeps([]);
    const out = await tool("ha_standup").handler(deps, { cluster: "prod", mode: "plan", iface: "eth0", vrid: 51, confirm: false });
    expect(out).toMatch(/keepalived/);
    expect(out).toMatch(/Sentinel/);
    expect(out).toMatch(/pg_replication/);
    expect(out).toMatch(/keeper-config/);
    expect(out).toContain("10.0.0.9"); // VIP
  });

  it("keepalived refuses without confirm", async () => {
    cluster3();
    const { deps, calls } = haDeps([]);
    const out = await tool("ha_standup").handler(deps, { cluster: "prod", mode: "keepalived", iface: "eth0", vrid: 51, confirm: false });
    expect(out).toContain("REFUSED");
    expect(calls).toHaveLength(0);
  });

  it("keepalived installs MASTER on node-a + BACKUP on node-b with the VIP held", async () => {
    cluster3();
    const { deps, calls } = haDeps([
      [/base64 -d/, { code: 0 }],
      [/systemctl is-active keepalived/, { code: 0, stdout: "active" }],
      [/ip -4 addr show/, { code: 0, stdout: "HAS_VIP" }],
    ]);
    const out = await tool("ha_standup").handler(deps, { cluster: "prod", mode: "keepalived", iface: "eth0", vrid: 51, confirm: true });
    expect(out).toMatch(/node-a \(MASTER\): keepalived active/);
    expect(out).toMatch(/VIP held/);
    expect(out).toMatch(/node-b \(BACKUP\): keepalived active/);
    // both nodes got a conf written (base64) + the setup ran
    expect(calls.filter((c) => /base64 -d/.test(c.cmd)).length).toBe(2);
    expect(calls.some((c) => c.name === "node-a" && /keepalived/.test(c.cmd))).toBe(true);
  });

  it("sentinel installs on all 3 members (witness = 3rd vote)", async () => {
    cluster3();
    const { deps, calls } = haDeps([
      [/base64 -d/, { code: 0 }],
      [/redis-sentinel|ping/, { code: 0, stdout: "PONG" }],
    ]);
    const out = await tool("ha_standup").handler(deps, { cluster: "prod", mode: "sentinel", iface: "eth0", vrid: 51, confirm: true });
    expect(out).toMatch(/quorum 2\/3/);
    for (const m of ["w1", "node-a", "node-b"]) expect(calls.some((c) => c.name === m && /base64 -d/.test(c.cmd))).toBe(true);
  });

  it("errors clearly when the cluster has fewer than 2 nodes", async () => {
    saveRegistry({ version: 1, servers: {}, clusters: { solo: { witness: "w", nodes: [], hosts: [], idpIssuer: "x" } } });
    const { deps } = haDeps([]);
    const out = await tool("ha_standup").handler(deps, { cluster: "solo", mode: "keepalived", iface: "eth0", vrid: 51, confirm: true });
    expect(out).toMatch(/needs 2 serving nodes/);
  });
});
