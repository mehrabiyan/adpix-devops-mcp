import { z } from "zod";
import { withSession } from "../deps.js";
import type { Session } from "../ssh.js";
import { composeCmd, readEnvVar, requireStack, waitHealthyCmd } from "../adpix.js";
import { shq, lastLines, table, redactSecrets } from "../util.js";
import { recommendSettings, defaultBudgetMB, mbToPg, type Recommendation } from "../postgres/tune.js";
import type { ToolDef } from "./types.js";

const serverParam = z.string().optional().describe("Registered server name. Omit to use the default server.");

/** Field separator we ask psql to use (ASCII unit separator — never appears in real values). */
const SEP = "\u001f";

interface PgCtx {
  user: string;
  db: string;
}

async function pgCtx(s: Session, dir: string): Promise<PgCtx> {
  return {
    user: (await readEnvVar(s, dir, "POSTGRES_USER")) || "sovereign",
    db: (await readEnvVar(s, dir, "POSTGRES_DB")) || "sovereign",
  };
}

/** Run a read query inside the postgres container (local-trust socket, no password). */
async function psql(s: Session, dir: string, c: PgCtx, query: string, timeoutMs = 60_000) {
  return s.exec(
    `${composeCmd(dir)} exec -T postgres psql -U ${shq(c.user)} -d ${shq(c.db)} -X -A -t -F ${shq(SEP)} -v ON_ERROR_STOP=1 -c ${shq(query)} 2>&1`,
    { timeoutMs }
  );
}

/** Run a statement (DDL / ALTER SYSTEM) and return exit code + output. */
async function pgExec(s: Session, dir: string, c: PgCtx, stmt: string, timeoutMs = 120_000) {
  return s.exec(
    `${composeCmd(dir)} exec -T postgres psql -U ${shq(c.user)} -d ${shq(c.db)} -X -v ON_ERROR_STOP=1 -c ${shq(stmt)} 2>&1`,
    { timeoutMs }
  );
}

function rows(out: string): string[][] {
  const t = out.trim();
  return t ? t.split("\n").map((l) => l.split(SEP)) : [];
}

async function ensureInstalled(s: Session, dir: string, server = "this server"): Promise<string | null> {
  return requireStack(s, dir, server, { needRunning: true });
}

export const postgresTools: ToolDef[] = [
  {
    name: "pg_health",
    title: "Postgres health snapshot",
    description:
      "Read-only health check of the AdPix Postgres: version, size, connections vs max, cache hit ratio, " +
      "active/blocked/idle-in-transaction sessions, long-running queries, autovacuum freshness + dead-tuple " +
      "bloat on the biggest tables, transaction-ID wraparound age, and replication role/lag. Ends with a verdict.",
    schema: { server: serverParam },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const notInstalled = await ensureInstalled(s, dir, srv.name);
        if (notInstalled) return notInstalled;
        const c = await pgCtx(s, dir);

        const metrics = await psql(
          s, dir, c,
          "SELECT " +
            "substring(version() from 'PostgreSQL [0-9.]+'), " +
            "pg_size_pretty(pg_database_size(current_database())), " +
            "(SELECT count(*) FROM pg_stat_activity), " +
            "current_setting('max_connections'), " +
            "(SELECT count(*) FROM pg_stat_activity WHERE state='active'), " +
            "(SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock'), " +
            "(SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction'), " +
            "(SELECT round(100*sum(blks_hit)::numeric/nullif(sum(blks_hit)+sum(blks_read),0),2) FROM pg_stat_database), " +
            "pg_is_in_recovery(), " +
            "(SELECT count(*) FROM pg_stat_activity WHERE state='active' AND now()-query_start > interval '60 seconds'), " +
            "(SELECT (max(age(datfrozenxid))::float / 2000000000 * 100)::int FROM pg_database)"
        );
        if (metrics.code !== 0 || !metrics.stdout.trim()) {
          return `Couldn't query Postgres on ${srv.name} (is the stack up? try health_check):\n${lastLines(metrics.stdout, 15)}`;
        }
        const [ver = "?", size = "?", conns = "0", maxConns = "0", active = "0", blocked = "0", idleTx = "0", cacheHit = "?", inRecovery = "f", longQ = "0", wraparoundPct = "0"] =
          rows(metrics.stdout)[0] ?? [];

        const problems: string[] = [];
        if (Number(conns) / Number(maxConns) > 0.8) problems.push(`connections ${conns}/${maxConns} (>80%) — consider pgbouncer`);
        if (cacheHit !== "?" && Number(cacheHit) < 95) problems.push(`cache hit ratio ${cacheHit}% (<95%) — shared_buffers may be low (pg_tune)`);
        if (Number(blocked) > 0) problems.push(`${blocked} session(s) blocked on locks`);
        if (Number(idleTx) > 5) problems.push(`${idleTx} idle-in-transaction sessions — they hold locks + block vacuum`);
        if (Number(longQ) > 0) problems.push(`${longQ} query(ies) running >60s`);
        if (Number(wraparoundPct) > 50) problems.push(`txid wraparound age at ${wraparoundPct}% of limit — vacuum is falling behind (URGENT if >80%)`);

        const tables = rows(
          (await psql(
            s, dir, c,
            "SELECT relname, pg_size_pretty(pg_total_relation_size(relid)), n_live_tup, n_dead_tup, " +
              "coalesce(to_char(last_autovacuum,'YYYY-MM-DD HH24:MI'),'never') " +
              "FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 8"
          )).stdout
        );
        const longQueries = rows(
          (await psql(
            s, dir, c,
            "SELECT pid, date_trunc('second', now()-query_start)::text, state, left(regexp_replace(query, '\\s+', ' ', 'g'),70) " +
              "FROM pg_stat_activity WHERE state<>'idle' AND now()-query_start > interval '30 seconds' AND pid<>pg_backend_pid() " +
              "ORDER BY query_start LIMIT 5"
          )).stdout
        );

        const inRec = inRecovery.trim() === "t";
        let repl = "";
        if (inRec) {
          const r = rows((await psql(s, dir, c, "SELECT status, coalesce(round(extract(epoch FROM now()-pg_last_xact_replay_timestamp()))::text,'?') FROM pg_stat_wal_receiver")).stdout);
          repl = r.length ? `REPLICA — receiver ${r[0][0]}, replay lag ${r[0][1]}s` : "REPLICA — no active WAL receiver (replication broken?)";
          if (!r.length) problems.push("standby has no WAL receiver — replication is down");
        } else {
          const r = rows((await psql(s, dir, c, "SELECT application_name, state, sync_state, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) FROM pg_stat_replication")).stdout);
          repl = r.length ? "PRIMARY with replicas:\n" + table(["REPLICA", "STATE", "SYNC", "LAG"], r) : "PRIMARY — no replicas attached (single node; see pg_replication for HA)";
        }

        const verdict = problems.length === 0 ? "HEALTHY" : problems.some((p) => /URGENT|wraparound|down|blocked/.test(p)) ? "NEEDS ATTENTION" : "OK with warnings";
        return [
          `# Postgres health — ${srv.name} (${ver})  —  ${verdict}`,
          problems.length ? "Findings:\n" + problems.map((p) => `  - ${p}`).join("\n") : "No problems found.",
          ``,
          `Size ${size} · connections ${conns}/${maxConns} (${active} active, ${idleTx} idle-in-tx, ${blocked} blocked) · cache hit ${cacheHit}% · txid age ${wraparoundPct}% of wraparound limit`,
          ``,
          `## Role / replication\n${repl}`,
          ``,
          `## Largest tables\n${tables.length ? table(["TABLE", "SIZE", "LIVE", "DEAD", "LAST AUTOVAC"], tables) : "(none)"}`,
          longQueries.length ? `\n## Long-running (>30s)\n${table(["PID", "DURATION", "STATE", "QUERY"], longQueries)}` : "",
        ].filter(Boolean).join("\n");
      });
    },
  },

  {
    name: "pg_tune",
    title: "Tune Postgres config",
    description:
      "Compute tuned Postgres settings for AdPix's transactional workload (pgtune-style) from a memory " +
      "budget + cores + disk type, diff them against the live values, and optionally apply via ALTER SYSTEM " +
      "+ reload. IMPORTANT on a single VM Postgres is co-located with ClickHouse, so it gets a memory BUDGET " +
      "(~25% by default), never the whole host. Dry-run unless apply:true; flags settings that need a restart.",
    schema: {
      server: serverParam,
      memoryBudgetMB: z.number().int().min(128).optional().describe("RAM to dedicate to Postgres. Default: a safe fraction of host RAM (25% if co-located with ClickHouse)"),
      maxConnections: z.number().int().min(20).max(10000).default(100).describe("Prefer pgbouncer over raising this"),
      diskType: z.enum(["ssd", "hdd"]).default("ssd"),
      coLocated: z.boolean().default(true).describe("Is Postgres on the same host as ClickHouse/app? (drives the default budget)"),
      apply: z.boolean().default(false).describe("false = show the diff only; true = ALTER SYSTEM + reload"),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; memoryBudgetMB?: number; maxConnections: number; diskType: "ssd" | "hdd"; coLocated: boolean; apply: boolean };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const notInstalled = await ensureInstalled(s, dir, srv.name);
        if (notInstalled) return notInstalled;
        const c = await pgCtx(s, dir);

        const host = await s.exec("nproc; free -m | awk '/^Mem:/{print $2}'");
        const [coresStr = "2", hostRamStr = "2048"] = host.stdout.trim().split("\n");
        const cores = Number(coresStr) || 2;
        const hostRam = Number(hostRamStr) || 2048;
        const budget = a.memoryBudgetMB ?? defaultBudgetMB(hostRam, a.coLocated);

        const recs = recommendSettings({ memoryBudgetMB: budget, cores, maxConnections: a.maxConnections, diskType: a.diskType });

        // current values for the diff
        const keys = recs.map((r) => r.key);
        const cur = new Map<string, string>();
        const curOut = await psql(s, dir, c, `SELECT name, setting || coalesce(unit,'') FROM pg_settings WHERE name IN (${keys.map((k) => `'${k}'`).join(",")})`);
        for (const [k, v] of rows(curOut.stdout)) cur.set(k, v);

        const diff = table(
          ["SETTING", "CURRENT", "RECOMMENDED", "RESTART?"],
          recs.map((r) => [r.key, cur.get(r.key) ?? "?", r.value, r.needsRestart ? "yes" : ""])
        );

        const head = [
          `# Postgres tuning — ${srv.name}`,
          `Host: ${cores} vCPU, ${hostRam}MB RAM. Postgres budget: ${mbToPg(budget)}` +
            (a.coLocated ? ` (~${Math.round((budget / hostRam) * 100)}% — co-located with ClickHouse, which needs the rest)` : ` (dedicated host)`),
          ``,
          diff,
          ``,
          `Rationale:\n` + recs.map((r) => `  - ${r.key}: ${r.rationale}`).join("\n"),
        ];

        if (!a.apply) {
          return head.concat([``, `Dry-run — nothing changed. Re-run with apply:true to ALTER SYSTEM + reload. Settings marked RESTART? need pg_redeploy action:restart after.`]).join("\n");
        }

        const stmts = recs.map((r) => `ALTER SYSTEM SET ${r.key} = ${shq(r.value)};`).join(" ");
        const ap = await pgExec(s, dir, c, stmts + " SELECT pg_reload_conf();");
        if (ap.code !== 0) return head.concat([``, `APPLY FAILED:\n${lastLines(ap.stdout, 20)}`]).join("\n");
        const needRestart = recs.filter((r) => r.needsRestart).map((r) => r.key);
        return head.concat([
          ``,
          `## Applied via ALTER SYSTEM + pg_reload_conf()`,
          needRestart.length
            ? `Reloaded. These need a restart to take effect: ${needRestart.join(", ")} — run pg_redeploy action:restart in a quiet window.`
            : `Reloaded — all settings are live (no restart needed).`,
        ]).join("\n");
      });
    },
  },

  {
    name: "pg_optimize",
    title: "Optimize Postgres (indexes + vacuum)",
    description:
      "Find optimization opportunities: unused / invalid indexes, sequential-scan-heavy big tables, dead-tuple " +
      "bloat needing vacuum, and the top time-consuming queries (if pg_stat_statements is enabled). With " +
      "apply:true runs an online VACUUM (ANALYZE) on the worst-bloated tables (non-locking). Index drops/REINDEX " +
      "are recommended, never auto-run.",
    schema: {
      server: serverParam,
      apply: z.boolean().default(false).describe("true = run VACUUM (ANALYZE) on bloated tables (safe/online)"),
    },
    annotations: { destructiveHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; apply: boolean };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const notInstalled = await ensureInstalled(s, dir, srv.name);
        if (notInstalled) return notInstalled;
        const c = await pgCtx(s, dir);

        const unused = rows((await psql(s, dir, c,
          "SELECT schemaname||'.'||relname, indexrelname, pg_size_pretty(pg_relation_size(i.indexrelid)) " +
          "FROM pg_stat_user_indexes i JOIN pg_index x ON x.indexrelid=i.indexrelid " +
          "WHERE i.idx_scan=0 AND NOT x.indisunique AND NOT x.indisprimary " +
          "ORDER BY pg_relation_size(i.indexrelid) DESC LIMIT 10")).stdout);
        const invalid = rows((await psql(s, dir, c,
          "SELECT n.nspname||'.'||c.relname FROM pg_index x JOIN pg_class c ON c.oid=x.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT x.indisvalid")).stdout);
        const seqScan = rows((await psql(s, dir, c,
          "SELECT relname, seq_scan, idx_scan, n_live_tup FROM pg_stat_user_tables " +
          "WHERE seq_scan > coalesce(idx_scan,0) AND n_live_tup > 50000 ORDER BY seq_scan DESC LIMIT 8")).stdout);
        const bloat = rows((await psql(s, dir, c,
          "SELECT relname, n_dead_tup, n_live_tup, round(100*n_dead_tup::numeric/nullif(n_live_tup+n_dead_tup,0),1) " +
          "FROM pg_stat_user_tables WHERE n_dead_tup > 1000 ORDER BY n_dead_tup DESC LIMIT 10")).stdout);

        const hasPgss = (await psql(s, dir, c, "SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements'")).stdout.trim() === "1";
        const slow = hasPgss
          ? rows((await psql(s, dir, c,
              "SELECT left(regexp_replace(query,'\\s+',' ','g'),60), calls, round(mean_exec_time::numeric,1), round(total_exec_time::numeric,0) " +
              "FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 8")).stdout)
          : [];

        const out: string[] = [`# Postgres optimization — ${srv.name}`];
        out.push(`\n## Unused indexes (0 scans; candidates to DROP after confirming)\n${unused.length ? table(["INDEX ON", "INDEX", "SIZE"], unused) : "none — good"}`);
        if (invalid.length) out.push(`\n## INVALID indexes (rebuild with REINDEX INDEX CONCURRENTLY)\n${invalid.map((r) => "  - " + r[0]).join("\n")}`);
        out.push(`\n## Sequential-scan-heavy tables (>50k rows; may need an index)\n${seqScan.length ? table(["TABLE", "SEQ", "IDX", "ROWS"], seqScan) : "none"}`);
        out.push(`\n## Dead-tuple bloat\n${bloat.length ? table(["TABLE", "DEAD", "LIVE", "DEAD%"], bloat) : "none significant"}`);
        out.push(`\n## Top queries by total time\n${hasPgss ? (slow.length ? table(["QUERY", "CALLS", "MEAN ms", "TOTAL ms"], slow) : "none") : "(enable pg_stat_statements for query-level insight: shared_preload_libraries='pg_stat_statements' then restart)"}`);

        if (a.apply && bloat.length) {
          const targets = bloat.filter((r) => Number(r[3]) >= 20).map((r) => r[0]).slice(0, 5);
          if (targets.length) {
            const stmts = targets.map((t) => `VACUUM (ANALYZE) ${t};`).join(" ");
            const r = await pgExec(s, dir, c, stmts, 600_000);
            out.push(`\n## Applied\nVACUUM (ANALYZE) on ${targets.join(", ")} — ${r.code === 0 ? "done (online, non-locking)" : `FAILED: ${lastLines(r.stdout, 8)}`}`);
          } else {
            out.push(`\n## Applied\nNo table above 20% dead tuples — nothing to vacuum.`);
          }
        } else if (a.apply) {
          out.push(`\n## Applied\nNothing bloated enough to vacuum.`);
        } else {
          out.push(`\nRe-run with apply:true to VACUUM (ANALYZE) the bloated tables (safe + online). Drops/REINDEX are left to you — review first.`);
        }
        return out.join("\n");
      });
    },
  },

  {
    name: "pg_harden",
    title: "Harden / secure Postgres",
    description:
      "Audit Postgres security (password encryption, SSL, host port exposure, superuser roles, passwordless " +
      "login roles, public-schema privileges, connection/slow-query logging, idle-transaction timeout) and, " +
      "with apply:true, fix the safely-appliable items via ALTER SYSTEM + SQL. SSL enablement (needs certs + " +
      "restart) is advised, not auto-done. Dry-run by default.",
    schema: {
      server: serverParam,
      apply: z.boolean().default(false),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; apply: boolean };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const notInstalled = await ensureInstalled(s, dir, srv.name);
        if (notInstalled) return notInstalled;
        const c = await pgCtx(s, dir);

        const g = async (q: string) => (await psql(s, dir, c, q)).stdout.trim();
        const pwEnc = await g("SHOW password_encryption");
        const ssl = await g("SHOW ssl");
        const logConn = await g("SHOW log_connections");
        const logDur = await g("SHOW log_min_duration_statement");
        const idleTx = await g("SHOW idle_in_transaction_session_timeout");
        const supers = rows(await g("SELECT rolname FROM pg_roles WHERE rolsuper")).map((r) => r[0]);
        const noPw = rows(await g("SELECT rolname FROM pg_authid WHERE rolcanlogin AND rolpassword IS NULL")).map((r) => r[0]);
        const publicCreate = await g("SELECT has_schema_privilege('public','public','CREATE')");
        // host port exposure (prod compose must NOT publish 5432)
        const portPub = (await s.exec(`${composeCmd(dir)} ps --format '{{.Service}} {{.Publishers}}' 2>/dev/null | grep -i postgres || true`)).stdout.trim();

        const findings: { level: "FAIL" | "WARN" | "PASS"; msg: string }[] = [];
        const add = (level: "FAIL" | "WARN" | "PASS", msg: string) => findings.push({ level, msg });

        pwEnc === "scram-sha-256" ? add("PASS", "password_encryption = scram-sha-256") : add("WARN", `password_encryption = ${pwEnc} — should be scram-sha-256`);
        ssl === "on" ? add("PASS", "SSL enabled") : add("WARN", "SSL off — fine while PG is not network-exposed; enable (certs + restart) if it ever leaves the host network");
        /5432/.test(portPub) && /0\.0\.0\.0|:::/.test(portPub) ? add("FAIL", `Postgres port published on the host (${portPub}) — prod must keep it on the internal network only`) : add("PASS", "Postgres port not published to the host (internal network only)");
        supers.length <= 1 ? add("PASS", `single superuser (${supers.join(", ") || "none"})`) : add("WARN", `${supers.length} superusers: ${supers.join(", ")} — apps should use a least-privilege role`);
        noPw.length ? add("FAIL", `login role(s) with NO password: ${noPw.join(", ")}`) : add("PASS", "no passwordless login roles");
        publicCreate === "t" ? add("WARN", "PUBLIC can CREATE in schema public — revoke (REVOKE CREATE ON SCHEMA public FROM PUBLIC)") : add("PASS", "PUBLIC cannot CREATE in schema public");
        logConn === "on" ? add("PASS", "log_connections on") : add("WARN", "log_connections off — enable for an audit trail");
        logDur !== "-1" ? add("PASS", `slow-query logging on (>${logDur}ms)`) : add("WARN", "log_min_duration_statement = -1 — enable slow-query logging (e.g. 1000ms)");
        idleTx !== "0" ? add("PASS", `idle_in_transaction_session_timeout = ${idleTx}`) : add("WARN", "idle_in_transaction_session_timeout = 0 — set it (e.g. 5min) so stuck txns can't hold locks/block vacuum");

        const order = { FAIL: 0, WARN: 1, PASS: 2 };
        const report = findings.sort((x, y) => order[x.level] - order[y.level]).map((f) => `${f.level.padEnd(4)} ${f.msg}`).join("\n");
        const fails = findings.filter((f) => f.level === "FAIL").length;
        const warns = findings.filter((f) => f.level === "WARN").length;
        const head = `# Postgres hardening — ${srv.name}\nVerdict: ${fails ? "ACTION REQUIRED" : warns ? "ROOM TO HARDEN" : "GOOD"} (${fails} fail, ${warns} warn)\n\n${report}`;

        if (!a.apply) {
          return head + `\n\nDry-run. Re-run with apply:true to apply the SQL-fixable items (password_encryption, logging, idle timeout, revoke public CREATE). Port exposure is fixed in compose (use compose.prod.yaml); SSL needs certs + restart.`;
        }
        const stmts = [
          "ALTER SYSTEM SET password_encryption='scram-sha-256';",
          "ALTER SYSTEM SET log_connections='on';",
          "ALTER SYSTEM SET log_disconnections='on';",
          "ALTER SYSTEM SET log_min_duration_statement='1000';",
          "ALTER SYSTEM SET idle_in_transaction_session_timeout='300000';",
          "REVOKE CREATE ON SCHEMA public FROM PUBLIC;",
          "SELECT pg_reload_conf();",
        ].join(" ");
        const ap = await pgExec(s, dir, c, stmts);
        return head + `\n\n## Applied (ALTER SYSTEM + reload)\n${ap.code === 0 ? "Done. password_encryption applies to NEW password sets; existing scram hashes are unchanged. Port exposure + SSL are out-of-band (compose / certs)." : "FAILED:\n" + lastLines(ap.stdout, 15)}`;
      });
    },
  },

  {
    name: "pg_backup",
    title: "Backup Postgres (verified)",
    description:
      "On-demand verified logical backup: pg_dump (-Fc) of the database + pg_dumpall -g for global roles, written " +
      "under <adpixDir>/backups/pg-<ts>/, then verified with pg_restore --list. Complements the scheduled " +
      "make/adpix_backup (which also covers ClickHouse). Reports paths, sizes, and the verify result.",
    schema: { server: serverParam },
    handler: async (deps, args) => {
      const a = args as { server?: string };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const notInstalled = await ensureInstalled(s, dir, srv.name);
        if (notInstalled) return notInstalled;
        const c = await pgCtx(s, dir);
        const ce = composeCmd(dir);
        const out = `backups/pg-$(date +%Y%m%d-%H%M%S)`;
        const script =
          `cd ${shq(dir)} && O=${out} && mkdir -p "$O" && ` +
          `${ce} exec -T postgres pg_dump -U ${shq(c.user)} -d ${shq(c.db)} -Fc > "$O/${c.db}.dump" && ` +
          `${ce} exec -T postgres pg_dumpall -U ${shq(c.user)} --globals-only > "$O/globals.sql" && ` +
          `${ce} exec -T postgres pg_restore --list - < "$O/${c.db}.dump" > "$O/manifest.txt" 2>&1 && ` +
          `echo "OK $O" && du -sh "$O" && ls -lh "$O"`;
        const r = await s.exec(script, { timeoutMs: 1_800_000 });
        if (r.code !== 0) return `Postgres backup FAILED (exit ${r.code}):\n${lastLines(r.stdout, 25)}`;
        const verifyLines = (await s.exec(`cd ${shq(dir)} && wc -l < "$(ls -1dt backups/pg-*/ | head -1)manifest.txt"`)).stdout.trim();
        return `Verified Postgres backup on ${srv.name}:\n${lastLines(r.stdout, 14)}\n\nmanifest: ${verifyLines} archive entries listed (pg_restore --list succeeded → the dump is readable).`;
      });
    },
  },

  {
    name: "pg_restore_db",
    title: "Restore Postgres from a dump",
    description:
      "Restore the database from a pg_dump (-Fc) file created by pg_backup. DESTRUCTIVE — drops and recreates " +
      "objects (pg_restore --clean --if-exists). Requires confirm:true. Health-gates the stack afterward.",
    schema: {
      server: serverParam,
      dumpPath: z.string().describe('Dump file relative to adpixDir, e.g. "backups/pg-20260615-0300/sovereign.dump"'),
      confirm: z.boolean().default(false).describe("Must be true — this overwrites the live database"),
    },
    annotations: { destructiveHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; dumpPath: string; confirm: boolean };
      if (!a.confirm) return "REFUSED: restore overwrites the live database. Re-run with confirm:true after double-checking dumpPath.";
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const notInstalled = await ensureInstalled(s, dir, srv.name);
        if (notInstalled) return notInstalled;
        const c = await pgCtx(s, dir);
        const exists = await s.exec(`test -f ${shq(dir)}/${shq(a.dumpPath)} && echo yes || echo no`);
        if (exists.stdout.trim() !== "yes") {
          const avail = await s.exec(`ls -1t ${shq(dir)}/backups/pg-*/*.dump 2>/dev/null | head -10`);
          return `Dump "${a.dumpPath}" not found. Available:\n${avail.stdout.trim() || "(none — run pg_backup first)"}`;
        }
        const r = await s.exec(
          `cd ${shq(dir)} && cat ${shq(a.dumpPath)} | ${composeCmd(dir)} exec -T postgres pg_restore -U ${shq(c.user)} -d ${shq(c.db)} --clean --if-exists --no-owner --single-transaction 2>&1`,
          { timeoutMs: 1_800_000 }
        );
        const gate = await s.exec(waitHealthyCmd(90), { timeoutMs: 120_000 });
        return [
          `Restore from ${a.dumpPath} ${r.code === 0 ? "completed" : `FINISHED WITH ERRORS (exit ${r.code})`} on ${srv.name}:`,
          lastLines(r.stdout, 30),
          `Health: ${gate.stdout.trim()}`,
        ].join("\n");
      });
    },
  },

  {
    name: "pg_replication",
    title: "Postgres replication / failover",
    description:
      "Manage streaming replication for HA. Modes: status (primary's replicas or standby's lag); prepare-primary " +
      "(configure wal_level/senders/slots, create a replication role + physical slot, append the pg_hba rule — " +
      "apply:true); replica-steps (print the exact pg_basebackup commands to bring up a standby on another host); " +
      "promote (pg_promote a standby — failover, confirm:true).",
    schema: {
      server: serverParam,
      mode: z.enum(["status", "prepare-primary", "replica-steps", "promote"]).default("status"),
      replicaCIDR: z.string().default("10.0.0.0/8").describe("For prepare-primary: CIDR the standby connects from (pg_hba rule)"),
      slotName: z.string().default("replica1").describe("Physical replication slot name"),
      apply: z.boolean().default(false).describe("prepare-primary: actually apply"),
      confirm: z.boolean().default(false).describe("promote: required (failover)"),
    },
    annotations: { destructiveHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; mode: string; replicaCIDR: string; slotName: string; apply: boolean; confirm: boolean };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const notInstalled = await ensureInstalled(s, dir, srv.name);
        if (notInstalled) return notInstalled;
        const c = await pgCtx(s, dir);
        const inRec = (await psql(s, dir, c, "SELECT pg_is_in_recovery()")).stdout.trim() === "t";

        if (a.mode === "status") {
          if (inRec) {
            const r = rows((await psql(s, dir, c, "SELECT status, sender_host, coalesce(round(extract(epoch FROM now()-pg_last_xact_replay_timestamp()))::text,'?') FROM pg_stat_wal_receiver")).stdout);
            return r.length ? `# Replication — ${srv.name} is a STANDBY\nreceiver=${r[0][0]} from ${r[0][1]}, replay lag ${r[0][2]}s` : `# Replication — ${srv.name} is a STANDBY but has NO active WAL receiver (replication is broken — check primary_conninfo + the primary).`;
          }
          const reps = rows((await psql(s, dir, c, "SELECT application_name, client_addr, state, sync_state, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) FROM pg_stat_replication")).stdout);
          const slots = rows((await psql(s, dir, c, "SELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) FROM pg_replication_slots WHERE slot_type='physical'")).stdout);
          return [
            `# Replication — ${srv.name} is a PRIMARY`,
            reps.length ? `## Connected standbys\n${table(["NAME", "CLIENT", "STATE", "SYNC", "LAG"], reps)}` : "No standbys connected (single node — no HA yet).",
            slots.length ? `\n## Physical slots\n${table(["SLOT", "ACTIVE", "RETAINED WAL"], slots)}` : "",
          ].filter(Boolean).join("\n");
        }

        if (a.mode === "prepare-primary") {
          if (inRec) return "This node is a standby, not a primary — run prepare-primary on the primary.";
          const plan = [
            `ALTER SYSTEM SET wal_level='replica';   -- needs restart`,
            `ALTER SYSTEM SET max_wal_senders='10';`,
            `ALTER SYSTEM SET max_replication_slots='10';`,
            `ALTER SYSTEM SET hot_standby='on';`,
            `CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '<set-a-strong-password>';`,
            `SELECT pg_create_physical_replication_slot('${a.slotName}');`,
            `-- append to pg_hba.conf:  host replication replicator ${a.replicaCIDR} scram-sha-256`,
          ];
          if (!a.apply) {
            return `# Prepare primary for replication — ${srv.name} (dry-run)\n\n${plan.join("\n")}\n\n` +
              `Re-run with apply:true to apply (wal_level needs a restart afterward: pg_redeploy action:restart). ` +
              `Set the replicator password yourself — pass it via a follow-up run_command (ALTER ROLE replicator PASSWORD …) so it's not echoed here.`;
          }
          const stmts =
            `ALTER SYSTEM SET wal_level='replica'; ALTER SYSTEM SET max_wal_senders='10'; ALTER SYSTEM SET max_replication_slots='10'; ALTER SYSTEM SET hot_standby='on'; ` +
            `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='replicator') THEN CREATE ROLE replicator WITH REPLICATION LOGIN; END IF; END $$; ` +
            `SELECT pg_create_physical_replication_slot('${a.slotName}', true) WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name='${a.slotName}'); SELECT pg_reload_conf();`;
          const r = await pgExec(s, dir, c, stmts);
          // append pg_hba rule inside the data dir, then reload
          const hba = await s.exec(`${composeCmd(dir)} exec -T postgres sh -lc "grep -q 'replication replicator ${a.replicaCIDR}' /var/lib/postgresql/data/pg_hba.conf || echo 'host replication replicator ${a.replicaCIDR} scram-sha-256' >> /var/lib/postgresql/data/pg_hba.conf" 2>&1`);
          return [
            `# Prepared primary on ${srv.name} (exit ${r.code})`,
            lastLines(r.stdout, 12),
            hba.code === 0 ? "pg_hba.conf: replication rule ensured." : `pg_hba update issue: ${lastLines(hba.stdout, 5)}`,
            ``,
            `NEXT: 1) set the password — run_command: ${composeCmd(dir)} exec -T postgres psql -U ${c.user} -c "ALTER ROLE replicator PASSWORD '…'"`,
            `      2) restart to apply wal_level — pg_redeploy action:restart`,
            `      3) bring up the standby — pg_replication mode:replica-steps`,
          ].join("\n");
        }

        if (a.mode === "replica-steps") {
          return [
            `# Bring up a standby for ${srv.name} (run ON the new replica host)`,
            ``,
            `Assumes the primary is prepared (pg_replication mode:prepare-primary) and reachable as $PRIMARY_HOST.`,
            `In a fresh AdPix checkout on the replica host, stop postgres, then seed the data dir from the primary:`,
            ``,
            `  PRIMARY_HOST=<primary-ip>`,
            `  ${composeCmd(dir)} stop postgres`,
            `  docker run --rm -v adanalytics_pgdata:/data -e PGPASSWORD=<replicator-pw> postgres:17-alpine \\`,
            `    pg_basebackup -h $PRIMARY_HOST -U replicator -D /data -Fp -Xs -P -R --slot=${a.slotName}`,
            `  ${composeCmd(dir)} up -d postgres`,
            ``,
            `-R writes standby.signal + primary_conninfo automatically, so it starts streaming on boot.`,
            `Verify from the replica with pg_replication mode:status, and from the primary too.`,
            `(Volume name is <project>_pgdata = adanalytics_pgdata; adjust if your project name differs.)`,
          ].join("\n");
        }

        // promote
        if (!inRec) return "This node is already a PRIMARY — nothing to promote.";
        if (!a.confirm) return "REFUSED: promote performs a failover (this standby becomes the primary). Re-run with confirm:true.";
        const r = await psql(s, dir, c, "SELECT pg_promote(wait => true, wait_seconds => 60)");
        const stillRec = (await psql(s, dir, c, "SELECT pg_is_in_recovery()")).stdout.trim();
        return `Promote on ${srv.name}: ${r.stdout.trim()} — now ${stillRec === "f" ? "PRIMARY (promotion succeeded)" : "STILL in recovery (promotion did not complete — check logs)"}.\nRepoint applications/standbys at the new primary.`;
      });
    },
  },

  {
    name: "pg_redeploy",
    title: "Redeploy / restart Postgres",
    description:
      "Safely apply config or image changes to Postgres. Actions: reload (pg_reload_conf, zero downtime); restart " +
      "(compose restart — brief downtime, applies restart-context settings); recreate (compose up -d " +
      "--force-recreate — new container, same pgdata volume, picks up image/env changes); upgrade-plan (print the " +
      "major-version upgrade steps). Backs up first (unless skipBackup) for restart/recreate, then health-gates.",
    schema: {
      server: serverParam,
      action: z.enum(["reload", "restart", "recreate", "upgrade-plan"]).default("restart"),
      skipBackup: z.boolean().default(false),
    },
    annotations: { destructiveHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; action: string; skipBackup: boolean };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const notInstalled = await ensureInstalled(s, dir, srv.name);
        if (notInstalled) return notInstalled;
        const c = await pgCtx(s, dir);
        const ce = composeCmd(dir);

        if (a.action === "upgrade-plan") {
          return [
            `# Postgres major-version upgrade plan — ${srv.name}`,
            `Postgres runs as postgres:17-alpine with the pgdata volume; a major bump can't just swap the image (data dir is version-specific). Safest path = dump & restore:`,
            ``,
            `1. pg_backup (verified dump + globals). Announce a short maintenance window.`,
            `2. Stop writers: ${ce} stop ingest api worker identity-job`,
            `3. Final dump: pg_dumpall (globals) + pg_dump -Fc (data) — see pg_backup output for paths.`,
            `4. Bump the image tag (postgres:NN-alpine) in compose, and remove/rename the pgdata volume so the new version initializes clean.`,
            `5. ${ce} up -d postgres   (new empty cluster)`,
            `6. Restore globals (psql -f globals.sql) then the dump (pg_restore) — see pg_restore_db.`,
            `7. ${ce} up -d   (bring writers back); then pg_health + the verify suite.`,
            ``,
            `Alternative (in-place pg_upgrade) is faster but fiddly in containers — dump/restore is the reliable default at AdPix's size. Do it off-campaign; have the pg_backup as rollback.`,
          ].join("\n");
        }

        if (a.action === "reload") {
          const r = await pgExec(s, dir, c, "SELECT pg_reload_conf()");
          return `Reloaded Postgres config on ${srv.name} (exit ${r.code}) — SIGHUP-context settings are now live. Restart-context settings still need action:restart.`;
        }

        // Interruption guard: restarting a PRIMARY with attached standbys means write downtime
        // for the duration. On an HA cluster, fail over first (rolling) instead of bouncing the primary.
        const inRec = (await psql(s, dir, c, "SELECT pg_is_in_recovery()")).stdout.trim() === "t";
        const standbys = inRec ? 0 : Number(rows((await psql(s, dir, c, "SELECT count(*) FROM pg_stat_replication")).stdout)[0]?.[0] ?? "0");
        const downtimeWarn = !inRec && standbys > 0
          ? `\n⚠ This node is a PRIMARY with ${standbys} standby(s). A ${a.action} stops writes for the whole platform until it's back. On HA, prefer: pg_replication mode:promote a standby (failover), repoint, then bounce this one as a standby — zero write-downtime. Proceeding anyway since you asked.\n`
          : "";

        if (!a.skipBackup) {
          const bk = await s.exec(
            `cd ${shq(dir)} && O=backups/pg-$(date +%Y%m%d-%H%M%S) && mkdir -p "$O" && ${ce} exec -T postgres pg_dump -U ${shq(c.user)} -d ${shq(c.db)} -Fc > "$O/${c.db}.dump" && echo "backed up to $O"`,
            { timeoutMs: 1_800_000 }
          );
          if (bk.code !== 0) return `Pre-redeploy backup FAILED — aborting to stay safe:\n${lastLines(bk.stdout, 15)}\n(pass skipBackup:true to override.)`;
        }
        const cmd = a.action === "recreate" ? `${ce} up -d --force-recreate postgres` : `${ce} restart postgres`;
        const r = await s.exec(`${cmd} 2>&1`, { timeoutMs: 300_000 });
        const ready = await s.exec(
          `for i in $(seq 1 30); do ${ce} exec -T postgres pg_isready -U ${shq(c.user)} >/dev/null 2>&1 && echo ready && break; sleep 2; done`,
          { timeoutMs: 90_000 }
        );
        const gate = await s.exec(waitHealthyCmd(90), { timeoutMs: 120_000 });
        return [
          `Postgres ${a.action} on ${srv.name} (exit ${r.code}).${downtimeWarn}`,
          redactSecrets(lastLines(r.stdout, 12)),
          `pg_isready: ${ready.stdout.includes("ready") ? "ready" : "NOT ready — check pg_health / adpix_logs service:postgres"}`,
          `Front door: ${gate.stdout.trim()}`,
        ].join("\n");
      });
    },
  },
];
