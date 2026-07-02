import { z } from "zod";
import { withSession } from "../deps.js";
import { uploadFile } from "../adpix.js";
import { shq, lastLines } from "../util.js";
import type { ToolDef } from "./types.js";

const serverParam = z.string().optional().describe("Target server name. Omit to use the default.");
const KDIR = "/opt/adpix-kafka";
const PROJECT = "adpix-kafka";
const BIN = "/opt/kafka/bin";
const BS = "localhost:9092"; // the broker's own PLAINTEXT listener, inside the container
// A fixed KRaft cluster id (base64 UUID) so re-deploys reuse the same formatted storage.
const CLUSTER_ID = "AdpixKafkaKRaft01A";

/** Run a broker-CLI command inside the running broker container (bootstrap = its own listener). */
function kexec(dir: string, inner: string): string {
  return `cd ${shq(dir)} && docker compose -p ${PROJECT} exec -T broker sh -c ${shq(inner)} 2>&1`;
}
function splitSections(out: string): Record<string, string> {
  const sec: Record<string, string> = {}; let cur = "";
  for (const ln of out.split("\n")) { const m = ln.match(/^===(\w+)/); if (m) { cur = m[1]; sec[cur] = ""; } else if (cur) sec[cur] += ln + "\n"; }
  return sec;
}

/**
 * Single-host KRaft (ZooKeeper-free) Kafka compose. `brokers`=1 is the default (dev/single-node); 3 puts
 * three broker+controller processes on ONE host (test/HA-rehearsal only — real HA spreads brokers across
 * hosts). The external listener binds LOOPBACK by default (never 0.0.0.0 without auth — matches the
 * platform's no-public-datastore posture); the internal PLAINTEXT listener is compose-network only.
 */
function composeYaml(o: { brokers: number; extPort: number; retentionHours: number; partitions: number; bindPublic: boolean }): string {
  const rf = Math.min(o.brokers, 3);
  const minIsr = o.brokers >= 3 ? 2 : 1;
  const voters = Array.from({ length: o.brokers }, (_, i) => `${i + 1}@broker${o.brokers > 1 ? i + 1 : ""}:9093`).join(",");
  const bind = o.bindPublic ? "" : "127.0.0.1:";
  const svc = (id: number) => {
    const name = o.brokers > 1 ? `broker${id}` : "broker";
    const hostExt = o.extPort + (id - 1);
    return (
      `  ${name}:\n` +
      `    image: apache/kafka:3.9.0\n` +
      `    restart: unless-stopped\n` +
      `    environment:\n` +
      `      KAFKA_NODE_ID: ${id}\n` +
      `      KAFKA_PROCESS_ROLES: broker,controller\n` +
      `      KAFKA_CONTROLLER_QUORUM_VOTERS: ${voters}\n` +
      `      KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093,EXTERNAL://:19092\n` +
      `      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://${name}:9092,EXTERNAL://127.0.0.1:${hostExt}\n` +
      `      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT,EXTERNAL:PLAINTEXT\n` +
      `      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER\n` +
      `      KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT\n` +
      `      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: ${rf}\n` +
      `      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: ${rf}\n` +
      `      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: ${minIsr}\n` +
      `      KAFKA_DEFAULT_REPLICATION_FACTOR: ${rf}\n` +
      `      KAFKA_MIN_INSYNC_REPLICAS: ${minIsr}\n` +
      `      KAFKA_NUM_PARTITIONS: ${o.partitions}\n` +
      `      KAFKA_AUTO_CREATE_TOPICS_ENABLE: "false"\n` +
      `      KAFKA_LOG_RETENTION_HOURS: ${o.retentionHours}\n` +
      // high-throughput defaults
      `      KAFKA_NUM_NETWORK_THREADS: 5\n` +
      `      KAFKA_NUM_IO_THREADS: 8\n` +
      `      KAFKA_SOCKET_SEND_BUFFER_BYTES: 1048576\n` +
      `      KAFKA_SOCKET_RECEIVE_BUFFER_BYTES: 1048576\n` +
      `      KAFKA_NUM_REPLICA_FETCHERS: 4\n` +
      `      KAFKA_COMPRESSION_TYPE: producer\n` +
      `      CLUSTER_ID: ${CLUSTER_ID}\n` +
      `    ports:\n      - "${bind}${hostExt}:19092"\n` +
      `    volumes:\n      - ${name}_data:/var/lib/kafka/data\n` +
      `    networks: ["kafka"]\n` +
      `    healthcheck:\n` +
      `      test: ["CMD-SHELL", "${BIN}/kafka-broker-api-versions.sh --bootstrap-server ${BS} >/dev/null 2>&1 || exit 1"]\n` +
      `      interval: 20s\n      timeout: 10s\n      retries: 6\n`
    );
  };
  const services = Array.from({ length: o.brokers }, (_, i) => svc(i + 1)).join("");
  const vols = Array.from({ length: o.brokers }, (_, i) => `  ${o.brokers > 1 ? `broker${i + 1}` : "broker"}_data: {}`).join("\n");
  return (
    `# AdPix Kafka (KRaft — no ZooKeeper). External listener is LOOPBACK-only by default.\n` +
    `services:\n${services}` +
    `volumes:\n${vols}\n` +
    `networks:\n  kafka:\n    driver: bridge\n`
  );
}

export const kafkaTools: ToolDef[] = [
  {
    name: "kafka_deploy",
    title: "Deploy / update a KRaft Kafka broker (single-node or on-host cluster)",
    description:
      "Deploy a ZooKeeper-free (KRaft) Kafka on the target: hardened defaults (external listener LOOPBACK-only " +
      "unless bindPublic, no auto-create topics, sane RF/min.insync, high-throughput thread/socket/fetcher tuning). " +
      "brokers=1 (default) is single-node; 3 rehearses HA on one host (real HA spreads across hosts). Dry-run " +
      "shows the compose; confirm:true writes it + brings the broker up + formats KRaft storage. Data volume is " +
      "never deleted. Then use kafka_health / kafka_topics / kafka_lag / kafka_tune.",
    schema: {
      server: serverParam,
      brokers: z.number().int().min(1).max(3).default(1),
      extPort: z.number().int().min(1024).max(65535).default(19092).describe("Host port for the external listener (bound to 127.0.0.1 unless bindPublic)"),
      retentionHours: z.number().int().min(1).max(8760).default(168),
      partitions: z.number().int().min(1).max(200).default(6).describe("Default partitions for new topics"),
      bindPublic: z.boolean().default(false).describe("Publish the external listener on 0.0.0.0 (INSECURE without SASL/TLS — keep false)"),
      confirm: z.boolean().default(false),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; brokers: number; extPort: number; retentionHours: number; partitions: number; bindPublic: boolean; confirm: boolean };
      return withSession(deps, a.server, async (s, srv) => {
        const yaml = composeYaml({ brokers: a.brokers, extPort: a.extPort, retentionHours: a.retentionHours, partitions: a.partitions, bindPublic: a.bindPublic });
        if (!a.confirm) {
          return [
            `# Kafka deploy plan — ${srv.name}`,
            `${a.brokers}-broker KRaft, external listener ${a.bindPublic ? "0.0.0.0" : "127.0.0.1"}:${a.extPort}, RF=${Math.min(a.brokers, 3)}, min.insync=${a.brokers >= 3 ? 2 : 1}, retention ${a.retentionHours}h, ${a.partitions} default partitions.`,
            a.bindPublic ? `⚠ bindPublic exposes the broker with PLAINTEXT + no auth — do NOT use in prod without SASL/TLS.` : `External listener is loopback-only (secure default).`,
            `Compose (${KDIR}/docker-compose.yml):\n\`\`\`yaml\n${yaml}\`\`\``,
            `Deploy: kafka_deploy confirm:true`,
          ].join("\n\n");
        }
        await s.exec(`mkdir -p ${shq(KDIR)}`, { timeoutMs: 10_000 });
        await uploadFile(s, `${KDIR}/docker-compose.yml`, yaml, "644");
        const up = await s.exec(`cd ${shq(KDIR)} && docker compose -p ${PROJECT} up -d 2>&1`, { timeoutMs: 300_000 });
        const ok = up.code === 0 || /Started|Running|Healthy|Created/.test(up.stdout);
        const wait = ok ? await s.exec(kexec(KDIR, `for i in $(seq 1 20); do ${BIN}/kafka-broker-api-versions.sh --bootstrap-server ${BS} >/dev/null 2>&1 && { echo READY; break; }; sleep 3; done`), { timeoutMs: 90_000 }) : { stdout: "" } as { stdout: string };
        return [
          `# Kafka ${ok ? "deployed" : "deploy FAILED"} — ${srv.name}`,
          ok ? (/READY/.test(wait.stdout) ? `Broker(s) up and answering on the ${a.bindPublic ? "public" : "loopback"} external listener :${a.extPort}. Auto-create topics is OFF — create them with kafka_topics.` : `Containers started but the broker didn't answer the API within ~60s — check kafka_health / logs.`) : lastLines(up.stdout, 10),
          ok ? `Next: kafka_topics action=create · kafka_health · kafka_lag.` : `If the image couldn't be pulled (egress-blocked node), relay apache/kafka:3.9.0 and retry.`,
        ].join("\n\n");
      });
    },
  },

  {
    name: "kafka_health",
    title: "Kafka health — brokers, controller quorum, under-replicated/offline partitions",
    description:
      "Read-only Kafka health: broker API reachable, KRaft controller quorum status, under-replicated partitions, " +
      "offline/unavailable partitions, topic count, and log-dir disk. Verdict HEALTHY / DEGRADED / DOWN. The " +
      "under-replicated + offline counts are the primary at-a-glance SRE signals.",
    schema: { server: serverParam, dir: z.string().default(KDIR) },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; dir: string };
      return withSession(deps, a.server, async (s, srv) => {
        const r = await s.exec(kexec(a.dir,
          `echo ===API; ${BIN}/kafka-broker-api-versions.sh --bootstrap-server ${BS} 2>/dev/null | grep -c 'id:' || echo 0; ` +
          `echo ===QUORUM; ${BIN}/kafka-metadata-quorum.sh --bootstrap-server ${BS} describe --status 2>/dev/null | grep -E 'LeaderId|CurrentVoters|MaxFollowerLag' || echo unavailable; ` +
          `echo ===URP; ${BIN}/kafka-topics.sh --bootstrap-server ${BS} --describe --under-replicated-partitions 2>/dev/null | grep -c Topic || echo 0; ` +
          `echo ===OFFLINE; ${BIN}/kafka-topics.sh --bootstrap-server ${BS} --describe --unavailable-partitions 2>/dev/null | grep -c Topic || echo 0; ` +
          `echo ===TOPICS; ${BIN}/kafka-topics.sh --bootstrap-server ${BS} --list 2>/dev/null | grep -vc '^__' || echo 0; ` +
          `echo ===DISK; df -Pk /var/lib/kafka/data 2>/dev/null | awk 'END{print $5" used, "int($4/1024)"MB free"}'`
        ), { timeoutMs: 60_000 });
        if (/No such service|not running|Cannot connect|no configuration file/i.test(r.stdout) && !/===API/.test(r.stdout)) return `# Kafka health — ${srv.name}\nDOWN — no Kafka running at ${a.dir} (kafka_deploy first).`;
        const sec = splitSections(r.stdout);
        const brokers = parseInt((sec.API || "0").trim(), 10) || 0;
        const urp = parseInt((sec.URP || "0").trim(), 10) || 0;
        const offline = parseInt((sec.OFFLINE || "0").trim(), 10) || 0;
        const topics = parseInt((sec.TOPICS || "0").trim(), 10) || 0;
        const verdict = brokers === 0 || offline > 0 ? "DOWN" : urp > 0 ? "DEGRADED" : "HEALTHY";
        return [
          `# Kafka health — ${srv.name}  → ${verdict}`,
          `Broker API: ${brokers > 0 ? `reachable (${brokers} api-versions)` : "UNREACHABLE"}`,
          `Controller quorum:\n${lastLines((sec.QUORUM || "").trim(), 4) || "  unavailable"}`,
          `Under-replicated partitions: ${urp}${urp ? "  ⚠ a broker/replica is behind — check ISR + broker health" : "  ✓"}`,
          `Offline/unavailable partitions: ${offline}${offline ? "  🔴 data unavailable — a partition has no leader" : "  ✓"}`,
          `Topics (excl. internal): ${topics}`,
          `Log dir: ${(sec.DISK || "?").trim()}`,
        ].join("\n");
      });
    },
  },

  {
    name: "kafka_topics",
    title: "Kafka topics — list / describe / create with SRE-safe defaults",
    description:
      "Manage Kafka topics. action=list (all non-internal), describe (one topic: partitions, RF, ISR, configs), " +
      "create (confirm) with SRE defaults — replication-factor honoring the cluster, min.insync.replicas, retention, " +
      "and compression. Create is confirm-gated; a topic name is required for describe/create.",
    schema: {
      server: serverParam, dir: z.string().default(KDIR),
      action: z.enum(["list", "describe", "create"]).default("list"),
      topic: z.string().optional(),
      partitions: z.number().int().min(1).max(1000).default(6),
      replicationFactor: z.number().int().min(1).max(5).default(1),
      retentionMs: z.number().int().optional().describe("Topic retention (ms). Omit → broker default"),
      compression: z.enum(["producer", "lz4", "zstd", "snappy", "gzip", "uncompressed"]).default("producer"),
      confirm: z.boolean().default(false),
    },
    annotations: { destructiveHint: false, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; dir: string; action: "list" | "describe" | "create"; topic?: string; partitions: number; replicationFactor: number; retentionMs?: number; compression: string; confirm: boolean };
      return withSession(deps, a.server, async (s, srv) => {
        if (a.action === "list") {
          const r = await s.exec(kexec(a.dir, `${BIN}/kafka-topics.sh --bootstrap-server ${BS} --list`), { timeoutMs: 30_000 });
          const topics = r.stdout.split("\n").map((t) => t.trim()).filter((t) => t && !t.startsWith("__") && !/error|exception/i.test(t));
          return `# Kafka topics — ${srv.name}\n${topics.length ? topics.map((t) => "  " + t).join("\n") : "  (none — create with action=create)"}`;
        }
        if (a.action === "describe") {
          if (!a.topic) return `describe needs topic=<name>.`;
          const r = await s.exec(kexec(a.dir, `${BIN}/kafka-topics.sh --bootstrap-server ${BS} --describe --topic ${shq(a.topic)}`), { timeoutMs: 30_000 });
          return `# Topic ${a.topic} — ${srv.name}\n\`\`\`\n${lastLines(r.stdout.trim(), 40)}\n\`\`\``;
        }
        // create
        if (!a.topic) return `create needs topic=<name>.`;
        if (!a.confirm) return `# Create plan — ${a.topic}\npartitions=${a.partitions} · RF=${a.replicationFactor} · min.insync=${a.replicationFactor >= 3 ? 2 : 1} · compression=${a.compression}${a.retentionMs ? ` · retention.ms=${a.retentionMs}` : ""}.\nRe-run with confirm:true.`;
        const cfgs = [`--config min.insync.replicas=${a.replicationFactor >= 3 ? 2 : 1}`, `--config compression.type=${a.compression}`, ...(a.retentionMs ? [`--config retention.ms=${a.retentionMs}`] : [])].join(" ");
        const r = await s.exec(kexec(a.dir, `${BIN}/kafka-topics.sh --bootstrap-server ${BS} --create --topic ${shq(a.topic)} --partitions ${a.partitions} --replication-factor ${a.replicationFactor} ${cfgs}`), { timeoutMs: 30_000 });
        const ok = /Created topic/i.test(r.stdout);
        return `# Topic create — ${a.topic}\n${ok ? `✓ Created (partitions=${a.partitions}, RF=${a.replicationFactor}, min.insync=${a.replicationFactor >= 3 ? 2 : 1}).` : lastLines(r.stdout.trim(), 6)}`;
      });
    },
  },

  {
    name: "kafka_lag",
    title: "Kafka consumer-group lag (the streaming pipeline's health signal)",
    description:
      "Report consumer-group lag — the key signal that a streaming pipeline is keeping up. action=list shows all " +
      "groups; describe (group=<name> or all) shows per-topic/partition CURRENT-OFFSET, LOG-END-OFFSET, and LAG, " +
      "with the total + worst-partition lag per group. Rising lag = consumers falling behind (scale them or the " +
      "topic). Read-only.",
    schema: { server: serverParam, dir: z.string().default(KDIR), group: z.string().optional().describe("A group name, or omit for all groups") },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; dir: string; group?: string };
      return withSession(deps, a.server, async (s, srv) => {
        const sel = a.group ? `--group ${shq(a.group)}` : `--all-groups`;
        const r = await s.exec(kexec(a.dir, `${BIN}/kafka-consumer-groups.sh --bootstrap-server ${BS} --describe ${sel} 2>/dev/null`), { timeoutMs: 45_000 });
        const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
        const header = lines.find((l) => /GROUP\s+TOPIC/.test(l));
        const rows = lines.filter((l) => !/GROUP\s+TOPIC/.test(l) && /\S+\s+\S+\s+\d+/.test(l));
        if (!rows.length) return `# Kafka lag — ${srv.name}\nNo active consumer groups${a.group ? ` matching "${a.group}"` : ""} (no consumers, or the group hasn't committed offsets yet).`;
        // columns: GROUP TOPIC PARTITION CURRENT-OFFSET LOG-END-OFFSET LAG ...
        const perGroup: Record<string, { total: number; max: number; parts: number }> = {};
        for (const row of rows) {
          const c = row.split(/\s+/);
          const group = c[0]; const lag = parseInt(c[5], 10);
          if (Number.isNaN(lag)) continue;
          const g = (perGroup[group] ??= { total: 0, max: 0, parts: 0 });
          g.total += lag; g.max = Math.max(g.max, lag); g.parts++;
        }
        const summary = Object.entries(perGroup).sort((x, y) => y[1].total - x[1].total).map(([g, v]) => `  ${g.padEnd(28)} total lag ${String(v.total).padStart(10)} · worst partition ${v.max} · ${v.parts} partitions${v.total > 100000 ? "  ⚠ falling behind" : ""}`);
        return [`# Kafka consumer lag — ${srv.name}`, summary.join("\n"), header ? `\nRaw:\n\`\`\`\n${header}\n${lastLines(rows.join("\n"), 20)}\n\`\`\`` : ``].filter(Boolean).join("\n");
      });
    },
  },

  {
    name: "kafka_tune",
    title: "Kafka high-throughput tuning (dynamic broker + topic configs)",
    description:
      "Advisory + apply for high-traffic Kafka tuning. Reads current dynamic broker configs and recommends " +
      "throughput settings (num.io.threads, num.network.threads, socket buffers, num.replica.fetchers, " +
      "message.max.bytes, log.segment.bytes, compression). Dry-run by default; confirm:true applies them as " +
      "DYNAMIC broker configs via kafka-configs.sh (no restart). Topic-level retention/compression stay per-topic " +
      "(kafka_topics).",
    schema: { server: serverParam, dir: z.string().default(KDIR), confirm: z.boolean().default(false) },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; dir: string; confirm: boolean };
      return withSession(deps, a.server, async (s, srv) => {
        const recommend: Record<string, string> = {
          "num.io.threads": "8", "num.network.threads": "5",
          "num.replica.fetchers": "4",
          "socket.send.buffer.bytes": "1048576", "socket.receive.buffer.bytes": "1048576",
          "message.max.bytes": "10485760", "replica.fetch.max.bytes": "10485760",
          "log.segment.bytes": "536870912", "compression.type": "producer",
        };
        const cur = await s.exec(kexec(a.dir, `${BIN}/kafka-configs.sh --bootstrap-server ${BS} --entity-type brokers --entity-default --describe 2>/dev/null`), { timeoutMs: 30_000 });
        if (!a.confirm) {
          return [
            `# Kafka tuning plan — ${srv.name} (high-throughput)`,
            `Would set these DYNAMIC broker defaults (no restart):`,
            Object.entries(recommend).map(([k, v]) => `  ${k.padEnd(28)} → ${v}`).join("\n"),
            `Current dynamic broker configs:\n${lastLines(cur.stdout.trim(), 8) || "  (broker defaults)"}`,
            `Apply: kafka_tune confirm:true. (These raise throughput + max message size; watch heap/disk after.)`,
          ].join("\n\n");
        }
        const alter = Object.entries(recommend).map(([k, v]) => `${k}=${v}`).join(",");
        const r = await s.exec(kexec(a.dir, `${BIN}/kafka-configs.sh --bootstrap-server ${BS} --entity-type brokers --entity-default --alter --add-config ${shq(alter)}`), { timeoutMs: 30_000 });
        const ok = /Completed|updated/i.test(r.stdout) || r.code === 0;
        return `# Kafka tuning ${ok ? "applied" : "FAILED"} — ${srv.name}\n${ok ? `Set ${Object.keys(recommend).length} dynamic broker defaults (no restart). Verify with kafka_health under load.` : lastLines(r.stdout.trim(), 8)}`;
      });
    },
  },
];
