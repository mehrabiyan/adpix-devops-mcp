/**
 * The AdPix scaling playbook: the staged roadmap and topic deep-dives that the
 * consult_topic tool serves and the infra-consultant agent reasons from. Pure
 * strings — grounded in AdPix's real seams (KAFKA_BROKERS / WORKER_SOURCE,
 * the always-on Postgres outbox backstop, the frozen events_local sort key that
 * already leads with tenant_id, ADR-0012's Flink swap, the single identity-job).
 *
 * Principle behind every stage: AdPix is "v0.1 of a system that scales to
 * millions of sites — same data model, same schemas, same interfaces, swappable
 * executors" (CLAUDE.md / ADR-0001). So scaling is configuration + topology, not
 * a rewrite, and every transition is additive and reversible.
 */

import type { Stage } from "./model.js";

export const PRINCIPLES = `Scaling principles for AdPix (read first):
- Evolutionary, never big-bang. Each stage is one additive step from the last; you
  never refactor from zero. The seams (Kafka transport, ClickHouse cluster, Flink
  stitch, k8s) already exist or are designed in — you turn them on, you don't build them.
- Frozen surfaces stay frozen. events_local row shape + sort key, the Iglu envelope,
  the identity model, the Destination interface, the outbox row shape, UUIDv7. Changing
  any of these needs an ADR — scaling must not. If a "scaling" idea requires changing one,
  it's the wrong idea.
- Zero campaign interruptions. Every cutover runs the new path in parallel with the old
  (dual-write / shadow / replica), diffs them, then flips reads. The old path stays as a
  backstop until you retire it. Schedule cutovers outside campaign windows; pre-scale before.
- Right-size for TODAY. You have 0 customers. Stage 0 is correct now. The point of this
  roadmap is that arriving at 100k–200k sites is a sequence of cheap, boring steps — not a
  reason to over-build or over-spend today.`;

interface StageDoc {
  stage: Stage;
  title: string;
  goodFor: string;
  topology: string;
  trigger: string;
  nonDisruptiveStep: string;
}

export const STAGES: StageDoc[] = [
  {
    stage: 0,
    title: "Stage 0 — Single VM (where you are today)",
    goodFor: "0 → ~5M events/day, dozens–hundreds of sites. Demos, first customers, campaigns at low volume.",
    topology:
      "One VM, `compose.prod.yaml`: Caddy + ingest + api + web + worker + identity-job + Postgres + ClickHouse, all co-located. Outbox transport (no Kafka). The adpix-devops watchdog + nightly backups + pull-based CI/CD already give you self-healing and safe deploys here.",
    trigger:
      "Move on when ANY holds for a sustained period: CPU load > cores for hours; RAM headroom < 10%; disk > 70%; `sov_ch_wal_pending` > 0 in steady state (CH can't keep up with inserts); p95 collect latency creeping toward the 0.15s alert.",
    nonDisruptiveStep:
      "First just scale UP the VM (more vCPU/RAM/NVMe) — it's a reboot, do it off-campaign. That alone carries you a long way and buys time to plan Stage 1.",
  },
  {
    stage: 1,
    title: "Stage 1 — Vertical + split the data tier",
    goodFor: "~5M → ~50M events/day. First serious traffic; you want the DBs to stop competing with app CPU.",
    topology:
      "Keep one app VM, but move Postgres and ClickHouse onto their own VMs (or managed Postgres). Add a Postgres read-replica and point reporting reads at it. Turn on off-host encrypted backups (BACKUP_AGE_RECIPIENT + BACKUP_SYNC_DEST, already in backup.sh). Still outbox transport, still single CH node.",
    trigger:
      "Move on when one app box can't absorb peak collect throughput, OR a single CH node's inserts/merges fall behind at peak, OR you need real HA (no single point of failure) for an SLA.",
    nonDisruptiveStep:
      "Add the Postgres replica first (streaming replication, zero write downtime), cut report reads over to it, then split CH onto its own host by backup→restore during a low window with the tracker buffering (ingest WAL + returns 200, so no events are lost).",
  },
  {
    stage: 2,
    title: "Stage 2 — Horizontal stateless + Kafka transport + PG replica",
    goodFor: "~50M → ~300M events/day. Multiple app instances, durable event bus, HA on the stateless tier.",
    topology:
      "Run N replicas each of ingest/api/web behind a load balancer (Caddy round-robin, a cloud LB, or k8s later). Turn ON the Kafka seam: set `KAFKA_BROKERS` (3 brokers, RF=3, min.insync.replicas=2) and `WORKER_SOURCE=kafka`; the worker becomes a consumer group you can scale out. Add pgbouncer in front of Postgres; keep the primary + replica. ClickHouse is still one big node (+ a replica for HA).",
    trigger:
      "Move on when a single ClickHouse node can't hold the data (disk) or serve query concurrency across tenants, OR the nightly identity-job runtime approaches its window, OR you need HA on the data tier.",
    nonDisruptiveStep:
      "Kafka is the marquee move and it's zero-risk by design: the Postgres `core.webhook_outbox` is written even when Kafka is live, so flip `WORKER_SOURCE=kafka` with the outbox as an instant rollback. Scale ingest/api by just adding replicas (they're stateless; WAL is per-instance buffer, not shared state).",
  },
  {
    stage: 3,
    title: "Stage 3 — Clustered data (ClickHouse cluster + Flink stitch + PG HA)",
    goodFor: "~300M → ~2B events/day. THIS is your 100k–200k-sites tier. Sharded storage, distributed stitching, HA databases.",
    topology:
      "ClickHouse cluster: `ReplicatedReplacingMergeTree` + `Distributed` tables over the *_local tables, 3-node Keeper for consensus, shard by a tenant-derived key (the frozen sort key already leads with tenant_id, so tenant reads stay on one shard and stay cheap). Move sessionization + identity stitching to Flink per ADR-0012 (shadow → diff → retire), which also removes the single identity-job as a scaling limit. Postgres HA via Patroni/managed with automatic failover; partition/archive identity_edges (fp_* edges already TTL 30d).",
    trigger:
      "Move on when you need elastic autoscaling, self-healing across nodes, multi-AZ HA, or rolling zero-downtime deploys as a routine — i.e. ops toil and availability targets, not raw throughput.",
    nonDisruptiveStep:
      "Stand the CH cluster up alongside the single node; backfill with `INSERT … SELECT … FROM remote(old_node)` per partition, dual-write new data, diff counts per tenant/day, then flip API reads to the Distributed table and retire the single node. events_local stays byte-identical (frozen), so every existing report keeps working untouched.",
  },
  {
    stage: 4,
    title: "Stage 4 — Kubernetes, multi-AZ, full HA",
    goodFor: "~2B events/day and beyond, or whenever availability/ops demands it. Elastic, self-healing, multi-region optional.",
    topology:
      "k3s/Helm (named as the v1 target in ADR-0001). Stateless services as Deployments with HPA on CPU + a custom `sov_collect_latency`/lag metric. ClickHouse via the Altinity operator (replicated, multi-AZ), Kafka via Strimzi (RF=3 across AZs), Postgres operator with sync replica + failover. ClickHouse cold tier on object storage (S3-backed disk) so long retention is cheap. Optional multi-region for the ingest edge.",
    trigger: "Terminal stage — you scale within it (more shards/replicas/nodes), you don't migrate off it.",
    nonDisruptiveStep:
      "Lift-and-shift in order, each blue-green: stateless services first (run k8s ingest/api alongside the VMs, shift the LB/DNS weight gradually), then Kafka, then the data tier last via replication-based cutover. The container images are the same ones Compose builds — k8s is a scheduler swap, not a rewrite.",
  },
];

export function nextStepFrom(stage: Stage): string {
  const cur = STAGES.find((s) => s.stage === stage);
  const next = STAGES.find((s) => s.stage === ((stage + 1) as Stage));
  if (!cur) return "Unknown stage.";
  if (!next) return `${cur.title}: ${cur.nonDisruptiveStep}`;
  return (
    `You're at ${cur.title}.\nNext non-disruptive step toward ${next.title}:\n  ${cur.nonDisruptiveStep}\n\n` +
    `That moves you toward:\n  ${next.topology}`
  );
}

export function roadmap(): string {
  return [
    PRINCIPLES,
    "",
    "# Staged scaling roadmap",
    ...STAGES.map(
      (s) =>
        `\n## ${s.title}\n` +
        `Good for: ${s.goodFor}\n` +
        `Topology: ${s.topology}\n` +
        `Move on when: ${s.trigger}\n` +
        `Next step (non-disruptive): ${s.nonDisruptiveStep}`
    ),
  ].join("\n");
}

export const TOPICS: Record<string, string> = {
  "ha-topology": `High-availability topology for AdPix, per tier:
- Stateless (ingest, api, web, caddy): HA is just N≥2 replicas behind a load balancer. The
  tracker never throws and ingest returns 200 + buffers to its WAL, so a replica dying loses
  nothing in flight. This is the cheapest HA win — do it at Stage 2.
- ClickHouse: ReplicatedReplacingMergeTree with ≥2 replicas per shard + a 3-node Keeper
  quorum. A replica can die with no data loss or read interruption (Distributed routes around it).
- Postgres: one primary + a synchronous (or async) replica with automatic failover
  (Patroni / pg_auto_failover / managed). pgbouncer in front so failover is a brief pause, not
  an app reconfigure.
- Kafka: 3 brokers, replication.factor=3, min.insync.replicas=2 — survives one broker.
- worker: consumer group with ≥2 members; deliveries are idempotent so redelivery is safe.
- identity-job: the ONE hard single-instance (concurrent runs corrupt the union-find). For HA
  give it leader election (a k8s Lease, or an advisory lock) so exactly one runs — OR retire it
  in favour of the Flink streaming stitch (ADR-0012), which is inherently distributed. See
  topic 'identity-job-ha'.
The rule: there must be no tier where losing one node loses data or stops ingestion. Walk the
list and make each tier N≥2 with a quorum/failover story before you claim an SLA.`,

  kubernetes: `Kubernetes for AdPix (Stage 4 — adopt for elasticity/HA/ops, not for raw throughput):
- The same container images Compose builds run unchanged; k8s replaces the scheduler, not the app.
- Stateless: Deployments + HPA. Scale ingest on a custom metric (events/sec or sov_ch_wal_pending),
  not just CPU, because the hot path is I/O-bound on CH. api/web scale on CPU + p95 latency.
- ClickHouse: use the Altinity clickhouse-operator (handles Replicated tables, Keeper, shard/replica
  topology, rolling restarts). Don't hand-roll StatefulSets for CH.
- Kafka: Strimzi operator (RF=3 across AZs, rack-awareness).
- Postgres: an operator (CloudNativePG / Zalando) with a sync replica + failover.
- identity-job: a CronJob (not a Deployment) with concurrencyPolicy: Forbid — that gives you the
  single-runner guarantee for free.
- Migration is blue-green and gradual (see 'zero-downtime-migration'): stateless first by shifting
  LB/DNS weight, data tier last via replication cutover. Start with k3s (lightweight, ADR-0001's
  named target); a managed control plane is fine too. Don't go to k8s before Stage 3 — it adds ops
  surface you don't need at low volume.`,

  docker: `Docker / Compose for AdPix (Stages 0–2):
- Stage 0–1 is pure Compose (compose.yaml + compose.prod.yaml). Keep it; it's the right tool until
  you need cross-host scheduling. Caddy is the only published service (80/443); everything else is
  on the internal network — keep it that way (a dev stack exposing Postgres/ClickHouse is the #1
  finding security_audit catches).
- Horizontal scale within Compose is limited (single host). You can run multiple ingest replicas with
  'deploy.replicas' + Caddy load-balancing for a while, but multi-host is the signal to move to k8s.
- Pin image versions for reproducible rollbacks; the CI/CD I installed already does backup→deploy→
  health-gate→rollback. Set memory/CPU limits per service so one runaway container can't starve CH/PG.
- Use named volumes for pgdata/clickhouse (never bind-mount onto the root disk) and put them on
  fast NVMe; ClickHouse merge performance is disk-bound.`,

  "clickhouse-cluster": `Scaling ClickHouse from single node to cluster (Stage 3):
- Today: single-node ReplacingMergeTree. events_local sort key (tenant_id, event_time, event_name,
  distinct_id) is FROZEN and already tenant-leading — perfect for sharding by a tenant hash, because
  every tenant-scoped report (all of them) prunes to one shard.
- Target: ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/{table}','{replica}') for the
  *_local tables + a Distributed table per *_local that the API reads. 3-node Keeper for consensus.
  Shard count and replica count come from capacity_plan (disk drives shards, RF=2 for HA).
- Keep the version column semantics identical (ReplacingMergeTree dedups on the engine version;
  reads stay FINAL/argMax-safe). Do NOT change the row shape — that's a frozen surface needing an ADR.
- Cutover (zero downtime): create the cluster alongside; backfill historical partitions with
  INSERT…SELECT FROM remote(old); dual-write live data to both; diff count()/tenant/day until equal;
  flip API to the Distributed table; keep the old node a few days as rollback; then retire.
- Cost lever: at 1–2B events/day, retention dominates everything. Shorten hot events_local retention
  (e.g. 90d) and lean on the existing daily_metrics rollup MV for long-range reports; move cold parts
  to an S3-backed disk (storage policy / TTL ... TO VOLUME 'cold'). See 'cost-optimization'.`,

  "postgres-ha": `Postgres scaling + HA for AdPix:
- Postgres is transactional truth (tenants, sites, api_keys, the identity graph, webhook_outbox).
  It is NOT on the per-event hot path — ingest writes events to ClickHouse, and to Postgres only for
  identity upserts and (if destinations are on) outbox rows. So Postgres scales later and gentler than CH.
- Reads: add a streaming read-replica (Stage 1) and route reporting/admin reads to it via a separate
  DSN. Writes stay on the primary.
- Connections: put pgbouncer (transaction pooling) in front once you have many app replicas, so
  connection count doesn't explode.
- HA: primary + replica with automatic failover (Patroni / pg_auto_failover / managed). With pgbouncer,
  failover is a short pause, not an app change.
- Growth: identity_edges grows with unique users; fp_* edges already TTL 30d. At Stage 3 partition or
  archive cold edges, and let the Flink stitch (ADR-0012) reduce write pressure from the nightly job.`,

  kafka: `Kafka transport (Stage 2 — already built, opt-in):
- The seam exists: set KAFKA_BROKERS to enable dual-write, WORKER_SOURCE=kafka to make the worker a
  consumer group. ingest publishes 'events' (enriched, for Flink) and 'destination_events' (for the worker).
- It's safe by construction: core.webhook_outbox in Postgres is written even when Kafka is live, so it's
  a permanent backstop and an instant rollback (flip WORKER_SOURCE back to outbox).
- Sizing: partitions ≈ peak events/sec ÷ ~5k, min 12; 3 brokers, RF=3, min.insync.replicas=2 for HA.
  Key by site/tenant so per-tenant ordering holds and consumers parallelize.
- Why: it decouples ingest spikes from downstream processing (campaign bursts buffer in Kafka instead of
  backpressuring collect), and it's the input Flink needs for streaming sessionization/stitch at Stage 3.`,

  "zero-downtime-migration": `Zero-downtime / no-campaign-interruption cutovers — the universal pattern:
1. Run the new path in PARALLEL with the old (dual-write, shadow, or a replica). Nothing reads it yet.
2. BACKFILL history into the new path (INSERT…SELECT for CH; base backup for PG; replay for Kafka).
3. DIFF old vs new until they agree (per-tenant/day count() for CH; ADR-0012's parity gate for Flink).
4. FLIP reads to the new path behind config/LB/DNS — a setting change, not a redeploy.
5. KEEP the old path as a hot backstop for days; only then RETIRE it.
This works because AdPix's frozen surfaces guarantee the new path produces byte-identical rows, and the
outbox/WAL buffer in-flight work during the flip.
Campaign protection: (a) freeze infra changes during campaign windows; (b) pre-scale BEFORE the campaign
using capacity_plan's projected peak (don't autoscale into a spike from cold); (c) the watchdog +
CD rollback I installed catch a bad deploy automatically; (d) ingest returns 200 + WALs, so even a brief
backend wobble never breaks the customer's page or drops events.`,

  "cost-optimization": `Cost control at scale (the bill is dominated by ClickHouse storage, then compute):
- Retention is lever #1. At 1–2B events/day the frozen 25-month events_local TTL is tens of TB; capacity_plan
  prints both the chosen-retention and full-TTL TB so you can see it. Shorten HOT raw retention (e.g. 90d)
  and serve long-range reports from the daily_metrics rollup MV — which already exists, so this costs no
  rewrite. Move cold parts to S3-backed storage (cheap) via a CH storage policy.
- Right-size, don't over-provision. You have 0 customers — stay at Stage 0 ($20–40/mo). Each stage is a
  cheap step taken only when a tripwire trips (scale_assessment tells you which).
- Reserved/committed-use discounts on the steady data tier (CH/PG/Kafka) once load is predictable; keep the
  elastic stateless tier on-demand/spot.
- Compression: ensure LowCardinality on tenant_id/site_id/channel/country (the schema already does) — it's
  free disk savings. Don't store raw_events_jsonl longer than you need to rebuild from.`,

  "identity-job-ha": `Making identity resolution scale + HA (the one hard single-instance):
- identity-job runs a nightly union-find over all tenants' identity_edges. Two copies running at once would
  corrupt the graph, so it must stay single-runner. At low scale that's fine (it's nightly).
- Scaling limit: as edges grow, the nightly run lengthens toward its window (watch adpix_identity_duration_seconds
  vs IDENTITY_RECONCILE_SEC, and the IdentityJobStale alert).
- Two ways forward, both already designed:
  (a) Keep the batch job but give it leader election for HA — a k8s CronJob with concurrencyPolicy: Forbid, or
      a Postgres advisory lock so exactly one instance runs.
  (b) Move stitching to the Flink streaming job (ADR-0012): it's distributed, incremental (no nightly cliff),
      and passes a parity gate against the Go reference before cutover. This is the Stage 3 answer.
- Either way the identity model is a FROZEN surface and the 6 invariants hold (deterministic ≥0.90 never
  overridden by probabilistic, monotonic version, fp_* TTL 30d, reversible merges) — scaling changes the
  executor, never the model. Loop in the identity-reviewer agent for any change here.`,

  "campaign-readiness": `Getting ready for a marketing campaign without interruption:
1. Project the peak: run capacity_plan with the campaign's expected sites/visits and a higher peakFactor;
   it tells you the events/sec and which components need headroom.
2. Pre-scale BEFORE the campaign, not during: add ingest replicas / bump the VM / raise rate limits ahead
   of time. Autoscaling reacts late to a sharp spike — provision for the known peak up front.
3. Freeze changes: no infra migrations or risky deploys during the campaign window. CI/CD can keep shipping
   app changes (it has backup + health-gate + auto-rollback), but pause structural moves.
4. Watch the tripwires live: sov_ch_wal_pending (CH falling behind), sov_ratelimited_total (legit traffic
   getting throttled — raise RATE_RPS/RATE_BURST per site key), sov_collect_latency p95.
5. Safety nets already on: ingest returns 200 + WAL buffers, the watchdog self-heals/restarts, Kafka (if on)
   absorbs bursts. The customer's page never breaks and no events drop even if a backend briefly lags.`,
};

export const TOPIC_NAMES = ["roadmap", ...Object.keys(TOPICS)] as const;
export type TopicName = (typeof TOPIC_NAMES)[number];

export function topic(name: string): string | undefined {
  if (name === "roadmap") return roadmap();
  return TOPICS[name];
}
