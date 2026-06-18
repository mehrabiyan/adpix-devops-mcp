/**
 * Capacity model for the AdPix analytics stack. Pure functions, no I/O — given a
 * target scale it derives load and per-component sizing, so it runs identically
 * from the capacity_plan tool (any client) and inside scale_assessment (which
 * feeds it live numbers measured over SSH).
 *
 * Every constant is a documented planning estimate, deliberately conservative.
 * They're collected in PLANNING_CONSTANTS and overridable per call so the model
 * stays honest rather than falsely precise.
 */

export interface PlanningConstants {
  /** events_local on disk after compression (LowCardinality + sorted), bytes/row. */
  bytesPerEventCompressed: number;
  /** raw_events_jsonl archive after compression, bytes/row. */
  bytesPerRawEventCompressed: number;
  /** One Go ingest replica + batched ClickHouse insert, sustained events/sec. */
  ingestEpsPerReplica: number;
  /** Run ingest replicas at this utilization so spikes have headroom. */
  ingestTargetUtil: number;
  /** One ClickHouse shard sustains this many inserts/sec comfortably. */
  chInsertEpsPerShard: number;
  /** Usable disk per ClickHouse shard before adding another shard (TB). */
  perShardUsableDiskTB: number;
  /** One Kafka partition sustains this many events/sec. */
  kafkaEpsPerPartition: number;
  /** Postgres write txns per visit (identity upsert + occasional outbox), not per event. */
  pgWritesPerVisit: number;
  /** One worker replica delivers this many destination events/sec. */
  workerEpsPerReplica: number;
}

export const PLANNING_CONSTANTS: PlanningConstants = {
  bytesPerEventCompressed: 80,
  bytesPerRawEventCompressed: 250,
  ingestEpsPerReplica: 8_000,
  ingestTargetUtil: 0.6,
  chInsertEpsPerShard: 60_000,
  perShardUsableDiskTB: 3,
  kafkaEpsPerPartition: 5_000,
  pgWritesPerVisit: 0.3,
  workerEpsPerReplica: 3_000,
};

export interface ScaleInputs {
  sites: number;
  visitsPerSitePerDay: number;
  /** Events per visit/session (pageview + interactions). */
  eventsPerVisit: number;
  /** peak events/sec ÷ average events/sec (diurnal + campaign concentration). */
  peakFactor: number;
  /** Hot raw retention for events_local, days. Long-term lives in rollup MVs. */
  retentionDays: number;
  /** ClickHouse replicas per shard (HA). */
  replicationFactor: number;
  /** Are webhook destinations / the outbox active (drives worker + Kafka sizing)? */
  destinationsEnabled: boolean;
}

export const DEFAULT_INPUTS: ScaleInputs = {
  sites: 100_000,
  visitsPerSitePerDay: 1_000,
  eventsPerVisit: 5,
  peakFactor: 4,
  retentionDays: 90,
  replicationFactor: 2,
  destinationsEnabled: true,
};

export type Stage = 0 | 1 | 2 | 3 | 4;

/** events/day thresholds where the topology must evolve (upper bound of each stage). */
export const STAGE_CEILINGS: { stage: Stage; maxEventsPerDay: number; label: string }[] = [
  { stage: 0, maxEventsPerDay: 5_000_000, label: "Single VM (Compose)" },
  { stage: 1, maxEventsPerDay: 50_000_000, label: "Vertical + split data tier" },
  { stage: 2, maxEventsPerDay: 300_000_000, label: "Horizontal stateless + Kafka + PG replica" },
  { stage: 3, maxEventsPerDay: 2_000_000_000, label: "Clustered data (CH cluster + Flink + PG HA)" },
  { stage: 4, maxEventsPerDay: Number.POSITIVE_INFINITY, label: "Kubernetes multi-AZ HA" },
];

export function recommendStage(eventsPerDay: number): Stage {
  for (const s of STAGE_CEILINGS) if (eventsPerDay <= s.maxEventsPerDay) return s.stage;
  return 4;
}

export function stageLabel(stage: Stage): string {
  return STAGE_CEILINGS.find((s) => s.stage === stage)?.label ?? "unknown";
}

/** Rough self-hosted commodity-cloud monthly cost band per stage (USD). Caveat-heavy. */
export const STAGE_COST_USD: Record<Stage, [number, number]> = {
  0: [20, 40],
  1: [80, 250],
  2: [500, 1_500],
  3: [3_000, 8_000],
  4: [8_000, 25_000],
};

export interface CapacityPlan {
  inputs: ScaleInputs;
  eventsPerDay: number;
  avgEps: number;
  peakEps: number;
  pgPeakWritesPerSec: number;
  ingestReplicas: number;
  chShards: number;
  chReplicasPerShard: number;
  chNodesTotal: number;
  chShardsByInsert: number;
  chShardsByDisk: number;
  eventsLocalTB: number;
  eventsLocalTBReplicated: number;
  rawArchiveTBPerMonth: number;
  fullTtlEventsLocalTB: number; // if the frozen 25-month TTL were kept at this volume
  kafkaPartitions: number;
  workerReplicas: number;
  recommendedStage: Stage;
  costBandUsd: [number, number];
}

const ceilMin = (v: number, min: number) => Math.max(min, Math.ceil(v));

export function computeCapacity(
  partial: Partial<ScaleInputs> = {},
  k: PlanningConstants = PLANNING_CONSTANTS
): CapacityPlan {
  const inputs: ScaleInputs = { ...DEFAULT_INPUTS, ...partial };
  const { sites, visitsPerSitePerDay, eventsPerVisit, peakFactor, retentionDays, replicationFactor, destinationsEnabled } = inputs;

  const visitsPerDay = sites * visitsPerSitePerDay;
  const eventsPerDay = visitsPerDay * eventsPerVisit;
  const avgEps = eventsPerDay / 86_400;
  const peakEps = avgEps * peakFactor;
  const pgPeakWritesPerSec = ((visitsPerDay * k.pgWritesPerVisit) / 86_400) * peakFactor;

  const ingestReplicas = ceilMin(peakEps / (k.ingestEpsPerReplica * k.ingestTargetUtil), 2);

  const eventsLocalTB = (eventsPerDay * k.bytesPerEventCompressed * retentionDays) / 1e12;
  const eventsLocalTBReplicated = eventsLocalTB * replicationFactor;
  const fullTtlEventsLocalTB = (eventsPerDay * k.bytesPerEventCompressed * 760) / 1e12; // ~25 months
  const rawArchiveTBPerMonth = (eventsPerDay * k.bytesPerRawEventCompressed * 30) / 1e12;

  const chShardsByInsert = ceilMin(peakEps / k.chInsertEpsPerShard, 1);
  const chShardsByDisk = ceilMin(eventsLocalTBReplicated / k.perShardUsableDiskTB, 1);
  const chShards = Math.max(chShardsByInsert, chShardsByDisk, 1);
  const chReplicasPerShard = replicationFactor;
  const chNodesTotal = chShards * chReplicasPerShard;

  const kafkaPartitions = ceilMin(peakEps / k.kafkaEpsPerPartition, 12);
  const workerReplicas = destinationsEnabled ? ceilMin(peakEps / k.workerEpsPerReplica, 2) : 1;

  const recommendedStage = recommendStage(eventsPerDay);

  return {
    inputs,
    eventsPerDay,
    avgEps,
    peakEps,
    pgPeakWritesPerSec,
    ingestReplicas,
    chShards,
    chReplicasPerShard,
    chNodesTotal,
    chShardsByInsert,
    chShardsByDisk,
    eventsLocalTB,
    eventsLocalTBReplicated,
    rawArchiveTBPerMonth,
    fullTtlEventsLocalTB,
    kafkaPartitions,
    workerReplicas,
    recommendedStage,
    costBandUsd: STAGE_COST_USD[recommendedStage],
  };
}
