---
name: adpix-kafka
description: Deploy, operate, and scale KRaft (ZooKeeper-free) Kafka for the AdPix streaming pipeline via the adpix-devops MCP. Use when standing up / scaling / diagnosing Kafka, when consumer lag is rising, or when designing a topic. Covers kafka_deploy (loopback listener, brokers 1 vs on-host 3 vs real cross-host HA; confirm), kafka_health (under-replicated + offline partitions), kafka_topics (RF≥3 / min.insync=2 / compression / retention; create=confirm), kafka_lag (the pipeline health signal), and kafka_tune (dynamic high-throughput configs; confirm).
---

# AdPix Kafka (KRaft streaming) — deploy, operate, scale

Prereq: read **adpix-devops**. Tools: `kafka_deploy` (confirm), `kafka_health`, `kafka_topics` (create=confirm), `kafka_lag`, `kafka_tune` (confirm) — load via ToolSearch. KRaft, **no ZooKeeper**; image `apache/kafka:3.9.0` (docker.io); data lives at `/opt/adpix-kafka` in a **named volume — never delete it** (it's the log; deleting loses every retained event). Prefer these tools over raw `run_command` — they run the broker CLI inside the container with the right bootstrap.

## When
- Stand up / scale / diagnose the streaming pipeline (ingest → Kafka → worker → ClickHouse).
- Consumer lag climbing, or a service reports it's behind → `kafka_lag`, then act.
- Designing a topic (partitions / RF / retention) → `kafka_topics`.

## Deploy — kafka_deploy (confirm:true)
Dry-run (no confirm) prints the compose; `confirm:true` writes it, brings the broker up, and formats KRaft storage. Re-deploy never touches the data volume.
- **External listener is LOOPBACK-only by default** (`127.0.0.1:19092`). **Never** `bindPublic:true` in prod — it publishes PLAINTEXT with no auth on `0.0.0.0`. Public exposure requires SASL/TLS, which this compose does not set up.
- `brokers=1` (default) = single-node (dev / one box). `brokers=3` puts 3 broker+controller procs on **one host** = HA *rehearsal* only — shared fate, a host loss takes all 3. **Real HA spreads brokers across hosts** (a `kafka_deploy` per host, voters wired between them); one call can't do that.
- Deploy sets RF=min(brokers,3), min.insync=2 when brokers≥3 (else 1), auto-create-topics OFF, retention 168h, 6 default partitions, and high-throughput thread/socket/fetcher tuning.
- Egress-blocked node can't pull `apache/kafka:3.9.0` from docker.io → relay it (see **adpix-offline-build**), then re-run.
- After up: `kafka_health` → `kafka_topics` → `kafka_lag`.

## Health — kafka_health (read-only)
The at-a-glance signals. Verdict HEALTHY / DEGRADED / DOWN.
- **Offline/unavailable partitions > 0 → DOWN** — a partition has no leader; data is unavailable. Page.
- **Under-replicated partitions (URP) > 0 → DEGRADED** — a replica is behind ISR; check broker health + disk before it becomes offline.
- Also reports: broker API reachable, KRaft controller quorum (LeaderId / CurrentVoters / MaxFollowerLag), topic count, log-dir disk. Filling disk → fix retention / segment sizing or add capacity.

## Topics — kafka_topics (create=confirm:true)
- `action=list` and `describe topic=<name>` are read-only. `create` needs `topic=<name>` + `confirm:true`.
- **Durable prod-topic defaults: RF≥3, min.insync.replicas=2, compression, retention.** create auto-sets min.insync=2 when RF≥3 (else 1); RF>broker-count can't be satisfied.
- **Partitions = your consumer-parallelism ceiling** — a group can't have more active consumers than partitions. Size for peak + headroom. You can add partitions but never remove them, and adding breaks key→partition ordering.
- **RF / min.insync tradeoff:** RF=3 + min.insync=2 tolerates 1 broker down and still accepts `acks=all` writes (durable). Lose 2 → producers get NotEnoughReplicas and writes block — durability over availability, by design. Lower min.insync only if you accept weaker durability.

## Lag — kafka_lag (read-only, the pipeline health signal)
- `group=<name>` or omit for all groups. Reports per-group total lag, worst-partition lag, and partition count; flags groups over 100k as falling behind.
- **Rising lag = consumers can't keep up.** Fixes, in order: 1) scale consumers (add instances, up to #partitions); 2) already at #partitions → add partitions (`kafka_topics`, future messages only) then scale consumers; 3) speed the consumer / downstream — often ClickHouse insert throughput (see **adpix-performance**).
- Flat/zero lag = keeping up. No active groups = no consumers have committed offsets yet.

## Tune — kafka_tune (confirm:true)
- Dry-run shows current dynamic broker configs + the high-throughput recommendation (num.io.threads, num.network.threads, socket buffers, num.replica.fetchers, message.max.bytes, log.segment.bytes, compression). `confirm:true` applies them as **DYNAMIC broker defaults via kafka-configs.sh — no restart.**
- Raises throughput + max message size → watch heap/disk after (`kafka_health` under load).
- Topic-level retention/compression stay per-topic (`kafka_topics`), not here.

## SRE notes
- Monitor continuously: URP + offline (`kafka_health`) and per-group lag (`kafka_lag`) are the two signals that matter — wire them into **adpix-monitor**.
- Capacity: partitions × RF × retention drives disk; message.max.bytes / segment size drive memory. Plan before a traffic spike, not during.
- The broker volume (`broker_data` / `brokerN_data`) is destructive to remove — never `docker volume rm` it.

## Related skills
`adpix-performance` (consumer / ClickHouse throughput when lag won't drain) · `adpix-monitor` (dashboard URP + lag) · `adpix-offline-build` (relay `apache/kafka:3.9.0` to an egress-blocked node).
