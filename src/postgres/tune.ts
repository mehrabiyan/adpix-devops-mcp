/**
 * Postgres tuning model. Pure functions — given a memory budget, cores, expected
 * connections and disk type it returns recommended settings for AdPix's workload
 * (transactional "truth" DB: OLTP/web profile, NOT a warehouse — ClickHouse is the
 * analytical tier). Values follow the well-known pgtune heuristics, adapted with
 * one AdPix-specific rule: at Stage 0/1 Postgres is CO-LOCATED with ClickHouse +
 * the app on one box, so it must be given a *budget*, never the whole host — CH
 * needs the lion's share of RAM. The budget is an explicit input for that reason.
 */

export interface TuneInput {
  /** RAM (MB) dedicated to Postgres — NOT total host RAM on a co-located box. */
  memoryBudgetMB: number;
  cores: number;
  /** Expected max client connections (prefer pgbouncer over raising this). */
  maxConnections: number;
  diskType: "ssd" | "hdd";
}

export interface Recommendation {
  key: string;
  value: string;
  /** true → takes effect only after a restart (postmaster context). */
  needsRestart: boolean;
  rationale: string;
}

/** Render an MB amount as a Postgres size literal (e.g. 1536 → "1536MB", 2048 → "2GB"). */
export function mbToPg(mb: number): string {
  const m = Math.max(1, Math.round(mb));
  return m % 1024 === 0 ? `${m / 1024}GB` : `${m}MB`;
}

const RESTART_KEYS = new Set([
  "shared_buffers",
  "max_connections",
  "wal_buffers",
  "max_worker_processes",
]);

/**
 * Compute recommended settings. Deterministic and unit-tested; the pg_tune tool
 * diffs these against the live `SHOW`n values and (optionally) applies them via
 * ALTER SYSTEM + pg_reload_conf.
 */
export function recommendSettings(input: TuneInput): Recommendation[] {
  const { memoryBudgetMB: budget, cores, maxConnections, diskType } = input;
  const ssd = diskType === "ssd";

  const sharedBuffers = Math.round(budget / 4);
  const effectiveCache = Math.round((budget * 3) / 4);
  const maintenance = Math.min(Math.round(budget / 16), 2048);
  // work_mem is per sort/hash node; divide the non-buffer budget across connections
  // with headroom (×3) so concurrent queries can't sum past RAM.
  const workMem = Math.max(4, Math.floor((budget - sharedBuffers) / (maxConnections * 3)));
  const parallelPerGather = Math.min(4, Math.max(1, Math.floor(cores / 2)));

  const rec = (key: string, value: string, rationale: string): Recommendation => ({
    key,
    value,
    needsRestart: RESTART_KEYS.has(key),
    rationale,
  });

  return [
    rec("shared_buffers", mbToPg(sharedBuffers), "≈25% of the PG memory budget — the classic baseline"),
    rec("effective_cache_size", mbToPg(effectiveCache), "≈75% of budget; planner hint for how much the OS+PG can cache"),
    rec("maintenance_work_mem", mbToPg(maintenance), "speeds VACUUM / CREATE INDEX; capped at 2GB"),
    rec("work_mem", mbToPg(workMem), `per-node sort/hash memory, sized for ~${maxConnections} connections with headroom`),
    rec("max_connections", String(maxConnections), "keep modest; use pgbouncer (transaction pooling) instead of raising this at scale"),
    rec("wal_buffers", "16MB", "standard for sustained write throughput"),
    rec("min_wal_size", "1GB", "avoid frequent checkpoints/recycling under write bursts"),
    rec("max_wal_size", "4GB", "let checkpoints spread out; pair with checkpoint_completion_target"),
    rec("checkpoint_completion_target", "0.9", "spread checkpoint I/O to avoid write stalls"),
    rec("default_statistics_target", "100", "better planner estimates for the OLTP query mix"),
    rec("random_page_cost", ssd ? "1.1" : "4", ssd ? "NVMe/SSD: random ≈ sequential" : "spinning disk: random much costlier"),
    rec("effective_io_concurrency", ssd ? "200" : "2", ssd ? "SSDs handle deep I/O queues" : "low for spinning disk"),
    rec("max_worker_processes", String(cores), "match cores"),
    rec("max_parallel_workers", String(cores), "match cores"),
    rec("max_parallel_workers_per_gather", String(parallelPerGather), "modest — this is a transactional DB, not a warehouse"),
  ];
}

/**
 * A safe default PG memory budget for a host, accounting for ClickHouse + app
 * co-location. On a shared single VM give PG ~25%; the tool lets the operator
 * override once the data tier is split onto its own host.
 */
export function defaultBudgetMB(hostRamMB: number, coLocated: boolean): number {
  const fraction = coLocated ? 0.25 : 0.7;
  return Math.max(256, Math.round(hostRamMB * fraction));
}
