import { z } from "zod";
import { withSession } from "../deps.js";
import type { Session } from "../ssh.js";
import { composeCmd, readEnvVar } from "../adpix.js";
import { shq, table } from "../util.js";
import {
  computeCapacity,
  recommendStage,
  stageLabel,
  STAGE_CEILINGS,
  STAGE_COST_USD,
  DEFAULT_INPUTS,
  type CapacityPlan,
} from "../scaling/model.js";
import { nextStepFrom, roadmap, topic, TOPIC_NAMES } from "../scaling/playbook.js";
import type { ToolDef } from "./types.js";

const serverParam = z
  .string()
  .optional()
  .describe("Registered server name. Omit to use the default server.");

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
function fmtTB(n: number): string {
  return n >= 1 ? `${n.toFixed(1)} TB` : `${(n * 1000).toFixed(0)} GB`;
}

function renderPlan(p: CapacityPlan): string {
  const i = p.inputs;
  const sizing = table(
    ["COMPONENT", "AT THIS SCALE", "NOTE"],
    [
      ["ingest replicas", `${p.ingestReplicas}`, "stateless, behind a load balancer"],
      ["ClickHouse shards", `${p.chShards}`, `max(by-insert ${p.chShardsByInsert}, by-disk ${p.chShardsByDisk})`],
      ["ClickHouse nodes", `${p.chNodesTotal}`, `${p.chShards} shard(s) × ${p.chReplicasPerShard} replica(s) for HA`],
      ["events_local disk", fmtTB(p.eventsLocalTBReplicated), `${i.retentionDays}d hot retention, ×${i.replicationFactor} replicas`],
      ["raw archive", `${fmtTB(p.rawArchiveTBPerMonth)}/mo`, "raw_events_jsonl; keep short, push to cold storage"],
      ["Kafka partitions", `${p.kafkaPartitions}`, "3 brokers, RF=3, min.insync=2"],
      ["worker replicas", `${p.workerReplicas}`, i.destinationsEnabled ? "destination delivery (consumer group)" : "destinations off"],
      ["Postgres", `~${fmtInt(p.pgPeakWritesPerSec)} writes/s peak`, "primary + read replica; not on the event hot path"],
    ]
  );

  const [loCost, hiCost] = p.costBandUsd;
  return [
    `# Capacity plan — ${fmtInt(i.sites)} sites × ${fmtInt(i.visitsPerSitePerDay)} visits/day × ${i.eventsPerVisit} events/visit`,
    ``,
    `## Projected load`,
    `- ${fmtInt(p.eventsPerDay)} events/day`,
    `- ${fmtInt(p.avgEps)} events/sec average, ~${fmtInt(p.peakEps)} events/sec peak (×${i.peakFactor})`,
    ``,
    `## Recommended topology: Stage ${p.recommendedStage} — ${stageLabel(p.recommendedStage)}`,
    `Rough self-hosted cost band: $${fmtInt(loCost)}–$${fmtInt(hiCost)}/mo (depends heavily on retention + cloud + reserved vs on-demand).`,
    ``,
    `## Sizing`,
    sizing,
    ``,
    `## The dominant cost lever`,
    `events_local at your chosen ${i.retentionDays}-day hot retention ≈ ${fmtTB(p.eventsLocalTBReplicated)}. ` +
      `If you instead kept the frozen 25-month TTL at this volume it would be ≈ ${fmtTB(p.fullTtlEventsLocalTB * i.replicationFactor)} — ` +
      `which is why at scale you shorten hot retention and serve long-range reports from the daily_metrics rollup MV (already exists) + a cold S3 tier. ` +
      `Run consult_topic topic:cost-optimization for the full lever list.`,
    ``,
    `## Important`,
    `These are conservative planning estimates (see the model's documented constants), not a benchmark — validate against a load test before committing spend. ` +
      `You almost certainly should NOT build this today: with 0 customers you belong at Stage 0. This shows the destination so you can confirm nothing here forces a rewrite to reach it. ` +
      `Use scale_assessment to see where you are now and the single next step; consult_topic topic:roadmap for the staged path.`,
  ].join("\n");
}

async function ch(s: Session, dir: string, db: string, query: string): Promise<string> {
  const r = await s.exec(
    `${composeCmd(dir)} exec -T clickhouse clickhouse-client --database ${shq(db)} --query ${shq(query)} 2>/dev/null`,
    { timeoutMs: 60_000 }
  );
  return r.stdout.trim();
}

export const consultTools: ToolDef[] = [
  {
    name: "capacity_plan",
    title: "Capacity plan for a target scale",
    description:
      "Compute the resources AdPix needs at a target scale — events/sec, ClickHouse shards + disk, " +
      "ingest/worker replicas, Kafka partitions, Postgres — plus the recommended topology stage and a " +
      "rough cost band. Pure model (no server needed); defaults to the 100k-sites projection. " +
      "Use for 'what will we need at scale X' and to confirm reaching it needs no rewrite.",
    schema: {
      sites: z.number().int().min(1).default(DEFAULT_INPUTS.sites).describe("Number of sites/tenants"),
      visitsPerSitePerDay: z.number().int().min(1).default(DEFAULT_INPUTS.visitsPerSitePerDay),
      eventsPerVisit: z.number().min(1).default(DEFAULT_INPUTS.eventsPerVisit).describe("Events per visit/session (pageview + interactions)"),
      peakFactor: z.number().min(1).max(20).default(DEFAULT_INPUTS.peakFactor).describe("peak ÷ average events/sec"),
      retentionDays: z.number().int().min(1).default(DEFAULT_INPUTS.retentionDays).describe("Hot events_local retention (long-term lives in rollups)"),
      replicationFactor: z.number().int().min(1).max(5).default(DEFAULT_INPUTS.replicationFactor).describe("ClickHouse replicas per shard (HA)"),
      destinationsEnabled: z.boolean().default(DEFAULT_INPUTS.destinationsEnabled).describe("Webhook destinations / outbox active?"),
    },
    annotations: { readOnlyHint: true },
    handler: async (_deps, args) => {
      const p = computeCapacity(args as Record<string, never>);
      return renderPlan(p);
    },
  },

  {
    name: "consult_topic",
    title: "Infrastructure consultation",
    description:
      "Advanced, AdPix-specific guidance on scaling, HA, and clustered setup. Topics: roadmap (the staged " +
      "single-VM→k8s path), ha-topology, kubernetes, docker, clickhouse-cluster, postgres-ha, kafka, " +
      "zero-downtime-migration, cost-optimization, identity-job-ha, campaign-readiness. Grounded in AdPix's " +
      "real seams (Kafka transport, the outbox backstop, the frozen tenant-leading sort key, ADR-0012 Flink).",
    schema: {
      topic: z
        .enum(TOPIC_NAMES as unknown as [string, ...string[]])
        .default("roadmap")
        .describe("Which playbook to return"),
    },
    annotations: { readOnlyHint: true },
    handler: async (_deps, args) => {
      const name = (args.topic as string) ?? "roadmap";
      const body = topic(name);
      if (!body) return `Unknown topic "${name}". Available: ${TOPIC_NAMES.join(", ")}.`;
      return body;
    },
  },

  {
    name: "scale_assessment",
    title: "Assess the live system's scale + next step",
    description:
      "Inspect the running AdPix install over SSH (current event rate from ClickHouse, total volume + " +
      "on-disk size, host resources), determine which scaling stage it's at, report headroom to the next " +
      "tripwire, and give the single non-disruptive next step. The 'where are we now and what's next' tool.",
    schema: { server: serverParam },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const isRepo = await s.exec(`test -d ${shq(dir + "/.git")} && echo yes || echo no`);
        if (isRepo.stdout.trim() !== "yes") {
          return `No AdPix checkout at ${dir} on ${srv.name} — install it first (adpix_install). For a target-scale plan without a live system, use capacity_plan.`;
        }
        const db = (await readEnvVar(s, dir, "CLICKHOUSE_DB")) || "sovereign";

        // One round-trip for the event counts (subqueries), one for on-disk size, plus host facts.
        const counts = await ch(
          s,
          dir,
          db,
          "SELECT " +
            "(SELECT count() FROM events_local WHERE event_time > now() - INTERVAL 1 HOUR), " +
            "(SELECT count() FROM events_local WHERE event_time > now() - INTERVAL 1 DAY), " +
            "(SELECT count() FROM events_local), " +
            "(SELECT uniqExact(site_id) FROM events_local WHERE event_time > now() - INTERVAL 7 DAY)"
        );
        const disk = await ch(
          s,
          dir,
          db,
          "SELECT formatReadableSize(sum(bytes_on_disk)), round(sum(bytes_on_disk)/1e12,3) " +
            "FROM system.parts WHERE database = currentDatabase() AND table = 'events_local' AND active"
        );
        const host = await s.exec(
          "nproc; free -m | awk '/^Mem:/{print $2,$7}'; df -m / | awk 'NR==2{print $4,$5}'; " +
            `${composeCmd(dir)} ps --format '{{.Service}}' 2>/dev/null | sort -u | tr '\\n' ',' `,
          { timeoutMs: 60_000 }
        );

        if (!counts) {
          return `Connected to ${srv.name} but couldn't read ClickHouse (is the stack up? try health_check). DB tried: ${db}.`;
        }
        const [h1 = "0", d1 = "0", total = "0", sites7 = "0"] = counts.split(/\s+/);
        const [diskHuman = "?", diskTB = "0"] = disk.split(/\s+/);
        const events1h = Number(h1);
        const events24h = Number(d1);
        const epsRecent = events1h / 3600;
        const epsAvg24h = events24h / 86_400;
        const activeSites = Number(sites7);

        const hostLines = host.stdout.trim().split("\n");
        const cores = hostLines[0]?.trim() ?? "?";
        const [memTotal = "?", memAvail = "?"] = (hostLines[1] ?? "").trim().split(/\s+/);
        const [diskFreeMb = "0", diskUsePct = "?"] = (hostLines[2] ?? "").trim().split(/\s+/);
        const services = (hostLines[3] ?? "").replace(/,$/, "");

        const stage = recommendStage(events24h);
        const ceiling = STAGE_CEILINGS.find((c) => c.stage === stage)!;
        const headroomPct =
          ceiling.maxEventsPerDay === Infinity
            ? "n/a (terminal stage)"
            : `${Math.max(0, Math.round((1 - events24h / ceiling.maxEventsPerDay) * 100))}% before the Stage ${stage}→${stage + 1} tripwire`;

        // Project: what would capacity_plan say if today's per-site rate held at the 100k/200k target?
        const projected = computeCapacity({});

        return [
          `# Scale assessment — ${srv.name} (${srv.host})`,
          ``,
          `## Measured now`,
          `- ${fmtInt(events24h)} events in the last 24h  →  ${fmtInt(epsAvg24h)} events/sec avg`,
          `- ${fmtInt(events1h)} events in the last hour  →  ${fmtInt(epsRecent)} events/sec recent`,
          `- ${fmtInt(Number(total))} events total, ${diskHuman} on disk (events_local)`,
          `- ${fmtInt(activeSites)} sites active in the last 7 days`,
          `- host: ${cores} vCPU, ${memTotal}MB RAM (${memAvail}MB free), root disk ${diskUsePct} used (${Math.round(Number(diskFreeMb) / 1024)}GB free)`,
          services ? `- services up: ${services}` : "",
          ``,
          `## You are at Stage ${stage} — ${stageLabel(stage)}`,
          `Headroom: ${headroomPct}.`,
          ``,
          `## Next step (non-disruptive)`,
          nextStepFrom(stage),
          ``,
          `## For context — your stated target (100k sites)`,
          `That projects to ~${fmtInt(projected.eventsPerDay)} events/day → Stage ${projected.recommendedStage}. ` +
            `Run capacity_plan (tune sites/visits/eventsPerVisit) for the full sizing, and consult_topic topic:roadmap for the path there. ` +
            `Nothing on that path requires changing a frozen surface — it's config + topology, by design.`,
        ]
          .filter(Boolean)
          .join("\n");
      });
    },
  },
];
