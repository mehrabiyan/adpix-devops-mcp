import { describe, expect, it } from "vitest";
import { kafkaTools } from "../src/tools/kafka.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";

const SRV: ServerConfig = { name: "prod3", host: "188.121.121.28", port: 22, username: "root", adpixDir: "/opt/adpix" };
const t = (n: string) => kafkaTools.find((x) => x.name === n)!;

function deps(respond: (cmd: string) => string | ExecResult) {
  const seen: string[] = [];
  const session: Session = {
    server: SRV, authMethod: "publickey", close: () => {},
    exec: async (cmd: string): Promise<ExecResult> => { seen.push(cmd); const r = respond(cmd); return typeof r === "string" ? { code: 0, stdout: r, stderr: "" } : r; },
  };
  return { d: { resolve: () => SRV, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) } as Deps, seen };
}

describe("kafka_deploy", () => {
  it("dry-run shows a loopback-bound, hardened KRaft compose (no confirm = no write)", async () => {
    const { d, seen } = deps(() => "");
    const out = await t("kafka_deploy").handler(d, { server: "prod3", brokers: 1, extPort: 19092, retentionHours: 168, partitions: 6, bindPublic: false, confirm: false });
    expect(out).toMatch(/deploy plan/);
    expect(out).toMatch(/127\.0\.0\.1:19092/);
    expect(out).toMatch(/KAFKA_PROCESS_ROLES: broker,controller/);   // KRaft (no ZooKeeper)
    expect(out).toMatch(/AUTO_CREATE_TOPICS_ENABLE: "false"/);
    expect(seen.some((c) => /base64 -d|up -d/.test(c))).toBe(false); // dry-run wrote nothing
  });

  it("bindPublic warns about PLAINTEXT exposure", async () => {
    const { d } = deps(() => "");
    const out = await t("kafka_deploy").handler(d, { server: "prod3", brokers: 1, extPort: 19092, retentionHours: 168, partitions: 6, bindPublic: true, confirm: false });
    expect(out).toMatch(/do NOT use in prod without SASL\/TLS/);
    expect(out).toMatch(/0\.0\.0\.0/);
  });

  it("3-broker uses RF=3 + min.insync=2", async () => {
    const { d } = deps(() => "");
    const out = await t("kafka_deploy").handler(d, { server: "prod3", brokers: 3, extPort: 19092, retentionHours: 168, partitions: 6, bindPublic: false, confirm: false });
    expect(out).toMatch(/RF=3, min\.insync=2/);
  });

  it("confirm writes the compose + brings the broker up + waits for the API", async () => {
    const { d, seen } = deps((cmd) => {
      if (/up -d/.test(cmd)) return "Started";
      if (/kafka-broker-api-versions/.test(cmd)) return "READY";
      return "";
    });
    const out = await t("kafka_deploy").handler(d, { server: "prod3", brokers: 1, extPort: 19092, retentionHours: 168, partitions: 6, bindPublic: false, confirm: true });
    expect(out).toMatch(/deployed/);
    expect(seen.some((c) => /docker-compose\.yml/.test(c) && /base64 -d/.test(c))).toBe(true);
    expect(seen.some((c) => /up -d/.test(c))).toBe(true);
  });
});

describe("kafka_health", () => {
  it("HEALTHY when brokers answer and no URP/offline", async () => {
    const { d } = deps(() => "===API\n5\n===QUORUM\nLeaderId: 1\n===URP\n0\n===OFFLINE\n0\n===TOPICS\n3\n===DISK\n41% used, 30000MB free");
    const out = await t("kafka_health").handler(d, { server: "prod3", dir: "/opt/adpix-kafka" });
    expect(out).toMatch(/→ HEALTHY/);
    expect(out).toMatch(/Topics \(excl\. internal\): 3/);
  });
  it("DEGRADED on under-replicated partitions", async () => {
    const { d } = deps(() => "===API\n5\n===QUORUM\nLeaderId: 1\n===URP\n2\n===OFFLINE\n0\n===TOPICS\n3\n===DISK\n41% used");
    expect(await t("kafka_health").handler(d, { server: "prod3", dir: "/opt/adpix-kafka" })).toMatch(/→ DEGRADED/);
  });
  it("DOWN on offline partitions", async () => {
    const { d } = deps(() => "===API\n5\n===QUORUM\n-\n===URP\n0\n===OFFLINE\n1\n===TOPICS\n3\n===DISK\n-");
    expect(await t("kafka_health").handler(d, { server: "prod3", dir: "/opt/adpix-kafka" })).toMatch(/→ DOWN/);
  });
});

describe("kafka_topics", () => {
  it("create is confirm-gated and sets min.insync + compression", async () => {
    const { d, seen } = deps((cmd) => (/--create/.test(cmd) ? "Created topic events." : ""));
    const plan = await t("kafka_topics").handler(d, { server: "prod3", dir: "/opt/adpix-kafka", action: "create", topic: "events", partitions: 12, replicationFactor: 3, compression: "lz4", confirm: false });
    expect(plan).toMatch(/Re-run with confirm:true/);
    expect(seen.some((c) => /--create/.test(c))).toBe(false);
    const done = await t("kafka_topics").handler(d, { server: "prod3", dir: "/opt/adpix-kafka", action: "create", topic: "events", partitions: 12, replicationFactor: 3, compression: "lz4", confirm: true });
    expect(done).toMatch(/Created/);
    const create = seen.find((c) => /--create/.test(c))!;
    expect(create).toMatch(/min\.insync\.replicas=2/);   // RF>=3 → min.insync 2
    expect(create).toMatch(/compression\.type=lz4/);
    expect(create).toMatch(/--partitions 12 --replication-factor 3/);
  });
  it("list filters internal topics", async () => {
    const { d } = deps(() => "__consumer_offsets\nevents\nclicks");
    const out = await t("kafka_topics").handler(d, { server: "prod3", dir: "/opt/adpix-kafka", action: "list", partitions: 6, replicationFactor: 1, compression: "producer", confirm: false });
    expect(out).toMatch(/events/); expect(out).toMatch(/clicks/); expect(out).not.toMatch(/__consumer_offsets/);
  });
});

describe("kafka_lag", () => {
  it("summarizes total + worst-partition lag per group and flags falling-behind", async () => {
    const rows = "GROUP TOPIC PARTITION CURRENT-OFFSET LOG-END-OFFSET LAG CONSUMER-ID HOST CLIENT-ID\n" +
      "ingest events 0 100 200100 200000 c1 h1 id1\n" +
      "ingest events 1 50 60 10 c2 h1 id2";
    const { d } = deps(() => rows);
    const out = await t("kafka_lag").handler(d, { server: "prod3", dir: "/opt/adpix-kafka", group: undefined });
    expect(out).toMatch(/ingest/);
    expect(out).toMatch(/total lag\s+200010/);
    expect(out).toMatch(/falling behind/);   // >100k
  });
  it("handles no groups gracefully", async () => {
    const { d } = deps(() => "");
    expect(await t("kafka_lag").handler(d, { server: "prod3", dir: "/opt/adpix-kafka", group: undefined })).toMatch(/No active consumer groups/);
  });
});

describe("kafka_tune", () => {
  it("dry-run lists dynamic broker recommendations; confirm applies via kafka-configs --alter", async () => {
    const { d, seen } = deps((cmd) => (/--alter/.test(cmd) ? "Completed updating default config for brokers" : "Default config for brokers"));
    const plan = await t("kafka_tune").handler(d, { server: "prod3", dir: "/opt/adpix-kafka", confirm: false });
    expect(plan).toMatch(/num\.io\.threads.*→ 8/);
    expect(seen.some((c) => /--alter/.test(c))).toBe(false);
    const applied = await t("kafka_tune").handler(d, { server: "prod3", dir: "/opt/adpix-kafka", confirm: true });
    expect(applied).toMatch(/applied/);
    expect(seen.find((c) => /--alter/.test(c))!).toMatch(/num\.replica\.fetchers=4/);
  });
});
