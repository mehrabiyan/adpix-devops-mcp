import { describe, expect, it } from "vitest";
import {
  computeCapacity,
  recommendStage,
  STAGE_CEILINGS,
  DEFAULT_INPUTS,
} from "../src/scaling/model.js";
import { roadmap, topic, nextStepFrom, TOPIC_NAMES, STAGES } from "../src/scaling/playbook.js";
import type { Deps } from "../src/deps.js";
import type { ServerConfig } from "../src/registry.js";
import type { ExecResult, Session } from "../src/ssh.js";
import { allTools } from "../src/tools/index.js";

const tool = (name: string) => {
  const t = allTools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};

describe("capacity model", () => {
  it("derives the headline 100k projection", () => {
    const c = computeCapacity(); // defaults = 100k sites
    expect(c.eventsPerDay).toBe(500_000_000);
    expect(Math.round(c.avgEps)).toBe(5_787);
    expect(c.recommendedStage).toBe(3);
    expect(c.chShards).toBeGreaterThanOrEqual(2);
    expect(c.ingestReplicas).toBeGreaterThanOrEqual(2);
  });

  it("scales monotonically with load", () => {
    const small = computeCapacity({ sites: 1_000 });
    const big = computeCapacity({ sites: 200_000, eventsPerVisit: 10 });
    expect(big.eventsPerDay).toBeGreaterThan(small.eventsPerDay);
    expect(big.chShards).toBeGreaterThanOrEqual(small.chShards);
    expect(big.ingestReplicas).toBeGreaterThanOrEqual(small.ingestReplicas);
    expect(big.eventsLocalTBReplicated).toBeGreaterThan(small.eventsLocalTBReplicated);
  });

  it("respects replication factor in node count and disk", () => {
    const rf1 = computeCapacity({ replicationFactor: 1 });
    const rf3 = computeCapacity({ replicationFactor: 3 });
    expect(rf3.eventsLocalTBReplicated).toBeCloseTo(rf1.eventsLocalTBReplicated * 3, 1);
    expect(rf3.chNodesTotal).toBeGreaterThan(rf1.chNodesTotal);
  });

  it("only sizes the worker fleet when destinations are on", () => {
    expect(computeCapacity({ destinationsEnabled: false }).workerReplicas).toBe(1);
    expect(computeCapacity({ destinationsEnabled: true }).workerReplicas).toBeGreaterThanOrEqual(2);
  });

  it("keeps a minimum of 2 ingest replicas even for tiny load", () => {
    expect(computeCapacity({ sites: 1, visitsPerSitePerDay: 1 }).ingestReplicas).toBe(2);
  });

  it("shows the retention cost lever (full TTL >> chosen hot retention)", () => {
    const c = computeCapacity({ retentionDays: 90 });
    expect(c.fullTtlEventsLocalTB).toBeGreaterThan(c.eventsLocalTB);
  });

  it("recommendStage matches the published ceilings", () => {
    expect(recommendStage(1_000_000)).toBe(0);
    expect(recommendStage(20_000_000)).toBe(1);
    expect(recommendStage(200_000_000)).toBe(2);
    expect(recommendStage(1_000_000_000)).toBe(3);
    expect(recommendStage(5_000_000_000)).toBe(4);
    // boundaries are inclusive upper bounds
    for (const c of STAGE_CEILINGS) {
      if (Number.isFinite(c.maxEventsPerDay)) expect(recommendStage(c.maxEventsPerDay)).toBe(c.stage);
    }
  });
});

describe("scaling playbook", () => {
  it("roadmap covers all five stages and the principles", () => {
    const r = roadmap();
    expect(r).toContain("Evolutionary, never big-bang");
    expect(r).toContain("Frozen surfaces stay frozen");
    expect(r).toContain("Zero campaign interruptions");
    for (let s = 0; s <= 4; s++) expect(r).toContain(`Stage ${s}`);
  });

  it("serves every advertised topic, and rejects unknowns", () => {
    for (const name of TOPIC_NAMES) {
      const body = topic(name);
      expect(body, name).toBeTruthy();
      expect(body!.length).toBeGreaterThan(100);
    }
    expect(topic("does-not-exist")).toBeUndefined();
  });

  it("topics are grounded in AdPix's real seams (not generic cloud lore)", () => {
    expect(topic("kafka")).toMatch(/KAFKA_BROKERS|WORKER_SOURCE/);
    expect(topic("kafka")).toContain("webhook_outbox"); // the always-on backstop
    expect(topic("clickhouse-cluster")).toContain("ReplicatedReplacingMergeTree");
    expect(topic("clickhouse-cluster")).toContain("tenant_id"); // frozen tenant-leading sort key
    expect(topic("identity-job-ha")).toMatch(/ADR-0012|union-find/);
    expect(topic("zero-downtime-migration")).toMatch(/dual-write|shadow|parity/i);
    expect(topic("kubernetes")).toMatch(/HPA|operator/);
  });

  it("nextStepFrom is defined for every stage and terminal at 4", () => {
    for (let s = 0; s <= 3; s++) expect(nextStepFrom(s as 0)).toContain("Next non-disruptive step");
    expect(nextStepFrom(4)).toContain(STAGES[4].nonDisruptiveStep.slice(0, 20));
  });
});

// --- tool-level tests ----------------------------------------------------------
type Responder = [RegExp, Partial<ExecResult> | ((cmd: string) => Partial<ExecResult>)];
function fakeDeps(responses: Responder[]) {
  const calls: string[] = [];
  const server: ServerConfig = { name: "prod", host: "203.0.113.7", port: 22, username: "root", adpixDir: "/opt/adpix" };
  const session: Session = {
    server, authMethod: "publickey", close: () => {},
    exec: async (cmd: string) => {
      calls.push(cmd);
      for (const [re, res] of responses) {
        if (re.test(cmd)) return { code: 0, stdout: "", stderr: "", ...(typeof res === "function" ? res(cmd) : res) };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { deps: { resolve: () => server, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) } as Deps, calls };
}

describe("consult tools", () => {
  it("are registered", () => {
    const names = allTools.map((t) => t.name);
    for (const n of ["capacity_plan", "consult_topic", "scale_assessment"]) expect(names).toContain(n);
  });

  it("capacity_plan renders a plan with stage, sizing and the cost lever", async () => {
    const out = await tool("capacity_plan").handler(fakeDeps([]).deps, {});
    expect(out).toContain("Capacity plan");
    expect(out).toContain("Stage 3");
    expect(out).toContain("ClickHouse shards");
    expect(out).toContain("dominant cost lever");
    expect(out).toContain("Stage 0"); // the "don't build this today" guidance
  });

  it("capacity_plan reflects custom inputs", async () => {
    const out = await tool("capacity_plan").handler(fakeDeps([]).deps, { sites: 50, visitsPerSitePerDay: 100, eventsPerVisit: 3 });
    expect(out).toContain("Stage 0");
    expect(out).toContain("50 sites");
  });

  it("consult_topic returns the roadmap by default and a specific topic on request", async () => {
    const def = await tool("consult_topic").handler(fakeDeps([]).deps, {});
    expect(def).toContain("Staged scaling roadmap");
    const k8s = await tool("consult_topic").handler(fakeDeps([]).deps, { topic: "kubernetes" });
    expect(k8s).toMatch(/Altinity|HPA/);
    const bad = await tool("consult_topic").handler(fakeDeps([]).deps, { topic: "nonsense" });
    expect(bad).toContain("Unknown topic");
  });

  it("scale_assessment explains when AdPix isn't installed", async () => {
    const { deps } = fakeDeps([[/test -d .*\.git.* && echo yes/, { stdout: "no" }]]);
    const out = await tool("scale_assessment").handler(deps, {});
    expect(out).toContain("install it first");
  });

  it("scale_assessment measures the live system and gives a staged next step", async () => {
    const { deps } = fakeDeps([
      [/test -d .*\.git.* && echo yes/, { stdout: "yes" }],
      [/CLICKHOUSE_DB/, { stdout: "sovereign" }],
      [/system\.parts/, { stdout: "1.20 TiB\t1.2" }],
      [/INTERVAL 1 HOUR/, { stdout: "300000\t20000000\t500000000\t1200" }],
      [/nproc/, { stdout: "8\n16000 9000\n40000 55%\nclickhouse,ingest,api,web,worker,postgres,caddy," }],
    ]);
    const out = await tool("scale_assessment").handler(deps, {});
    expect(out).toContain("events in the last 24h");
    expect(out).toContain("Stage 1"); // 20M events/day → stage 1
    expect(out).toContain("Next step (non-disruptive)");
    expect(out).toContain("1,200 sites");
    expect(out).toContain("8 vCPU");
  });
});
