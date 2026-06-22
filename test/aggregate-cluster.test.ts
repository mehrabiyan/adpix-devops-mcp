import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildQuorumView } from "../src/panel/aggregate/cluster.js";
import { saveRegistry, loadRegistry, resolveServer } from "../src/registry.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";

let tmp: string; const SAVED = process.env.ADPIX_DEVOPS_HOME;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-aggha-")); process.env.ADPIX_DEVOPS_HOME = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

type Probe = { pg?: string; redis?: string; sentinel?: string; ch?: string };
function cluster3() {
  saveRegistry({ version: 1, servers: { w1: { host: "10.0.0.4", port: 22, username: "root", adpixDir: "/opt/adpix" }, "node-a": { host: "10.0.0.11", port: 22, username: "root", adpixDir: "/opt/adpix" }, "node-b": { host: "10.0.0.12", port: 22, username: "root", adpixDir: "/opt/adpix" } } });
  const r = loadRegistry(); r.clusters = { prod: { witness: "w1", nodes: ["node-a", "node-b"], hosts: [], idpIssuer: "x", vip: "10.0.0.10" } }; saveRegistry(r);
}
function quorumDeps(per: Record<string, Probe | "THROW">): Deps {
  return {
    resolve: resolveServer,
    connect: async (srv) => {
      const n = (srv as { name: string }).name; const a = per[n];
      if (a === "THROW") throw new Error("unreachable");
      const p = (a as Probe) || {};
      return { server: srv as never, authMethod: "publickey", close: () => {}, exec: async (cmd): Promise<ExecResult> => {
        let out = "";
        if (/pg_is_in_recovery/.test(cmd)) out = p.pg ?? "?";
        else if (/info replication/.test(cmd)) out = p.redis ?? "";
        else if (/-p 26379/.test(cmd)) out = p.sentinel ?? "none";
        else if (/system\.replicas/.test(cmd)) out = p.ch ?? "?";
        return { code: 0, stdout: out, stderr: "" };
      } } as Session;
    },
    local: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
}

describe("buildQuorumView", () => {
  it("healthy: 1 primary + standby, master+replica, 3 sentinels", async () => {
    cluster3();
    const v = await buildQuorumView(quorumDeps({
      w1: { pg: "?", sentinel: "PONG", ch: "0\t2" },
      "node-a": { pg: "f", redis: "role:master  connected_slaves:1", sentinel: "PONG", ch: "0\t2" },
      "node-b": { pg: "t", redis: "role:slave  master_link_status:up", sentinel: "PONG", ch: "0\t2" },
    }), "prod");
    expect(v.error).toBeUndefined();
    expect(v.cluster).toBe("prod"); expect(v.vip).toBe("10.0.0.10");
    expect(v.members.length).toBe(3);
    const by = Object.fromEntries(v.members.map((m) => [m.name, m]));
    expect(by["node-a"].postgres).toBe("primary"); expect(by["node-b"].postgres).toBe("standby");
    expect(by["w1"].role).toBe("witness");
    expect(v.verdict).toBe("healthy"); expect(v.findings).toEqual([]);
  });
  it("split-brain: two primaries → neg verdict", async () => {
    cluster3();
    const v = await buildQuorumView(quorumDeps({ w1: { sentinel: "PONG" }, "node-a": { pg: "f", redis: "role:master", sentinel: "PONG" }, "node-b": { pg: "f", redis: "role:master", sentinel: "PONG" } }), "prod");
    expect(v.verdict).toBe("neg");
    expect(v.findings.some((f) => /SPLIT-BRAIN/.test(f))).toBe(true);
  });
  it("an unreachable member is flagged, row marked '?'", async () => {
    cluster3();
    const v = await buildQuorumView(quorumDeps({ w1: { sentinel: "PONG" }, "node-a": { pg: "f", redis: "role:master", sentinel: "PONG" }, "node-b": "THROW" }), "prod");
    expect(v.findings.some((f) => /node-b.*UNREACHABLE/.test(f))).toBe(true);
    expect(v.members.find((m) => m.name === "node-b")!.postgres).toBe("?");
  });
  it("no cluster → graceful error", async () => {
    const v = await buildQuorumView(quorumDeps({}), "nope");
    expect(v.error).toBeTruthy(); expect(v.members).toEqual([]);
  });
});
