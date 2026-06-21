/**
 * ClickHouse tuning model. Pure functions — given a memory budget, cores and disk
 * type they return recommended settings for AdPix's ANALYTICAL tier (the heavy,
 * memory-hungry OLAP "truth" — the opposite profile to Postgres).
 *
 * The one AdPix-specific rule mirrors postgres/tune.ts but inverted: on a Stage 0/1
 * single VM ClickHouse is co-located with Postgres + the app, and CH gets the LION'S
 * SHARE of RAM (Postgres only ~25%). The dangerous default here is
 * `max_server_memory_usage_to_ram_ratio = 0.9`, which is a fraction of TOTAL host
 * RAM — on a shared box that lets CH grab memory Postgres/OS need. So the headline
 * recommendation is an ABSOLUTE `max_server_memory_usage` cap = CH's budget.
 *
 * Two scopes:
 *  - "server"  → server-level settings, live in config.d/*.xml (some need a restart,
 *                some are picked up by SYSTEM RELOAD CONFIG).
 *  - "profile" → per-query settings, live in users.d/*.xml under <profiles><default>.
 */

export interface TuneInput {
  /** RAM (MB) dedicated to ClickHouse — its share of the box, NOT total host RAM. */
  memoryBudgetMB: number;
  cores: number;
  diskType: "ssd" | "hdd";
}

export interface Recommendation {
  key: string;
  /** Raw value as ClickHouse expects it (bytes for memory settings, integer for counts). */
  value: string;
  scope: "server" | "profile";
  /** true → takes effect only after a restart; false → SYSTEM RELOAD CONFIG is enough. */
  needsRestart: boolean;
  /** Human-readable form for the diff/rationale (e.g. "2.00 GiB" for a byte count). */
  human: string;
  rationale: string;
}

export function mbToBytes(mb: number): number {
  return Math.round(mb) * 1024 * 1024;
}

/** Render a byte count the way `formatReadableSize` does (GiB/MiB), for display only. */
export function formatBytes(bytes: number): string {
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = bytes,
    i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/**
 * Compute recommended settings. Deterministic + unit-tested; the ch_tune tool diffs
 * these against the live `system.server_settings` / `system.settings` values and
 * (optionally) writes them as config.d + users.d drop-ins.
 */
export function recommendSettings(input: TuneInput): Recommendation[] {
  const { memoryBudgetMB: budget, cores } = input;

  const serverMem = mbToBytes(Math.round(budget * 0.95)); // leave 5% headroom under the cap
  const markCacheMB = clamp(budget / 8, 512, 5120);
  const perQueryMem = mbToBytes(Math.round(budget / 2));
  const spill = mbToBytes(Math.round(budget / 4));
  const concurrency = clamp(cores * 10, 20, 100);
  const bgPool = clamp(cores * 2, 8, 64);

  const rec = (
    key: string,
    value: number | string,
    scope: "server" | "profile",
    needsRestart: boolean,
    human: string,
    rationale: string
  ): Recommendation => ({ key, value: String(value), scope, needsRestart, human, rationale });

  return [
    rec(
      "max_server_memory_usage",
      serverMem,
      "server",
      true,
      formatBytes(serverMem),
      "ABSOLUTE memory cap = ~95% of CH's budget. On a co-located VM this REPLACES the default 0.9-of-total-host ratio, which would otherwise starve Postgres/OS."
    ),
    rec(
      "mark_cache_size",
      mbToBytes(markCacheMB),
      "server",
      false,
      formatBytes(mbToBytes(markCacheMB)),
      "primary-key marks cache (~1/8 of budget); keeps index lookups off disk"
    ),
    rec(
      "max_concurrent_queries",
      concurrency,
      "server",
      false,
      String(concurrency),
      `cap concurrency (~10×cores) so a thundering herd can't sum past the memory cap on a ${cores}-core box`
    ),
    rec(
      "background_pool_size",
      bgPool,
      "server",
      true,
      String(bgPool),
      "merge/mutation worker threads (~2×cores) — too few = parts pile up, too many = merge I/O storms"
    ),
    rec(
      "max_memory_usage",
      perQueryMem,
      "profile",
      false,
      formatBytes(perQueryMem),
      "per-QUERY memory cap (½ budget) so a single bad report can't OOM the whole server"
    ),
    rec(
      "max_bytes_before_external_group_by",
      spill,
      "profile",
      false,
      formatBytes(spill),
      "spill large GROUP BY to disk past ¼ budget instead of OOM-killing the query"
    ),
    rec(
      "max_bytes_before_external_sort",
      spill,
      "profile",
      false,
      formatBytes(spill),
      "spill large ORDER BY to disk past ¼ budget instead of OOM"
    ),
    rec("max_threads", cores, "profile", false, String(cores), "use every core for a single analytical query"),
    rec(
      "join_algorithm",
      "auto",
      "profile",
      false,
      "auto",
      "let CH pick hash/grace_hash/partial_merge by memory pressure instead of always hash (which can OOM on big joins)"
    ),
  ];
}

/**
 * A safe default CH memory budget for a host. Inverse of the Postgres rule: on a
 * shared single VM ClickHouse takes the lion's share (~60%), leaving room for
 * Postgres (~25%) + app/OS. On a dedicated CH host give it ~80%.
 */
export function defaultBudgetMB(hostRamMB: number, coLocated: boolean): number {
  const fraction = coLocated ? 0.6 : 0.8;
  return Math.max(512, Math.round(hostRamMB * fraction));
}

/** config.d drop-in for the server-scope recommendations. */
export function renderServerXml(recs: Recommendation[]): string {
  const body = recs
    .filter((r) => r.scope === "server")
    .map((r) => `  <${r.key}>${r.value}</${r.key}>`)
    .join("\n");
  return `<clickhouse>\n${body}\n</clickhouse>\n`;
}

/** users.d drop-in for the profile-scope recommendations (applied to the default profile). */
export function renderProfileXml(recs: Recommendation[]): string {
  const body = recs
    .filter((r) => r.scope === "profile")
    .map((r) => `      <${r.key}>${r.value}</${r.key}>`)
    .join("\n");
  return `<clickhouse>\n  <profiles>\n    <default>\n${body}\n    </default>\n  </profiles>\n</clickhouse>\n`;
}
