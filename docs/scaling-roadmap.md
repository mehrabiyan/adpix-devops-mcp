# Scaling roadmap (single VM → hyperscale)

Reference for taking AdPix from today (0 customers, one VM) to the projected
target (**100k–200k sites × ~1k visits/day**, ≈0.5–2B events/day) **without a
rewrite and without interrupting marketing campaigns**.

This is a human-readable companion to the live tooling. For numbers and
step-by-step guidance, use the **adpix-devops MCP** consultation tools
(`capacity_plan`, `scale_assessment`, `consult_topic`) and the **`infra-consultant`**
agent (`.claude/agents/infra-consultant.md`) — they compute sizing against the real
system and this same model.

## Why this isn't a rewrite

AdPix is "v0.1 of a system that scales to millions of sites — same data model,
same schemas, same interfaces, swappable executors" (ADR-0001). The scale seams
already exist or are designed in:

- **Transport**: the Kafka seam is built and opt-in — set `KAFKA_BROKERS` to
  dual-write and `WORKER_SOURCE=kafka` to make the worker a consumer group. The
  Postgres `core.webhook_outbox` is written even when Kafka is live, so it's a
  permanent backstop and an instant rollback.
- **ClickHouse**: the FROZEN `events_local` sort key already leads with
  `tenant_id`, so sharding by a tenant hash keeps every (tenant-scoped) report on
  one shard. The cluster move is `ReplicatedReplacingMergeTree` + `Distributed`
  tables + Keeper — no row-shape change.
- **Stream processing**: ADR-0012 defines the Flink swap for sessionization +
  identity stitching, with a shadow→diff→retire parity gate, replacing the single
  nightly `identity-job` as a scaling limit.
- **Orchestration**: k3s/Helm is the named Stage-4 target; the same container
  images Compose builds run unchanged under Kubernetes.

**Principle:** scaling is configuration + topology, never a frozen-surface change
(`events_local` shape/sort key, Iglu envelope, identity model, `Destination`
interface, outbox shape, UUIDv7). If a scaling idea needs an ADR, it's wrong.

## The stages

| Stage | Topology | Good for (events/day) | Rough $/mo |
| --- | --- | --- | --- |
| **0 — Single VM** | Everything on one box (`compose.prod.yaml`) + the devops watchdog, backups, CI/CD. **You are here.** | 0 → ~5M | $20–40 |
| **1 — Split data tier** | Postgres + ClickHouse on their own hosts; PG read-replica; off-host encrypted backups. | ~5M → ~50M | $80–250 |
| **2 — Horizontal + Kafka** | N× stateless ingest/api/web behind an LB; Kafka transport on (3 brokers, RF=3); worker as a consumer group; pgbouncer + PG replica. | ~50M → ~300M | $500–1.5k |
| **3 — Clustered data** | ClickHouse cluster (Replicated + Distributed + Keeper, sharded by tenant); Flink stitch (ADR-0012); Postgres HA + failover. **The 100k–200k tier.** | ~300M → ~2B | $3k–8k |
| **4 — Kubernetes multi-AZ** | k3s/Helm; HPA on stateless; CH/Kafka/PG operators; object-storage cold tier; optional multi-region. | ~2B+ | $8k–25k |

Each stage is entered only when a tripwire trips (CPU/RAM/disk headroom,
`sov_ch_wal_pending` in steady state, p95 collect latency, identity-job runtime vs
its window). `scale_assessment` reports the current stage and the nearest tripwire.

## Zero-downtime / no-campaign-interruption cutovers

Every data-tier move follows one pattern: **run new in parallel → backfill → diff →
flip reads → keep old as backstop → retire.** It's safe because frozen surfaces
guarantee byte-identical rows on the new path, and ingest returns 200 + buffers to
its WAL so in-flight events are never lost during a flip. Structural changes are
frozen during campaigns; capacity is provisioned ahead of a known spike (size it
with `capacity_plan` at a higher `peakFactor`).

## High availability, per tier

- **Stateless** (ingest/api/web/caddy): N≥2 behind an LB — the cheapest HA win.
- **ClickHouse**: ≥2 replicas/shard + 3-node Keeper quorum.
- **Postgres**: primary + replica with automatic failover, pgbouncer in front.
- **Kafka**: 3 brokers, RF=3, `min.insync.replicas=2`.
- **worker**: consumer group ≥2 (deliveries are idempotent).
- **identity-job**: the one hard single-instance — give it leader election (k8s
  CronJob `concurrencyPolicy: Forbid`, or a Postgres advisory lock) **or** retire it
  for the Flink stitch. See `consult_topic topic:identity-job-ha`.

## The dominant cost lever

At 1–2B events/day, ClickHouse storage dominates. The frozen 25-month
`events_local` TTL would be tens of TB; shorten **hot** retention and serve
long-range reports from the existing `daily_metrics` rollup MV, tiering cold parts
to object storage. None of this changes a frozen surface. See
`consult_topic topic:cost-optimization`.
