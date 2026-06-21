import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { saveRegistry, loadRegistry, resolveCluster, resolveServer } from "../src/registry.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import { allTools } from "../src/tools/index.js";

const tool = (name: string) => {
  const t = allTools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};

let tmp: string;
const SAVED: Record<string, string | undefined> = {};
beforeEach(() => {
  SAVED.ADPIX_DEVOPS_HOME = process.env.ADPIX_DEVOPS_HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-cluster-test-"));
  process.env.ADPIX_DEVOPS_HOME = tmp;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (SAVED.ADPIX_DEVOPS_HOME === undefined) delete process.env.ADPIX_DEVOPS_HOME;
  else process.env.ADPIX_DEVOPS_HOME = SAVED.ADPIX_DEVOPS_HOME;
});

/** Deps whose connect() returns a per-server session keyed on the server name. */
function clusterDeps(outputs: Record<string, string>, local: ExecResult = { code: 0, stdout: "200", stderr: "" }) {
  const deps: Deps = {
    resolve: resolveServer,
    connect: async (srv) => {
      const session: Session = {
        server: srv as never,
        authMethod: "publickey",
        close: () => {},
        exec: async () => ({ code: 0, stdout: outputs[srv.name] ?? "", stderr: "" }),
      };
      return session;
    },
    local: async () => local,
  };
  return deps;
}

const probe = (os: string, services: string, checkouts: string) =>
  `${os}\n---SVC---\n${services} \n---CO---\n${checkouts} \n`;

describe("cluster topology", () => {
  it("cluster_define saves roles + the default 8 hosts; cluster_list shows them", async () => {
    saveRegistry({ version: 1, servers: { w1: { host: "10.0.0.1", port: 22, username: "root", adpixDir: "/opt/adpix" }, n1: { host: "10.0.0.2", port: 22, username: "root", adpixDir: "/opt/adpix" } } });
    const deps = clusterDeps({});
    const out = await tool("cluster_define").handler(deps, { name: "prod", witness: "w1", nodes: ["n1"], vip: "10.0.0.9", idpIssuer: "https://account.adpix.io" });
    expect(out).toContain('Cluster "prod" saved');
    expect(out).toContain("hosts:   8");
    const cl = resolveCluster("prod");
    expect(cl.witness).toBe("w1");
    expect(cl.hosts).toHaveLength(8);
    const list = await tool("cluster_list").handler(deps, {});
    expect(list).toMatch(/prod: witness=w1 nodes=\[n1\]/);
  });

  it("cluster_define warns about members not yet registered", async () => {
    saveRegistry({ version: 1, servers: {} });
    const deps = clusterDeps({});
    const out = await tool("cluster_define").handler(deps, { name: "prod", witness: "w1", nodes: ["n1", "n2"], idpIssuer: "https://account.adpix.io" });
    expect(out).toMatch(/Not yet registered.*w1.*n1.*n2/);
  });

  it("cluster_status rolls up members and is HEALTHY when roles match", async () => {
    saveRegistry({ version: 1, servers: { w1: { host: "10.0.0.1", port: 22, username: "root", adpixDir: "/opt/adpix" }, n1: { host: "10.0.0.2", port: 22, username: "root", adpixDir: "/opt/adpix" } } });
    const reg = loadRegistry();
    reg.clusters = { prod: { witness: "w1", nodes: ["n1"], hosts: [], idpIssuer: "https://account.adpix.io" } };
    saveRegistry(reg);
    const deps = clusterDeps({
      w1: probe("Linux 6.2", "prometheus grafana alertmanager", "adpix-devops-mcp"),
      n1: probe("Linux 6.2", "caddy ingest web worker", "adpix"),
    });
    const out = await tool("cluster_status").handler(deps, { cluster: "prod" });
    expect(out).toContain("HEALTHY");
    expect(out).toContain("witness");
    expect(out).toContain("node");
  });

  it("cluster_status flags the witness running serving containers", async () => {
    saveRegistry({ version: 1, servers: { w1: { host: "10.0.0.1", port: 22, username: "root", adpixDir: "/opt/adpix" }, n1: { host: "10.0.0.2", port: 22, username: "root", adpixDir: "/opt/adpix" } } });
    const reg = loadRegistry();
    reg.clusters = { prod: { witness: "w1", nodes: ["n1"], hosts: [], idpIssuer: "https://account.adpix.io" } };
    saveRegistry(reg);
    const deps = clusterDeps({
      w1: probe("Linux 6.2", "caddy ingest", "adpix"), // witness shouldn't serve
      n1: probe("Linux 6.2", "caddy ingest web", "adpix"),
    });
    const out = await tool("cluster_status").handler(deps, { cluster: "prod" });
    expect(out).toContain("NEEDS ATTENTION");
    expect(out).toMatch(/witness.*should not serve/);
  });

  it("cluster_status errors helpfully when no cluster is defined", async () => {
    saveRegistry({ version: 1, servers: {} });
    const deps = clusterDeps({});
    expect(await tool("cluster_status").handler(deps, {})).toMatch(/No clusters defined/);
  });
});

type Resp = [RegExp, Partial<ExecResult> | ((c: string) => Partial<ExecResult>)];
/** Deps for bluegreen: per-node sessions sharing one set of regex responders. */
function rollDeps(responses: Resp[]) {
  const calls: string[] = [];
  const deps: Deps = {
    resolve: resolveServer,
    connect: async (srv) => ({
      server: srv as never,
      authMethod: "publickey",
      close: () => {},
      exec: async (cmd: string) => {
        calls.push(cmd);
        for (const [re, res] of responses) if (re.test(cmd)) return { code: 0, stdout: "", stderr: "", ...(typeof res === "function" ? res(cmd) : res) };
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
    local: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  return { deps, calls };
}

function twoNodeCluster() {
  saveRegistry({ version: 1, servers: { n1: { host: "10.0.0.2", port: 22, username: "root", adpixDir: "/opt/adpix" }, n2: { host: "10.0.0.3", port: 22, username: "root", adpixDir: "/opt/adpix" } } });
  const reg = loadRegistry();
  reg.clusters = { prod: { witness: "w1", nodes: ["n1", "n2"], hosts: [], idpIssuer: "https://account.adpix.io" } };
  saveRegistry(reg);
}

describe("bluegreen_deploy", () => {
  it("refuses without confirm", async () => {
    twoNodeCluster();
    const { deps, calls } = rollDeps([]);
    const out = await tool("bluegreen_deploy").handler(deps, { cluster: "prod", stack: "adpix", tmDir: "/opt/adpix-tagmanager", confirm: false, timeoutSeconds: 2400 });
    expect(out).toContain("REFUSED");
    expect(calls).toHaveLength(0);
  });

  it("rolls every node when each gate passes", async () => {
    twoNodeCluster();
    const { deps } = rollDeps([
      [/test -d .*\.git.* && echo yes/, { stdout: "yes" }],
      [/rev-parse --abbrev-ref HEAD/, { stdout: "main" }],
      [/git fetch origin .* && git checkout/, { code: 0 }],
      [/scripts\/deploy\.sh/, { code: 0 }],
      [/for i in \$\(seq 1 \d+\); do code=/, { code: 0, stdout: "healthy after ~5s" }],
    ]);
    const out = await tool("bluegreen_deploy").handler(deps, { cluster: "prod", stack: "adpix", tmDir: "/opt/adpix-tagmanager", confirm: true, timeoutSeconds: 2400 });
    expect(out).toContain("All nodes rolled");
    expect(out).not.toContain("SKIPPED");
  });

  it("stops the roll and skips the rest when a node fails its gate", async () => {
    twoNodeCluster();
    const { deps } = rollDeps([
      [/test -d .*\.git.* && echo yes/, { stdout: "yes" }],
      [/rev-parse --abbrev-ref HEAD/, { stdout: "main" }],
      [/git fetch origin .* && git checkout/, { code: 0 }],
      [/scripts\/deploy\.sh/, { code: 0 }],
      [/for i in \$\(seq 1 \d+\); do code=/, { code: 1, stdout: "NOT healthy after 150s" }],
    ]);
    const out = await tool("bluegreen_deploy").handler(deps, { cluster: "prod", stack: "adpix", tmDir: "/opt/adpix-tagmanager", confirm: true, timeoutSeconds: 2400 });
    expect(out).toMatch(/n1 — FAILED/);
    expect(out).toMatch(/n2 — SKIPPED/);
    expect(out).toContain("Roll STOPPED");
  });
});

function threeMemberCluster() {
  saveRegistry({
    version: 1,
    servers: {
      w1: { host: "10.0.0.1", port: 22, username: "root", adpixDir: "/opt/adpix" },
      n1: { host: "10.0.0.2", port: 22, username: "root", adpixDir: "/opt/adpix" },
      n2: { host: "10.0.0.3", port: 22, username: "root", adpixDir: "/opt/adpix" },
    },
  });
  const reg = loadRegistry();
  reg.clusters = { prod: { witness: "w1", nodes: ["n1", "n2"], hosts: [], idpIssuer: "https://account.adpix.io" } };
  saveRegistry(reg);
}

/** Deps for ha_quorum status: per-member datastore probe answers keyed by server name. */
function haDeps(map: Record<string, { pg: string; redis: string; sentinel: string; ch: string }>) {
  const deps: Deps = {
    resolve: resolveServer,
    connect: async (srv) => ({
      server: srv as never, authMethod: "publickey", close: () => {},
      exec: async (cmd: string) => {
        const m = map[srv.name] ?? { pg: "?", redis: "?", sentinel: "none", ch: "?" };
        if (/pg_is_in_recovery/.test(cmd)) return { code: 0, stdout: m.pg, stderr: "" };
        if (/redis-cli info replication/.test(cmd)) return { code: 0, stdout: m.redis, stderr: "" };
        if (/-p 26379 ping/.test(cmd)) return { code: 0, stdout: m.sentinel, stderr: "" };
        if (/system\.replicas/.test(cmd)) return { code: 0, stdout: m.ch, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
    local: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  return deps;
}

describe("ha_quorum", () => {
  it("plan prints the witness-anchored standup playbook", async () => {
    threeMemberCluster();
    const out = await tool("ha_quorum").handler(haDeps({}), { cluster: "prod", mode: "plan" });
    expect(out).toMatch(/witness/);
    expect(out).toMatch(/Patroni|repmgr/);
    expect(out).toMatch(/Sentinel/);
    expect(out).toMatch(/Keeper/);
  });

  it("keeper-config generates a 3-node raft XML with member hosts", async () => {
    threeMemberCluster();
    const out = await tool("ha_quorum").handler(haDeps({}), { cluster: "prod", mode: "keeper-config" });
    expect(out).toContain("keeper_server");
    expect(out).toContain("10.0.0.1");
    expect(out).toContain("10.0.0.3");
  });

  it("status is HEALTHY with one primary, a redis master + replica, and 3 sentinels", async () => {
    threeMemberCluster();
    const out = await tool("ha_quorum").handler(haDeps({
      w1: { pg: "?", redis: "?", sentinel: "PONG", ch: "?" },
      n1: { pg: "f", redis: "role:master connected_slaves:1", sentinel: "PONG", ch: "0\t5" },
      n2: { pg: "t", redis: "role:slave master_link_status:up", sentinel: "PONG", ch: "0\t5" },
    }), { cluster: "prod", mode: "status" });
    expect(out).toContain("HEALTHY");
  });

  it("status flags split-brain when two primaries are seen", async () => {
    threeMemberCluster();
    const out = await tool("ha_quorum").handler(haDeps({
      w1: { pg: "?", redis: "?", sentinel: "PONG", ch: "?" },
      n1: { pg: "f", redis: "role:master", sentinel: "PONG", ch: "0\t5" },
      n2: { pg: "f", redis: "role:master", sentinel: "PONG", ch: "0\t5" },
    }), { cluster: "prod", mode: "status" });
    expect(out).toContain("NEEDS ATTENTION");
    expect(out).toMatch(/SPLIT-BRAIN/);
  });
});
