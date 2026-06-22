import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildFleet, verifyServer, parseTuneRows, listClusters } from "../src/panel/fleet.js";
import { saveRegistry, loadRegistry, resolveServer } from "../src/registry.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";

let tmp: string; const SAVED = process.env.ADPIX_DEVOPS_HOME;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-flr-")); process.env.ADPIX_DEVOPS_HOME = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

function deps(map: Record<string, string | "THROW">): Deps {
  return {
    resolve: resolveServer,
    connect: async (srv) => {
      const n = (srv as { name: string }).name;
      if (map[n] === "THROW") throw new Error("unreachable host");
      const s: Session = { server: srv as never, authMethod: "publickey", close: () => {}, exec: async (): Promise<ExecResult> => ({ code: 0, stdout: (map[n] as string) ?? "", stderr: "" }) };
      return s;
    },
    local: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
}
function reg(servers: string[], cluster?: { witness?: string; nodes?: string[]; vip?: string }) {
  const s: Record<string, { host: string; port: number; username: string; adpixDir: string }> = {};
  servers.forEach((n, i) => (s[n] = { host: `10.0.0.${i + 1}`, port: 22, username: "root", adpixDir: "/opt/adpix" }));
  saveRegistry({ version: 1, servers: s });
  if (cluster) { const r = loadRegistry(); r.clusters = { prod: { witness: cluster.witness, nodes: cluster.nodes ?? [], hosts: [], idpIssuer: "x", vip: cluster.vip } }; saveRegistry(r); }
}

describe("fleet — status thresholds", () => {
  const cases: [string, string, string][] = [
    ["mem 79 → healthy", "Linux|1|0.1|79|10", "healthy"],
    ["mem 80 → degraded", "Linux|1|0.1|80|10", "degraded"],
    ["cpu 84 → healthy", "Linux|1|0.84|10|10", "healthy"],
    ["cpu 85 → degraded", "Linux|1|0.85|10|10", "degraded"],
    ["disk 89 → healthy", "Linux|1|0.1|10|89", "healthy"],
    ["disk 90 → degraded", "Linux|1|0.1|10|90", "degraded"],
  ];
  for (const [name, probe, expected] of cases) {
    it(name, async () => {
      reg(["n"]);
      const f = await buildFleet(deps({ n: probe }), []);
      expect(f.nodes[0].status).toBe(expected);
    });
  }
});

describe("fleet — probe failures + partials", () => {
  it("all unreachable → all down", async () => {
    reg(["a", "b"], { nodes: ["a", "b"] });
    const f = await buildFleet(deps({ a: "THROW", b: "THROW" }), []);
    expect(f.counts.down).toBe(2);
    expect(f.nodes.every((n) => n.status === "down" && n.lastSeen === "unreachable")).toBe(true);
  });
  it("partial reachability is reflected per-node", async () => {
    reg(["a", "b"], { nodes: ["a", "b"] });
    const f = await buildFleet(deps({ a: "Linux|2|0.2|40|30", b: "THROW" }), []);
    expect(f.nodes.find((n) => n.name === "a")!.status).toBe("healthy");
    expect(f.nodes.find((n) => n.name === "b")!.status).toBe("down");
    expect(f.counts).toMatchObject({ healthy: 1, down: 1 });
  });
  it("malformed / empty probe output degrades gracefully to zeros", async () => {
    reg(["a", "b"]);
    const f = await buildFleet(deps({ a: "", b: "garbage-no-pipes" }), []);
    for (const n of f.nodes) { expect(n.cpu).toBe(0); expect(n.status).toBe("healthy"); expect(n.os).toBeTruthy(); }
  });
});

describe("fleet — registry shapes", () => {
  it("no servers → empty fleet", async () => {
    const f = await buildFleet(deps({}), []);
    expect(f.nodes).toEqual([]);
    expect(f.counts).toEqual({ healthy: 0, degraded: 0, down: 0, activeJobs: 0 });
  });
  it("servers without a cluster → role '—', dbRole 'node'", async () => {
    reg(["x"]);
    const f = await buildFleet(deps({ x: "Linux|1|0.1|10|10" }), []);
    expect(f.nodes[0].role).toBe("—");
    expect(f.nodes[0].dbRole).toBe("node");
    expect(f.cluster.name).toBe("");
  });
  it("activeJobs counts running + queued from the engine list", async () => {
    reg(["x"]);
    const jobs = [
      { id: "1", tool: "t", args: {}, status: "running" as const, key: "_", createdAt: "t", logTail: [] },
      { id: "2", tool: "t", args: {}, status: "queued" as const, key: "_", createdAt: "t", logTail: [] },
      { id: "3", tool: "t", args: {}, status: "succeeded" as const, key: "_", createdAt: "t", logTail: [] },
    ];
    const f = await buildFleet(deps({ x: "Linux|1|0.1|10|10" }), jobs);
    expect(f.counts.activeJobs).toBe(2);
  });
});

describe("fleet — multiple clusters", () => {
  function twoClusters() {
    const s: Record<string, { host: string; port: number; username: string; adpixDir: string }> = {};
    ["w1", "a", "w2", "b"].forEach((n, i) => (s[n] = { host: `10.0.0.${i + 1}`, port: 22, username: "root", adpixDir: "/opt/adpix" }));
    saveRegistry({ version: 1, servers: s });
    const r = loadRegistry();
    r.clusters = { east: { witness: "w1", nodes: ["a"], hosts: [], idpIssuer: "x", vip: "10.0.0.100" }, west: { witness: "w2", nodes: ["b"], hosts: [], idpIssuer: "x", vip: "10.0.0.200" } };
    saveRegistry(r);
  }
  const allUp = deps({ w1: "L|1|0.1|10|10", a: "L|1|0.1|10|10", w2: "L|1|0.1|10|10", b: "L|1|0.1|10|10" });
  it("listClusters returns every defined cluster", () => {
    twoClusters();
    const cs = listClusters();
    expect(cs.map((c) => c.name).sort()).toEqual(["east", "west"]);
    expect(cs.find((c) => c.name === "west")!.vip).toBe("10.0.0.200");
  });
  it("buildFleet scopes roles to the SELECTED cluster", async () => {
    twoClusters();
    const f = await buildFleet(allUp, [], "west");
    expect(f.cluster.name).toBe("west");
    const by = Object.fromEntries(f.nodes.map((n) => [n.name, n.role]));
    expect(by.w2).toBe("witness"); expect(by.b).toBe("node");
    expect(by.w1).toBe("—"); expect(by.a).toBe("—"); // not in 'west'
  });
  it("defaults to the first cluster when none is named", async () => {
    twoClusters();
    expect((await buildFleet(allUp, [])).cluster.name).toBe("east");
  });
  it("probes ALL servers regardless of cluster selection", async () => {
    twoClusters();
    const f = await buildFleet(allUp, [], "west");
    expect(f.nodes.length).toBe(4);
  });
});

describe("fleet — verifyServer + parseTuneRows", () => {
  it("verifyServer: connect throws → unreachable", async () => {
    const r = await verifyServer(deps({ "9.9.9.9": "THROW" }), { host: "9.9.9.9" });
    expect(r.reachable).toBe(false);
    expect(r.fingerprint).toBe("");
  });
  it("parseTuneRows tolerates empty / arrowless / mixed separators", () => {
    expect(parseTuneRows("")).toEqual([]);
    expect(parseTuneRows("just a sentence with no arrow")).toEqual([]);
    const rows = parseTuneRows("a 1 → 2\nb 3 -> 4\nc 5 => 6");
    expect(rows.map((r) => r.setting)).toEqual(["a", "b", "c"]);
  });
});
