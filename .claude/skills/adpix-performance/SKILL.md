---
name: adpix-performance
description: High-traffic performance tuning + full-stack optimization for AdPix via the adpix-devops MCP. Use when the site is slow, a datastore is hot, you're planning for a traffic spike, or answering a capacity question. Measure FIRST (performance_report / system_metrics / scale_assessment / capacity_plan / metrics_query), then tune one tier at a time — Postgres (pg_health→pg_tune→pg_optimize), ClickHouse (ch_health→ch_tune→ch_optimize→ch_retention, the cost lever at high event volume), Redis, Kafka (kafka_tune/kafka_lag), and the ingest tier (scale_ingest) — changing ONE lever and re-measuring.
---

# AdPix performance & scale tuning

Prereq: read **adpix-devops**. Tools are deferred — load with `ToolSearch "select:mcp__adpix-devops__<name>"`. Every tune tool is dry-run by default; `apply:true` or `confirm:true` executes (noted per tool). Long ops can drop the transport — run detached (see adpix-devops).

## Golden rule: measure → change ONE lever → re-measure
Never tune blind, never stack changes. Baseline with a measure tool, apply a single setting, re-run the SAME measure tool, keep or revert — then the next lever. Two changes at once and you can't tell which one moved the needle (or broke it).

## 1. Measure first — find the bottlenecked tier
- **performance_report** `runs:5` — loading speed of dashboard / t.js / API / collect from the server (DNS, connect, TLS, TTFB, total, size). The front-door signal; isolates server-side speed from the client's network. Read-only.
- **system_metrics** — host load vs cores, RAM, disk, per-container CPU/RAM, top consumers. Find the hot container. Read-only.
- **scale_assessment** — live event rate + ClickHouse volume/on-disk size + which scaling stage you're at + the single non-disruptive next step. The "where are we now, what's next" tool. Read-only.
- **capacity_plan** `sites:<n>` — pure model, no server: events/sec, CH shards + disk, ingest/worker replicas, Kafka partitions, Postgres at a target scale + cost band. Answer "what will we need at X" and confirm reaching it needs no rewrite.
- **metrics_query** `query:<PromQL>` — instant PromQL against Prometheus on the obs host (usually the witness; run obs_status if it's not answering). Read-only.
- **launch_readiness** — go/no-go gate before a known spike.

Read the verdict, pick the ONE saturated tier, tune only that.

## 2. Co-location invariant (the single-VM trap)
One VM runs Postgres AND ClickHouse (and Redis). Tune each with `coLocated:true` (the default): Postgres gets a ~25% RAM budget, ClickHouse a ~60% ABSOLUTE `max_server_memory_usage` cap. Never hand either the whole host — CH's out-of-box ratio of total host RAM would starve Postgres. Only pass `coLocated:false` if you moved that datastore to a dedicated box (service_relocate).

## 3. Postgres (transactional)
`pg_health` → `pg_tune` → `pg_optimize`.
- **pg_health** — connections vs max, cache-hit ratio, blocked / idle-in-transaction sessions, long queries, dead-tuple bloat, txid wraparound age, replication. Always start here; it names the lever (low cache-hit → pg_tune, bloat → pg_optimize).
- **pg_tune** — pgtune-style diff from memory budget / cores / disk. Dry-run; `apply:true` = ALTER SYSTEM + reload. Settings flagged RESTART? aren't live until `pg_redeploy action:restart` in a quiet window.
- **pg_optimize** — unused/invalid indexes, seq-scan-heavy big tables, bloat, top queries (needs pg_stat_statements). `apply:true` runs an online VACUUM (ANALYZE) on the worst-bloated tables (non-locking); index drops / REINDEX are advised, never auto-run.
- **Known gap — pgbouncer.** pg_health flags ">80% connections — consider pgbouncer", but there is NO pgbouncer tool. Prefer pooling over raising max_connections; stand pgbouncer up by hand for now.

## 4. ClickHouse (analytical — the high-volume tier)
`ch_health` → `ch_tune` → `ch_optimize` → `ch_retention`. This is where event volume bites first.
- **ch_health** — on-disk size, part pressure (parts/partition = merge backlog), in-flight merges + pending mutations, replica status, memory vs the server cap, long queries, recent errors. The verdict points at the lever.
- **ch_tune** — memory cap + thread/pool tuning written as a config.d/users.d drop-in. Dry-run; `apply:true` writes the drop-ins. `max_server_memory_usage` + `background_pool_size` are restart-context — need `ch_redeploy action:recreate`; the tool warns if compose hasn't mounted the drop-in (it mounts single files, not the dir).
- **ch_optimize** — high part-per-partition tables (merges lagging), ReplacingMergeTree dedup debt, low compression, top queries. `apply:true` runs OPTIMIZE FINAL on SMALL tables only (`maxOptimizeGB`, default 5) and refuses if disk/merge headroom is thin. Big tables (events_local) → OPTIMIZE per-partition, off-peak.
- **ch_retention — the single biggest cost + perf lever at scale.** `mode:status` shows per-table size + current TTL; `mode:set-ttl interval:N unit:MONTH confirm:true` shortens retention (previews the rows it would delete first — deletion is IRREVERSIBLE; ch_backup any non-reproducible range first); `mode:drop-partition confirm:true` reclaims one old month immediately. Less data = smaller merges, faster scans, lower disk — tune this before throwing hardware at CH.

## 5. Redis
No dedicated tune tool yet (documented gap). Read it via **system_metrics** (redis container CPU/RAM) and, out of band, `run_command` → `redis-cli INFO memory|stats` (maxmemory, maxmemory-policy, evicted_keys). Set `maxmemory` + an eviction policy in compose/.env by hand. Redis is the shared rate-limit + cache backbone — scale_ingest depends on it (§7), so size it before scaling ingest.

## 6. Kafka (streaming)
For depth, see skill **adpix-kafka**. Performance levers here:
- **kafka_lag** — THE streaming health signal. Rising per-group lag = consumers falling behind (scale consumers or add partitions). Read-only.
- **kafka_tune** `confirm:true` — high-throughput dynamic broker configs (io/network threads, socket buffers, replica fetchers, message.max.bytes, log.segment.bytes). Applied with NO restart; watch heap/disk after.
- **Partitions = the consumer-parallelism lever.** A hot topic can't be consumed faster than its partition count. `kafka_topics action:create ... confirm:true` (or add partitions to an existing topic); `capacity_plan` sizes partitions for a target scale.

## 7. Ingest tier + front door
- **scale_ingest** `replicas:N confirm:true` — horizontally scale the STATELESS collect hot path (3–4 replicas at 200k). Preflights REDIS_URL — without a shared Redis each replica enforces the rate limit independently (≈N× the intended rate), and it refuses. Datastores are untouched; Caddy load-balances across replicas via Docker DNS. This is the ingest lever, not a datastore change.
- **Front door / Node apps** — `performance_report`. If t.js transfers more than a few KB gzipped it flags compression. Caddy already does auto-TLS/HTTP2; the movable part is the Node tier (web / api / ingest) — scale ingest, keep the datastores put.

## 8. Documented gaps — do by hand / defer
From `docs/security-network-review.md` §3, the MCP does NOT yet cover: a continuous autotune loop, pgbouncer, Redis/Varnish tuning, a load-test/benchmark harness, index-from-real-query-patterns, and CDN cache fingerprinting (the stale-tag-JS problem). For a real spike rehearsal there's no built-in load generator — drive load out of band; and fingerprint tag JS at the CDN by hand until a tool exists.

## Related skills
**adpix-monitor** (observability + alerting — where performance_report / system_metrics / metrics_query readings come from) · **adpix-kafka** (streaming deploy / health / lag depth) · adpix-devops (environment + gotchas, detached long runs) · adpix-harden (pg_harden / ch_harden — the security pass, run alongside tuning).
