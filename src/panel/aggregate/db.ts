import { withSession } from "../../deps.js";
import { composeCmd, readEnvVar } from "../../adpix.js";
import { shq } from "../../util.js";
import { recommendSettings as pgRecommend, defaultBudgetMB as pgBudget } from "../../postgres/tune.js";
import { recommendSettings as chRecommend, defaultBudgetMB as chBudget, formatBytes } from "../../clickhouse/tune.js";

/**
 * Databases aggregator — structured stat cards + before→after tune diff for the Databases
 * screen. Re-runs the SAME psql / clickhouse-client probes as pg_health/ch_health/pg_tune/
 * ch_tune (so the numbers are real), but requests a single delimited row and returns typed
 * JSON the UI renders into cards/tables — no markdown-table or regex parsing.
 */
export type Level = "pos" | "warn" | "neg" | "brand";
export interface DbStat { label: string; value: string; level: Level }
export interface TuneRow { setting: string; current: string; recommended: string; restart: boolean }
export interface DbView { engine: "pg" | "ch"; version: string; role: string; stats: DbStat[]; tune: TuneRow[]; error?: string }

const SEP = "\u001f";
const PG_METRICS =
  "SELECT substring(version() from 'PostgreSQL [0-9.]+'), " +
  "pg_size_pretty(pg_database_size(current_database())), " +
  "(SELECT count(*) FROM pg_stat_activity), current_setting('max_connections'), " +
  "(SELECT round(100*sum(blks_hit)::numeric/nullif(sum(blks_hit)+sum(blks_read),0),2) FROM pg_stat_database), " +
  "pg_is_in_recovery()";
const CH_METRICS =
  "SELECT version(), " +
  "(SELECT formatReadableSize(sum(bytes_on_disk)) FROM system.parts WHERE active), " +
  "(SELECT count() FROM system.parts WHERE active), " +
  "(SELECT count() FROM system.merges), " +
  "(SELECT round(sum(data_uncompressed_bytes)/nullif(sum(data_compressed_bytes),0),1) FROM system.parts WHERE active), " +
  "(SELECT countIf(is_readonly) FROM system.replicas)";

export async function buildDbView(deps: import("../../deps.js").Deps, engine: "pg" | "ch", server?: string): Promise<DbView> {
  try {
    return await withSession(deps, server, async (s, srv) => {
      const dir = srv.adpixDir;
      const host = await s.exec("nproc; free -m | awk '/^Mem:/{print $2}'", { timeoutMs: 10_000 });
      const [coresStr = "2", ramStr = engine === "ch" ? "4096" : "2048"] = host.stdout.trim().split("\n");
      const cores = Number(coresStr) || 2; const ram = Number(ramStr) || (engine === "ch" ? 4096 : 2048);

      if (engine === "pg") {
        const user = (await readEnvVar(s, dir, "POSTGRES_USER")) || "sovereign";
        const db = (await readEnvVar(s, dir, "POSTGRES_DB")) || "sovereign";
        const psql = (q: string) => `${composeCmd(dir)} exec -T postgres psql -U ${shq(user)} -d ${shq(db)} -X -A -t -F ${shq(SEP)} -v ON_ERROR_STOP=1 -c ${shq(q)} 2>&1`;
        const m = await s.exec(psql(PG_METRICS), { timeoutMs: 30_000 });
        if (m.code !== 0 || !m.stdout.trim()) throw new Error(`Postgres query failed on ${srv.name} (stack up?): ${m.stdout.trim().split("\n").slice(-2).join(" ")}`);
        const [ver = "?", size = "?", conns = "0", maxConns = "0", cacheHit = "?", inRec = "f"] = (m.stdout.trim().split("\n")[0] || "").split(SEP);
        const ratio = Number(maxConns) ? Number(conns) / Number(maxConns) : 0;
        const standby = inRec.trim() === "t";
        const stats: DbStat[] = [
          { label: "Connections", value: `${conns} / ${maxConns}`, level: ratio > 0.8 ? "warn" : "pos" },
          { label: "Cache hit", value: cacheHit === "?" ? "—" : `${cacheHit}%`, level: cacheHit !== "?" && Number(cacheHit) < 95 ? "warn" : "pos" },
          { label: "Role", value: standby ? "standby" : "primary", level: "brand" },
          { label: "DB size", value: size, level: "brand" },
        ];
        const recs = pgRecommend({ memoryBudgetMB: pgBudget(ram, true), cores, maxConnections: Number(maxConns) || 200, diskType: "ssd" });
        const cur = await currentValues(s, psql, recs.map((r) => r.key), "pg_settings", "setting || coalesce(unit,'')");
        const tune = recs.map((r) => ({ setting: r.key, current: cur.get(r.key) ?? "?", recommended: r.value, restart: r.needsRestart }));
        return { engine, version: ver === "?" ? "PostgreSQL" : ver, role: standby ? "standby" : "primary", stats, tune };
      }

      // ClickHouse
      const user = (await readEnvVar(s, dir, "CLICKHOUSE_USER")) || "default";
      const db = (await readEnvVar(s, dir, "CLICKHOUSE_DB")) || "sovereign";
      const chq = (q: string) => `${composeCmd(dir)} exec -T clickhouse sh -c ${shq(`clickhouse-client --user ${shq(user)} --password "$CLICKHOUSE_PASSWORD" --database ${shq(db)} --query ${shq(q + " FORMAT TabSeparated")}`)} 2>&1`;
      const m = await s.exec(chq(CH_METRICS), { timeoutMs: 30_000 });
      if (m.code !== 0 || !m.stdout.trim()) throw new Error(`ClickHouse query failed on ${srv.name} (stack up?): ${m.stdout.trim().split("\n").slice(-2).join(" ")}`);
      const [ver = "?", size = "?", parts = "0", merges = "0", comp = "?", roReplicas = "0"] = (m.stdout.trim().split("\n")[0] || "").split("\t");
      const stats: DbStat[] = [
        { label: "Active parts", value: parts, level: Number(parts) > 300 ? "warn" : "brand" },
        { label: "Merge backlog", value: `${merges} merge${merges === "1" ? "" : "s"}`, level: Number(merges) > 5 ? "warn" : "pos" },
        { label: "On-disk size", value: size, level: "brand" },
        { label: "Compression", value: comp === "?" ? "—" : `${comp}×`, level: Number(roReplicas) > 0 ? "neg" : "pos" },
      ];
      const recs = chRecommend({ memoryBudgetMB: chBudget(ram, true), cores, diskType: "ssd" });
      const srvCur = await chCurrent(s, chq, recs.filter((r) => r.scope === "server").map((r) => r.key), "system.server_settings");
      const profCur = await chCurrent(s, chq, recs.filter((r) => r.scope === "profile").map((r) => r.key), "system.settings");
      const human = (raw: string) => (raw === "?" || raw === "0" ? (raw === "0" ? "0 (unset)" : "?") : /^\d{7,}$/.test(raw) ? formatBytes(Number(raw)) : raw);
      const tune = recs.map((r) => ({ setting: r.key, current: human(((r.scope === "server" ? srvCur : profCur).get(r.key)) ?? "?"), recommended: r.human, restart: r.needsRestart }));
      return { engine, version: ver === "?" ? "ClickHouse" : `ClickHouse ${ver}`, role: `${parts} parts`, stats, tune };
    });
  } catch (e) {
    return { engine, version: "", role: "", stats: [], tune: [], error: (e as Error).message };
  }
}

async function currentValues(s: import("../../ssh.js").Session, psql: (q: string) => string, keys: string[], view: string, valueExpr: string): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const out = await s.exec(psql(`SELECT name, ${valueExpr} FROM ${view} WHERE name IN (${keys.map((k) => `'${k}'`).join(",")})`), { timeoutMs: 20_000 });
  return new Map(out.stdout.trim().split("\n").filter(Boolean).map((l) => l.split(SEP) as [string, string]));
}
async function chCurrent(s: import("../../ssh.js").Session, chq: (q: string) => string, keys: string[], view: string): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const out = await s.exec(chq(`SELECT name, value FROM ${view} WHERE name IN (${keys.map((k) => `'${k}'`).join(",")})`), { timeoutMs: 20_000 });
  return new Map(out.stdout.trim().split("\n").filter(Boolean).map((l) => l.split("\t") as [string, string]));
}
