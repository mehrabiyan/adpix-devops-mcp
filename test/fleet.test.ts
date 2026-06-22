import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildFleet, verifyServer, parseTuneRows } from "../src/panel/fleet.js";
import { saveRegistry, loadRegistry, resolveServer } from "../src/registry.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";

let tmp: string; const SAVED = process.env.ADPIX_DEVOPS_HOME;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-fleet-")); process.env.ADPIX_DEVOPS_HOME = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

// per-node probe output: os|cores|load|mem%|disk%
function fleetDeps(probe: Record<string, string>, fail: string[] = []): Deps {
  return {
    resolve: resolveServer,
    connect: async (srv) => {
      const name = (srv as { name: string }).name;
      if (fail.includes(name)) throw new Error("unreachable");
      const s: Session = { server: srv as never, authMethod: "publickey", close: () => {}, exec: async (): Promise<ExecResult> => ({ code: 0, stdout: probe[name] ?? "Linux|1|0|10|10", stderr: "" }) };
      return s;
    },
    local: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
}
function cluster3() {
  saveRegistry({ version: 1, servers: { w1: { host: "10.0.0.4", port: 22, username: "root", adpixDir: "/opt/adpix" }, "node-a": { host: "10.0.0.11", port: 22, username: "root", adpixDir: "/opt/adpix" }, "node-b": { host: "10.0.0.12", port: 22, username: "root", adpixDir: "/opt/adpix" } } });
  const r = loadRegistry(); r.clusters = { prod: { witness: "w1", nodes: ["node-a", "node-b"], hosts: [], idpIssuer: "x", vip: "10.0.0.10" } }; saveRegistry(r);
}

describe("parseTuneRows", () => {
  it("extracts before→after rows", () => {
    const rows = parseTuneRows("max_threads 8 → 16\nbackground_pool_size: 8 -> 16\nnoise line\nshared_buffers = 128MB => 256MB");
    expect(rows.length).toBe(3);
    expect(rows[0]).toEqual({ setting: "max_threads", before: "8", after: "16" });
  });
});

describe("buildFleet", () => {
  it("models roles, statuses, counts, and topology from live probes", async () => {
    cluster3();
    const deps = fleetDeps({ w1: "Debian 12|2|0.1|30|22", "node-a": "Ubuntu 24.04|4|0.4|62|54", "node-b": "Ubuntu 24.04|4|3.8|88|67" });
    const f = await buildFleet(deps, []);
    expect(f.cluster.name).toBe("prod");
    expect(f.cluster.vip).toBe("10.0.0.10");
    const byName = Object.fromEntries(f.nodes.map((n) => [n.name, n]));
    expect(byName.w1.role).toBe("witness");
    expect(byName["node-a"].role).toBe("node");
    expect(byName["node-a"].status).toBe("healthy");
    expect(byName["node-b"].status).toBe("degraded"); // mem 88 ≥ 80
    expect(byName["node-a"].dbRole).toBe("pg primary · ch r1");
    expect(f.counts.healthy).toBe(2);
    expect(f.counts.degraded).toBe(1);
    expect(f.alerts.some((a) => a.title.includes("node-b"))).toBe(true);
  });
  it("marks an unreachable node down", async () => {
    cluster3();
    const f = await buildFleet(fleetDeps({}, ["node-b"]), []);
    expect(f.nodes.find((n) => n.name === "node-b")!.status).toBe("down");
    expect(f.counts.down).toBe(1);
  });
  it("counts active jobs from the engine list", async () => {
    cluster3();
    const f = await buildFleet(fleetDeps({}), [{ id: "x", tool: "t", args: {}, status: "running", key: "_", createdAt: "t", logTail: [] }]);
    expect(f.counts.activeJobs).toBe(1);
  });
});

describe("verifyServer", () => {
  it("reports reachable + a fingerprint when the connect succeeds", async () => {
    const r = await verifyServer(fleetDeps({ "10.0.0.13": "ok" }), { host: "10.0.0.13", port: 22, username: "root" });
    expect(r.reachable).toBe(true);
  });
  it("reports unreachable when connect throws", async () => {
    const r = await verifyServer(fleetDeps({}, ["10.0.0.99"]), { host: "10.0.0.99" });
    expect(r.reachable).toBe(false);
    expect(r.detail).toMatch(/unreachable/);
  });
});
