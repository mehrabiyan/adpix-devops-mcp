import { withSession, type Deps } from "../../deps.js";
import { resolveCluster } from "../../registry.js";
import { shq } from "../../util.js";

/**
 * HA quorum aggregator — structured per-member quorum state for the HA screen. Re-runs the
 * SAME pg/redis/sentinel/clickhouse probes as ha_quorum mode:status and returns typed rows +
 * a verdict, so the UI renders the quorum table instead of parsing tool text.
 */
export const CLUSTER_SERVICES = ["ingest", "api", "web", "worker", "identity-job", "postgres", "clickhouse", "caddy", "redis"];

export interface QuorumMember { name: string; role: "witness" | "node"; postgres: string; redis: string; sentinel: boolean; ch: string }
export interface QuorumView { cluster: string; verdict: "healthy" | "warn" | "neg"; vip?: string; members: QuorumMember[]; findings: string[]; error?: string }

const DC = "docker compose -p adanalytics -f compose.yaml -f compose.prod.yaml";

export async function buildQuorumView(deps: Deps, cluster?: string): Promise<QuorumView> {
  let cl;
  try { cl = resolveCluster(cluster); } catch (e) { return { cluster: "", verdict: "warn", members: [], findings: [(e as Error).message], error: (e as Error).message }; }
  const members: { name: string; role: "witness" | "node" }[] = [
    ...(cl.witness ? [{ name: cl.witness, role: "witness" as const }] : []),
    ...cl.nodes.map((n) => ({ name: n, role: "node" as const })),
  ];
  const out: QuorumMember[] = []; const findings: string[] = [];
  let primaries = 0, redisMasters = 0, sentinels = 0;
  for (const m of members) {
    try {
      const probe = await withSession(deps, m.name, async (sess, srv) => {
        const dir = srv.adpixDir;
        const pg = (await sess.exec(`cd ${shq(dir)} && ${DC} exec -T postgres sh -c 'psql -U "\${POSTGRES_USER:-sovereign}" -tAc "SELECT pg_is_in_recovery()" 2>/dev/null' 2>/dev/null || echo "?"`, { timeoutMs: 30_000 })).stdout.trim();
        const redis = (await sess.exec(`cd ${shq(dir)} && ${DC} exec -T redis redis-cli info replication 2>/dev/null | grep -E '^role:|^master_link_status:|^connected_slaves:' | tr '\\r\\n' '  '`, { timeoutMs: 30_000 })).stdout.trim();
        const sentinel = (await sess.exec(`cd ${shq(dir)} && ${DC} exec -T redis redis-cli -p 26379 ping 2>/dev/null || echo none`, { timeoutMs: 20_000 })).stdout.trim();
        const ch = (await sess.exec(`cd ${shq(dir)} && ${DC} exec -T clickhouse sh -c 'clickhouse-client --user "\${CLICKHOUSE_USER:-default}" --password "$CLICKHOUSE_PASSWORD" --query "SELECT countIf(is_readonly), count() FROM system.replicas FORMAT TabSeparated" 2>/dev/null' 2>/dev/null || echo "?"`, { timeoutMs: 30_000 })).stdout.trim();
        return { pg, redis, sentinel, ch };
      });
      const pgRole = probe.pg === "f" ? "primary" : probe.pg === "t" ? "standby" : "?";
      if (pgRole === "primary") primaries++;
      const redisRole = (probe.redis.match(/role:(\w+)/) || [])[1] ?? "?";
      if (redisRole === "master") redisMasters++;
      const link = (probe.redis.match(/master_link_status:(\w+)/) || [])[1];
      if (redisRole === "slave" && link && link !== "up") findings.push(`${m.name}: redis replica link is ${link} (not up)`);
      const sentinelUp = /PONG/i.test(probe.sentinel);
      if (sentinelUp) sentinels++;
      const [chRo = "?", chTot = "?"] = probe.ch.split(/\t|\s+/);
      if (chRo !== "?" && Number(chRo) > 0) findings.push(`${m.name}: ${chRo} ClickHouse replica(s) read-only`);
      out.push({ name: m.name, role: m.role, postgres: pgRole, redis: `${redisRole}${link ? "/" + link : ""}`, sentinel: sentinelUp, ch: chTot === "?" ? "—" : `${chRo} ro / ${chTot}` });
    } catch (e) {
      findings.push(`${m.name} (${m.role}) UNREACHABLE: ${(e as Error).message.split("\n")[0]}`);
      out.push({ name: m.name, role: m.role, postgres: "?", redis: "?", sentinel: false, ch: "?" });
    }
  }
  if (primaries === 0) findings.push("no Postgres PRIMARY found — no writer (failover stuck?)");
  if (primaries > 1) findings.push(`${primaries} Postgres PRIMARIES — SPLIT-BRAIN risk`);
  if (redisMasters > 1) findings.push(`${redisMasters} Redis masters — split-brain risk`);
  if (sentinels < 3) findings.push(`only ${sentinels} Redis Sentinel(s) reachable — need 3 (one on the witness)`);
  const verdict: QuorumView["verdict"] = findings.length === 0 ? "healthy" : findings.some((p) => /SPLIT-BRAIN|no writer|read-only/.test(p)) ? "neg" : "warn";
  return { cluster: cl.name, verdict, vip: cl.vip, members: out, findings };
}
