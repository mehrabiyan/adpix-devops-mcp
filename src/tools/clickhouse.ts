import { z } from "zod";
import { withSession } from "../deps.js";
import type { Session } from "../ssh.js";
import { COMPOSE_PROJECT, readEnvVar, waitHealthyCmd, uploadFile } from "../adpix.js";
import { shq, lastLines, table, redactSecrets } from "../util.js";
import {
  recommendSettings,
  defaultBudgetMB,
  formatBytes,
  renderServerXml,
  renderProfileXml,
} from "../clickhouse/tune.js";
import type { ToolDef } from "./types.js";

const serverParam = z.string().optional().describe("Registered server name. Omit to use the default server.");

/** Production compose invocation (no leading `cd` — callers add it). Mirrors composeCmd. */
const DC = `docker compose -p ${COMPOSE_PROJECT} -f compose.yaml -f compose.prod.yaml`;

interface ChCtx {
  user: string;
  db: string;
}

async function chCtx(s: Session, dir: string): Promise<ChCtx> {
  return {
    user: (await readEnvVar(s, dir, "CLICKHOUSE_USER")) || "default",
    db: (await readEnvVar(s, dir, "CLICKHOUSE_DB")) || "sovereign",
  };
}

/**
 * A clickhouse-client invocation run via `sh -c` INSIDE the container, so the
 * password is read from the container's own $CLICKHOUSE_PASSWORD env (set by
 * compose) and never appears in the command we send over the wire. The whole
 * inner string is single-quoted on the host side, so the host shell never
 * expands $CLICKHOUSE_PASSWORD — only the container's sh does. `query` must carry
 * its own FORMAT clause (chq appends TabSeparated for reads).
 */
function chClientRaw(c: ChCtx, query: string): string {
  const inner =
    `clickhouse-client --user ${shq(c.user)} --password "$CLICKHOUSE_PASSWORD" ` +
    `--database ${shq(c.db)} --query ${shq(query)}`;
  return `${DC} exec -T clickhouse sh -c ${shq(inner)}`;
}

/** Run a read query (TabSeparated) inside the clickhouse container. */
async function chq(s: Session, dir: string, c: ChCtx, query: string, timeoutMs = 60_000) {
  return s.exec(`cd ${shq(dir)} && ${chClientRaw(c, query + " FORMAT TabSeparated")} 2>&1`, { timeoutMs });
}

/** Run a DDL / statement (no FORMAT). Returns exit code + merged output. */
async function chDDL(s: Session, dir: string, c: ChCtx, stmt: string, timeoutMs = 180_000) {
  return s.exec(`cd ${shq(dir)} && ${chClientRaw(c, stmt)} 2>&1`, { timeoutMs });
}

/** Parse TabSeparated output. CH escapes \t and \n inside values, so split is safe. */
function tsv(out: string): string[][] {
  const t = out.replace(/\n+$/, "");
  return t ? t.split("\n").map((l) => l.split("\t")) : [];
}

async function ensureInstalled(s: Session, dir: string): Promise<string | null> {
  const r = await s.exec(`test -d ${shq(dir + "/.git")} && echo yes || echo no`);
  return r.stdout.trim() === "yes" ? null : `No AdPix checkout at ${dir} — install it first (adpix_install).`;
}

/** The durable ClickHouse tables backup.sh/restore.sh cover. raw_events_jsonl is the analytical rebuild source. */
const DURABLE_TABLES = ["events_local", "raw_events_jsonl", "distinct_id_overrides"];

/**
 * Per-table TTL time expression (from migrations/clickhouse). ch_retention uses
 * these to MODIFY TTL / DROP PARTITION without the caller knowing the schema.
 * events_local row shape + sort key are FROZEN, but TTL is metadata-only (ADR-0010).
 */
const RETENTION_EXPR: Record<string, string> = {
  events_local: "toDateTime(event_time)",
  raw_events_jsonl: "toDateTime(received_at)",
  sessions_local: "toDateTime(session_start)",
  daily_metrics_local: "day",
  heatmap_events: "toDateTime(event_time)",
  heatmap_snapshots: "toDateTime(captured_at)",
  heatmap_dom_snapshots: "toDateTime(captured_at)",
  bot_events: "toDateTime(received_at)",
};

export const clickhouseTools: ToolDef[] = [
  {
    name: "ch_health",
    title: "ClickHouse health snapshot",
    description:
      "Read-only health check of the AdPix ClickHouse (the analytical truth): version, on-disk size, active " +
      "part counts + per-partition part pressure (merge backlog), largest tables with rows + compression ratio, " +
      "in-flight merges + unfinished mutations, ReplicatedMergeTree status (read-only replicas, replication delay, " +
      "queue), memory tracking vs the server cap, long-running queries, and recent server errors. Ends with a verdict.",
    schema: { server: serverParam },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const notInstalled = await ensureInstalled(s, dir);
        if (notInstalled) return notInstalled;
        const c = await chCtx(s, dir);

        const m = await chq(
          s, dir, c,
          "SELECT version(), " +
            "(SELECT formatReadableSize(sum(bytes_on_disk)) FROM system.parts WHERE active), " +
            "(SELECT count() FROM system.parts WHERE active), " +
            "(SELECT count() FROM system.merges), " +
            "(SELECT count() FROM system.mutations WHERE not is_done), " +
            "(SELECT count() FROM system.replicas), " +
            "(SELECT countIf(is_readonly) FROM system.replicas), " +
            "(SELECT toString(max(absolute_delay)) FROM system.replicas), " +
            "(SELECT formatReadableSize(value) FROM system.metrics WHERE metric='MemoryTracking'), " +
            "(SELECT value FROM system.server_settings WHERE name='max_server_memory_usage'), " +
            "(SELECT count() FROM system.processes WHERE elapsed>60), " +
            "(SELECT count() FROM system.errors WHERE value>0 AND last_error_time>now()-3600)"
        );
        if (m.code !== 0 || !m.stdout.trim()) {
          return `Couldn't query ClickHouse on ${srv.name} (is the stack up? try health_check):\n${lastLines(m.stdout, 15)}`;
        }
        const [ver = "?", size = "?", parts = "0", merges = "0", muts = "0", replTables = "0", roReplicas = "0", maxDelay = "0", mem = "?", memCap = "0", longQ = "0", errs = "0"] =
          tsv(m.stdout)[0] ?? [];

        const problems: string[] = [];
        if (Number(roReplicas) > 0) problems.push(`${roReplicas} replica(s) READ-ONLY — replication is stuck (ch_replication mode:status / sync)`);
        if (Number(maxDelay) > 60) problems.push(`replication delay ${maxDelay}s behind the leader`);
        if (Number(muts) > 0) problems.push(`${muts} unfinished mutation(s) — ALTER/DELETE work still running`);
        if (Number(longQ) > 0) problems.push(`${longQ} query(ies) running >60s`);
        if (Number(errs) > 0) problems.push(`${errs} distinct server error(s) in the last hour (see below)`);
        if (memCap !== "0" && mem !== "?") {
          const memBytes = parseHumanSize(mem);
          if (memBytes / Number(memCap) > 0.9) problems.push(`memory ${mem} is >90% of the ${formatBytes(Number(memCap))} server cap — queries may start failing`);
        }

        const big = tsv((await chq(s, dir, c,
          "SELECT table, formatReadableSize(sum(bytes_on_disk)), toString(sum(rows)), toString(count()), " +
          "toString(round(sum(data_uncompressed_bytes)/greatest(sum(data_compressed_bytes),1),1)) " +
          "FROM system.parts WHERE active AND database=currentDatabase() GROUP BY table ORDER BY sum(bytes_on_disk) DESC LIMIT 8")).stdout);

        const pressure = tsv((await chq(s, dir, c,
          "SELECT table, toString(count()), toString(uniqExact(partition)), " +
          "toString(round(count()/greatest(uniqExact(partition),1),1)) " +
          "FROM system.parts WHERE active AND database=currentDatabase() GROUP BY table " +
          "HAVING count()>200 ORDER BY count() DESC LIMIT 8")).stdout);
        for (const p of pressure) if (Number(p[3]) > 60) problems.push(`${p[0]}: ~${p[3]} parts/partition — merges are falling behind (ch_optimize)`);

        const activeMerges = tsv((await chq(s, dir, c,
          "SELECT table, toString(round(elapsed,1)), toString(round(progress*100,1)), formatReadableSize(memory_usage) " +
          "FROM system.merges ORDER BY elapsed DESC LIMIT 5")).stdout);

        let repl = "";
        if (Number(replTables) > 0) {
          const r = tsv((await chq(s, dir, c,
            "SELECT table, toString(is_readonly), toString(absolute_delay), toString(queue_size), toString(parts_to_check), toString(active_replicas), toString(total_replicas) " +
            "FROM system.replicas ORDER BY absolute_delay DESC LIMIT 10")).stdout);
          repl = "Replicated tables:\n" + table(["TABLE", "RO", "DELAY s", "QUEUE", "TO-CHECK", "ACTIVE", "TOTAL"], r);
        } else {
          repl = "No ReplicatedMergeTree tables (single-node MergeTree — see ch_replication mode:enable-plan for HA).";
        }

        const errors = Number(errs) > 0
          ? tsv((await chq(s, dir, c,
              "SELECT name, toString(value), substr(replaceAll(last_error_message,'\\n',' '),1,70) " +
              "FROM system.errors WHERE value>0 ORDER BY last_error_time DESC LIMIT 5")).stdout)
          : [];

        const verdict = problems.length === 0 ? "HEALTHY" : problems.some((p) => /READ-ONLY|stuck|>90%|failing/.test(p)) ? "NEEDS ATTENTION" : "OK with warnings";
        return [
          `# ClickHouse health — ${srv.name} (${ver})  —  ${verdict}`,
          problems.length ? "Findings:\n" + problems.map((p) => `  - ${p}`).join("\n") : "No problems found.",
          ``,
          `On-disk ${size} · ${parts} active parts · ${merges} merge(s) running · ${muts} mutation(s) pending · memory ${mem}${memCap !== "0" ? ` / cap ${formatBytes(Number(memCap))}` : " (no server cap set — ch_tune)"}`,
          ``,
          `## Role / replication\n${repl}`,
          ``,
          `## Largest tables\n${big.length ? table(["TABLE", "SIZE", "ROWS", "PARTS", "COMPRESS x"], big) : "(none)"}`,
          pressure.length ? `\n## Part pressure (>200 parts)\n${table(["TABLE", "PARTS", "PARTITIONS", "PER-PART"], pressure)}` : "",
          activeMerges.length ? `\n## In-flight merges\n${table(["TABLE", "ELAPSED s", "PROGRESS %", "MEMORY"], activeMerges)}` : "",
          errors.length ? `\n## Recent errors\n${table(["ERROR", "COUNT", "LAST MESSAGE"], errors)}` : "",
        ].filter(Boolean).join("\n");
      });
    },
  },

  {
    name: "ch_tune",
    title: "Tune ClickHouse config",
    description:
      "Compute tuned ClickHouse settings for AdPix's analytical workload from a memory budget + cores + disk type, " +
      "diff them against the live system.server_settings / system.settings, and (apply:true) write them as a " +
      "config.d + users.d drop-in. IMPORTANT: on a single VM ClickHouse is co-located with Postgres, so the " +
      "headline setting is an ABSOLUTE max_server_memory_usage cap (~60% of host by default) — NOT the dangerous " +
      "default ratio of total host RAM, which would starve Postgres. Dry-run unless apply:true.",
    schema: {
      server: serverParam,
      memoryBudgetMB: z.number().int().min(256).optional().describe("RAM to dedicate to ClickHouse. Default: ~60% of host RAM if co-located with Postgres"),
      diskType: z.enum(["ssd", "hdd"]).default("ssd"),
      coLocated: z.boolean().default(true).describe("Is ClickHouse on the same host as Postgres/app? (drives the default budget)"),
      apply: z.boolean().default(false).describe("false = show the diff + drop-in XML; true = write the config.d/users.d drop-ins on the server"),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; memoryBudgetMB?: number; diskType: "ssd" | "hdd"; coLocated: boolean; apply: boolean };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const notInstalled = await ensureInstalled(s, dir);
        if (notInstalled) return notInstalled;
        const c = await chCtx(s, dir);

        const host = await s.exec("nproc; free -m | awk '/^Mem:/{print $2}'");
        const [coresStr = "2", hostRamStr = "4096"] = host.stdout.trim().split("\n");
        const cores = Number(coresStr) || 2;
        const hostRam = Number(hostRamStr) || 4096;
        const budget = a.memoryBudgetMB ?? defaultBudgetMB(hostRam, a.coLocated);

        const recs = recommendSettings({ memoryBudgetMB: budget, cores, diskType: a.diskType });

        const srvCur = new Map<string, string>();
        for (const [k, v] of tsv((await chq(s, dir, c,
          `SELECT name, value FROM system.server_settings WHERE name IN (${recs.filter((r) => r.scope === "server").map((r) => `'${r.key}'`).join(",")})`)).stdout)) srvCur.set(k, v);
        const profCur = new Map<string, string>();
        for (const [k, v] of tsv((await chq(s, dir, c,
          `SELECT name, value FROM system.settings WHERE name IN (${recs.filter((r) => r.scope === "profile").map((r) => `'${r.key}'`).join(",")})`)).stdout)) profCur.set(k, v);

        const curHuman = (r: { key: string; scope: string }) => {
          const raw = (r.scope === "server" ? srvCur : profCur).get(r.key) ?? "?";
          if (raw === "?" || raw === "0") return raw === "0" ? "0 (unset)" : "?";
          return /^\d{7,}$/.test(raw) ? formatBytes(Number(raw)) : raw;
        };
        const diff = table(
          ["SETTING", "SCOPE", "CURRENT", "RECOMMENDED", "RESTART?"],
          recs.map((r) => [r.key, r.scope, curHuman(r), r.human, r.needsRestart ? "yes" : ""])
        );

        const serverXml = renderServerXml(recs);
        const profileXml = renderProfileXml(recs);
        const head = [
          `# ClickHouse tuning — ${srv.name}`,
          `Host: ${cores} vCPU, ${hostRam}MB RAM. ClickHouse budget: ${formatBytes(budget * 1024 * 1024)}` +
            (a.coLocated ? ` (~${Math.round((budget / hostRam) * 100)}% — co-located with Postgres, which keeps ~25%)` : ` (dedicated host)`),
          ``,
          diff,
          ``,
          `Rationale:\n` + recs.map((r) => `  - ${r.key}: ${r.rationale}`).join("\n"),
        ];

        if (!a.apply) {
          return head.concat([
            ``,
            `## config.d/zz-tuning.xml (server scope)\n${serverXml}`,
            `## users.d/zz-tuning.xml (default profile)\n${profileXml}`,
            `Dry-run — nothing written. Re-run with apply:true to write both drop-ins under <adpixDir>/ops/clickhouse/.`,
          ]).join("\n");
        }

        await uploadFile(s, `${dir}/ops/clickhouse/config.d/zz-tuning.xml`, serverXml, "644");
        await uploadFile(s, `${dir}/ops/clickhouse/users.d/zz-tuning.xml`, profileXml, "644");
        // Are these drop-ins actually mounted into the container? (compose mounts single files by default.)
        const mounted = (await s.exec(`cd ${shq(dir)} && ${DC} exec -T clickhouse test -f /etc/clickhouse-server/config.d/zz-tuning.xml && echo yes || echo no`)).stdout.trim() === "yes";
        const restartKeys = recs.filter((r) => r.needsRestart).map((r) => r.key);
        if (mounted) {
          const r = await chDDL(s, dir, c, "SYSTEM RELOAD CONFIG");
          return head.concat([
            ``,
            `## Applied`,
            `Wrote ops/clickhouse/{config.d,users.d}/zz-tuning.xml and ran SYSTEM RELOAD CONFIG (${r.code === 0 ? "ok" : "FAILED: " + lastLines(r.stdout, 8)}).`,
            restartKeys.length ? `Restart-context settings need ch_redeploy action:restart to take effect: ${restartKeys.join(", ")}.` : `All reloadable — live now.`,
          ]).join("\n");
        }
        return head.concat([
          ``,
          `## Written (NOT yet live)`,
          `Wrote ops/clickhouse/config.d/zz-tuning.xml + ops/clickhouse/users.d/zz-tuning.xml on ${srv.name}.`,
          `These drop-ins are not mounted into the container yet — compose mounts single files, not the dirs. Add to the clickhouse service volumes:`,
          `  - ./ops/clickhouse/config.d/zz-tuning.xml:/etc/clickhouse-server/config.d/zz-tuning.xml:ro`,
          `  - ./ops/clickhouse/users.d/zz-tuning.xml:/etc/clickhouse-server/users.d/zz-tuning.xml:ro`,
          `then ch_redeploy action:recreate. (config.d picks up on reload; max_server_memory_usage + background_pool_size need the restart that recreate gives.)`,
        ]).join("\n");
      });
    },
  },

  {
    name: "ch_optimize",
    title: "Optimize ClickHouse (parts + merges)",
    description:
      "Find optimization opportunities: tables with too many parts per partition (merge backlog), ReplacingMergeTree " +
      "tables carrying dedup debt, low compression ratios, and the top time-consuming queries (system.query_log). " +
      "With apply:true runs OPTIMIZE TABLE ... FINAL on small high-part tables only (size-capped to avoid rewriting " +
      "huge tables like events_local). Big-table OPTIMIZE + index/projection changes are advised, never auto-run.",
    schema: {
      server: serverParam,
      apply: z.boolean().default(false).describe("true = OPTIMIZE FINAL the small, high-part tables (below maxOptimizeGB)"),
      maxOptimizeGB: z.number().min(0.1).default(5).describe("Skip OPTIMIZE on tables bigger than this (GB) — they must be done per-partition off-peak"),
    },
    annotations: { destructiveHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; apply: boolean; maxOptimizeGB: number };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const notInstalled = await ensureInstalled(s, dir);
        if (notInstalled) return notInstalled;
        const c = await chCtx(s, dir);

        const pressure = tsv((await chq(s, dir, c,
          "SELECT table, toString(count()), toString(uniqExact(partition)), " +
          "toString(round(count()/greatest(uniqExact(partition),1),1)), toString(sum(bytes_on_disk)) " +
          "FROM system.parts WHERE active AND database=currentDatabase() GROUP BY table " +
          "HAVING count()>100 ORDER BY count()/greatest(uniqExact(partition),1) DESC LIMIT 12")).stdout);

        const replacing = tsv((await chq(s, dir, c,
          "SELECT name FROM system.tables WHERE database=currentDatabase() AND engine LIKE '%ReplacingMergeTree%' ORDER BY name")).stdout).map((r) => r[0]);

        const compress = tsv((await chq(s, dir, c,
          "SELECT table, toString(round(sum(data_uncompressed_bytes)/greatest(sum(data_compressed_bytes),1),1)), formatReadableSize(sum(bytes_on_disk)) " +
          "FROM system.parts WHERE active AND database=currentDatabase() GROUP BY table " +
          "HAVING sum(bytes_on_disk)>10000000 ORDER BY sum(data_uncompressed_bytes)/greatest(sum(data_compressed_bytes),1) ASC LIMIT 6")).stdout);

        const slowRes = await chq(s, dir, c,
          "SELECT substr(normalizeQuery(any(query)),1,55), toString(count()), toString(round(avg(query_duration_ms))), toString(round(sum(query_duration_ms))) " +
          "FROM system.query_log WHERE type='QueryFinish' AND event_time>now()-86400 AND query NOT ILIKE '%system.%' " +
          "GROUP BY normalized_query_hash ORDER BY sum(query_duration_ms) DESC LIMIT 8");
        const slow = slowRes.code === 0 ? tsv(slowRes.stdout) : [];

        const out: string[] = [`# ClickHouse optimization — ${srv.name}`];
        out.push(`\n## Part pressure (parts per partition — high = merges lagging)\n${pressure.length ? table(["TABLE", "PARTS", "PARTITIONS", "PER-PART", "BYTES"], pressure.map((r) => [r[0], r[1], r[2], r[3], formatBytes(Number(r[4]))])) : "none — merges keeping up"}`);
        out.push(`\n## ReplacingMergeTree tables (need OPTIMIZE FINAL or FINAL/argMax reads to dedup)\n${replacing.length ? replacing.map((t) => "  - " + t).join("\n") + "\n  (the identity-job runs a nightly OPTIMIZE; reads should still use FINAL or version-aware aggregation)" : "none"}`);
        out.push(`\n## Lowest compression ratios (candidates for codec/type review)\n${compress.length ? table(["TABLE", "RATIO x", "SIZE"], compress) : "none"}`);
        out.push(`\n## Top queries by total time (24h)\n${slow.length ? table(["QUERY", "CALLS", "MEAN ms", "TOTAL ms"], slow) : "(system.query_log empty or disabled)"}`);

        const cap = a.maxOptimizeGB * 1024 * 1024 * 1024;
        const candidates = pressure.filter((r) => Number(r[3]) > 30 && Number(r[4]) <= cap).map((r) => r[0]);
        const tooBig = pressure.filter((r) => Number(r[3]) > 30 && Number(r[4]) > cap).map((r) => r[0]);
        if (a.apply && candidates.length) {
          const results: string[] = [];
          for (const t of candidates.slice(0, 5)) {
            const r = await chDDL(s, dir, c, `OPTIMIZE TABLE ${t} FINAL`, 1_800_000);
            results.push(`  - ${t}: ${r.code === 0 ? "OPTIMIZE FINAL done" : "FAILED — " + lastLines(r.stdout, 4)}`);
          }
          out.push(`\n## Applied\n${results.join("\n")}`);
          if (tooBig.length) out.push(`Skipped (>${a.maxOptimizeGB}GB — OPTIMIZE per-partition off-peak instead): ${tooBig.join(", ")}`);
        } else if (a.apply) {
          out.push(`\n## Applied\nNothing small + bloated enough to OPTIMIZE${tooBig.length ? ` (skipped big tables: ${tooBig.join(", ")})` : ""}.`);
        } else {
          out.push(`\nRe-run with apply:true to OPTIMIZE FINAL the small high-part tables (≤${a.maxOptimizeGB}GB). Big tables + drops/projections are left to you.`);
        }
        return out.join("\n");
      });
    },
  },

  {
    name: "ch_harden",
    title: "Audit ClickHouse security",
    description:
      "Read-only security posture check for ClickHouse: the `default` user's password (must be set in prod via " +
      "CLICKHOUSE_PASSWORD — ADR-0039), host-port exposure (CH must stay on the private compose network — never " +
      "publish 8123/9000), passwordless users, access-management grants, query logging, and a DoS-guard concurrency " +
      "cap. Reports findings + the exact out-of-band fixes (.env / compose / ch_tune). Does not change anything.",
    schema: { server: serverParam },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const notInstalled = await ensureInstalled(s, dir);
        if (notInstalled) return notInstalled;
        const c = await chCtx(s, dir);

        const appEnv = (await readEnvVar(s, dir, "APP_ENV")).toLowerCase();
        const chPass = await readEnvVar(s, dir, "CLICKHOUSE_PASSWORD");
        const portPub = (await s.exec(`cd ${shq(dir)} && ${DC} ps --format '{{.Service}} {{.Publishers}}' 2>/dev/null | grep -i clickhouse || true`)).stdout.trim();
        const noPwUsers = tsv((await chq(s, dir, c, "SELECT name FROM system.users WHERE auth_type='no_password'")).stdout).map((r) => r[0]);
        const grantors = tsv((await chq(s, dir, c, "SELECT name FROM system.users WHERE access_management=1")).stdout).map((r) => r[0]);
        const logQueries = (await chq(s, dir, c, "SELECT value FROM system.settings WHERE name='log_queries'")).stdout.trim();
        const maxConc = (await chq(s, dir, c, "SELECT value FROM system.server_settings WHERE name='max_concurrent_queries'")).stdout.trim();

        const findings: { level: "FAIL" | "WARN" | "PASS"; msg: string }[] = [];
        const add = (level: "FAIL" | "WARN" | "PASS", msg: string) => findings.push({ level, msg });

        const isProd = appEnv === "production";
        if (chPass) add("PASS", "CLICKHOUSE_PASSWORD is set — the `default` user is authenticated");
        else if (isProd) add("FAIL", "APP_ENV=production but CLICKHOUSE_PASSWORD is EMPTY — ingest/api fail-fast (ADR-0039); set it in .env + ch_redeploy");
        else add("WARN", "CLICKHOUSE_PASSWORD empty — acceptable in dev on the private network; MUST be set before going to prod");

        /8123|9000|9009/.test(portPub) && /0\.0\.0\.0|:::/.test(portPub)
          ? add("FAIL", `ClickHouse port published on the host (${portPub}) — CH must stay internal-only (no host port in prod)`)
          : add("PASS", "no ClickHouse port published to the host (private network only)");

        noPwUsers.length
          ? add(isProd ? "FAIL" : "WARN", `passwordless user(s): ${noPwUsers.join(", ")}${isProd ? "" : " (the dev default user — fine on a private net)"}`)
          : add("PASS", "no passwordless users");
        grantors.length <= 1
          ? add("PASS", `access management limited to: ${grantors.join(", ") || "none"}`)
          : add("WARN", `${grantors.length} users can manage access: ${grantors.join(", ")} — keep this minimal`);
        logQueries === "1" ? add("PASS", "log_queries on (query audit trail in system.query_log)") : add("WARN", "log_queries off — enable for an audit trail + ch_optimize insight");
        maxConc && maxConc !== "0" ? add("PASS", `max_concurrent_queries = ${maxConc} (DoS guard)`) : add("WARN", "max_concurrent_queries unset/0 — set a cap (ch_tune) so a query flood can't exhaust memory");

        const order = { FAIL: 0, WARN: 1, PASS: 2 };
        const report = findings.sort((x, y) => order[x.level] - order[y.level]).map((f) => `${f.level.padEnd(4)} ${f.msg}`).join("\n");
        const fails = findings.filter((f) => f.level === "FAIL").length;
        const warns = findings.filter((f) => f.level === "WARN").length;
        return [
          `# ClickHouse hardening — ${srv.name}`,
          `Verdict: ${fails ? "ACTION REQUIRED" : warns ? "ROOM TO HARDEN" : "GOOD"} (${fails} fail, ${warns} warn)`,
          ``,
          report,
          ``,
          `Fixes are out-of-band (ClickHouse security lives in config, not SQL): set CLICKHOUSE_PASSWORD in .env (keep it out of tool output); keep ports unpublished (compose.prod publishes none); set limits via ch_tune; then ch_redeploy.`,
        ].join("\n");
      });
    },
  },

  {
    name: "ch_backup",
    title: "Backup ClickHouse (verified)",
    description:
      "On-demand verified backup of the durable ClickHouse tables (events_local, raw_events_jsonl, " +
      "distinct_id_overrides — raw_events_jsonl is the analytical rebuild source) using ClickHouse Native export, " +
      "plus each table's schema, written under <adpixDir>/backups/ch-<ts>/ with a MANIFEST of row counts. Mirrors " +
      "scripts/backup.sh so scripts/restore.sh (and ch_restore_db) can reverse it. Verifies every export is non-empty.",
    schema: {
      server: serverParam,
      tables: z.array(z.string()).optional().describe(`Tables to back up. Default: ${DURABLE_TABLES.join(", ")}`),
    },
    handler: async (deps, args) => {
      const a = args as { server?: string; tables?: string[] };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const notInstalled = await ensureInstalled(s, dir);
        if (notInstalled) return notInstalled;
        const c = await chCtx(s, dir);
        const tables = (a.tables?.length ? a.tables : DURABLE_TABLES).filter((t) => /^[a-zA-Z0-9_]+$/.test(t));

        const steps = tables.flatMap((t) => [
          `${chClientRaw(c, `SELECT * FROM ${c.db}.${t} FORMAT Native`)} > "$O/${t}.native"`,
          `${chClientRaw(c, `SHOW CREATE TABLE ${c.db}.${t} FORMAT TabSeparatedRaw`)} > "$O/${t}.schema.sql" 2>/dev/null`,
          `echo "${t}=$(${chClientRaw(c, `SELECT count() FROM ${c.db}.${t}`)})" >> "$O/MANIFEST.txt"`,
        ]);
        const script =
          `cd ${shq(dir)} && O=backups/ch-$(date +%Y%m%d-%H%M%S) && mkdir -p "$O" && ` +
          `echo "clickhouse backup $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$O/MANIFEST.txt" && ` +
          steps.join(" && ") +
          ` && echo "--- sizes ---" && du -sh "$O"/*.native && echo "OK $O" && cat "$O/MANIFEST.txt"`;
        const r = await s.exec(script, { timeoutMs: 3_600_000 });
        if (r.code !== 0) return `ClickHouse backup FAILED (exit ${r.code}):\n${lastLines(redactSecrets(r.stdout), 25)}`;
        // verify: any zero-byte .native is a failed export
        const empty = (await s.exec(`cd ${shq(dir)} && find "$(ls -1dt backups/ch-*/ | head -1)" -name '*.native' -size 0 2>/dev/null`)).stdout.trim();
        return [
          `Verified ClickHouse backup on ${srv.name}:`,
          lastLines(r.stdout, 18),
          empty ? `\nWARNING: zero-byte export(s) — these tables came back empty:\n${empty}` : `\nAll Native exports are non-empty (readable).`,
        ].join("\n");
      });
    },
  },

  {
    name: "ch_restore_db",
    title: "Restore ClickHouse from a backup",
    description:
      "Restore ClickHouse tables from a ch-<ts> Native backup made by ch_backup. DESTRUCTIVE — TRUNCATEs each " +
      "target table then re-inserts (FORMAT Native) and OPTIMIZE FINAL, exactly like scripts/restore.sh. Requires " +
      "confirm:true. Health-gates the stack afterward.",
    schema: {
      server: serverParam,
      backupDir: z.string().describe('Backup dir relative to adpixDir, e.g. "backups/ch-20260615-030000"'),
      tables: z.array(z.string()).optional().describe("Subset to restore. Default: every *.native in the backup dir"),
      confirm: z.boolean().default(false).describe("Must be true — this overwrites live ClickHouse tables"),
    },
    annotations: { destructiveHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; backupDir: string; tables?: string[]; confirm: boolean };
      if (!a.confirm) return "REFUSED: restore TRUNCATEs + overwrites live ClickHouse tables. Re-run with confirm:true after double-checking backupDir.";
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const notInstalled = await ensureInstalled(s, dir);
        if (notInstalled) return notInstalled;
        const c = await chCtx(s, dir);

        const exists = await s.exec(`test -d ${shq(dir)}/${shq(a.backupDir)} && echo yes || echo no`);
        if (exists.stdout.trim() !== "yes") {
          const avail = await s.exec(`ls -1dt ${shq(dir)}/backups/ch-*/ 2>/dev/null | head -10`);
          return `Backup dir "${a.backupDir}" not found. Available:\n${avail.stdout.trim() || "(none — run ch_backup first)"}`;
        }
        const present = tsv((await s.exec(`cd ${shq(dir)}/${shq(a.backupDir)} && ls -1 *.native 2>/dev/null | sed 's/\\.native$//'`)).stdout).map((r) => r[0]);
        const want = a.tables?.length ? a.tables.filter((t) => present.includes(t)) : present;
        const tables = want.filter((t) => /^[a-zA-Z0-9_]+$/.test(t));
        if (!tables.length) return `No matching .native files in ${a.backupDir} (found: ${present.join(", ") || "none"}).`;

        const results: string[] = [];
        for (const t of tables) {
          const trunc = await chDDL(s, dir, c, `TRUNCATE TABLE IF EXISTS ${c.db}.${t}`);
          const ins = await s.exec(
            `cd ${shq(dir)} && cat ${shq(a.backupDir + "/" + t + ".native")} | ${chClientRaw(c, `INSERT INTO ${c.db}.${t} FORMAT Native`)} 2>&1`,
            { timeoutMs: 3_600_000 }
          );
          await chDDL(s, dir, c, `OPTIMIZE TABLE ${c.db}.${t} FINAL`).catch(() => undefined);
          const cnt = (await chq(s, dir, c, `SELECT count() FROM ${c.db}.${t}`)).stdout.trim();
          results.push(`  - ${t}: ${trunc.code === 0 && ins.code === 0 ? `restored, now ${cnt} rows` : `FAILED — ${lastLines(ins.stdout || trunc.stdout, 4)}`}`);
        }
        const gate = await s.exec(waitHealthyCmd(90), { timeoutMs: 120_000 });
        return [`ClickHouse restore from ${a.backupDir} on ${srv.name}:`, results.join("\n"), `Health: ${gate.stdout.trim()}`].join("\n");
      });
    },
  },

  {
    name: "ch_replication",
    title: "ClickHouse replication / HA",
    description:
      "Manage ReplicatedMergeTree + embedded Keeper (ADR-0042). Modes: status (system.replicas + Keeper " +
      "reachability); enable-plan (how to go from single-node MergeTree to replicated — the frozen-surface caveat " +
      "is that events_local only converts on a FRESH replicated deploy, so it's backup → CH_REPLICATED=1 → " +
      "re-migrate → restore); add-replica-steps (bring up a 2nd replica node); sync (SYSTEM SYNC REPLICA on every " +
      "replicated table — confirm:true, can block while the queue drains).",
    schema: {
      server: serverParam,
      mode: z.enum(["status", "enable-plan", "add-replica-steps", "sync"]).default("status"),
      confirm: z.boolean().default(false).describe("sync: required (can block while replication queues drain)"),
    },
    annotations: { destructiveHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; mode: string; confirm: boolean };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const notInstalled = await ensureInstalled(s, dir);
        if (notInstalled) return notInstalled;
        const c = await chCtx(s, dir);

        if (a.mode === "status") {
          const reps = tsv((await chq(s, dir, c,
            "SELECT table, toString(is_leader), toString(is_readonly), toString(absolute_delay), toString(queue_size), toString(parts_to_check), toString(active_replicas), toString(total_replicas) " +
            "FROM system.replicas ORDER BY absolute_delay DESC")).stdout);
          const mounted = (await s.exec(`cd ${shq(dir)} && ${DC} exec -T clickhouse test -f /etc/clickhouse-server/config.d/replication.xml && echo yes || echo no`)).stdout.trim() === "yes";
          let keeper = "not checked";
          if (mounted) {
            const k = await chq(s, dir, c, "SELECT count() FROM system.zookeeper WHERE path='/'");
            keeper = k.code === 0 ? "reachable (embedded Keeper answering)" : "UNREACHABLE — Keeper down, replicated writes will block";
          }
          if (!reps.length) {
            return [
              `# ClickHouse replication — ${srv.name}`,
              `No ReplicatedMergeTree tables — this is a single-node MergeTree deployment.`,
              `replication.xml mounted: ${mounted ? "yes (Keeper available, ready to convert)" : "no (compose.prod mounts it; dev does not)"}`,
              mounted ? `Keeper: ${keeper}` : "",
              ``,
              `To gain HA, see mode:enable-plan.`,
            ].filter(Boolean).join("\n");
          }
          const stuck = reps.filter((r) => r[2] === "1").map((r) => r[0]);
          return [
            `# ClickHouse replication — ${srv.name} (${reps.length} replicated table(s))`,
            `Keeper: ${keeper}`,
            stuck.length ? `READ-ONLY (stuck): ${stuck.join(", ")} — try mode:sync, check Keeper + disk` : `All replicas writable.`,
            ``,
            table(["TABLE", "LEADER", "RO", "DELAY s", "QUEUE", "TO-CHECK", "ACTIVE", "TOTAL"], reps),
          ].join("\n");
        }

        if (a.mode === "enable-plan") {
          return [
            `# Enable ClickHouse replication (HA) — ${srv.name}`,
            `ADR-0042: a single node becomes replication-capable via the embedded Keeper in ops/clickhouse/config.d/replication.xml`,
            `(compose.prod already mounts it; CH_REPLICATED defaults to 1 there). The catch: the migrate runner only`,
            `creates Replicated* engines on a FRESH database — existing plain-MergeTree tables (incl. the FROZEN`,
            `events_local) do NOT convert in place. So:`,
            ``,
            `1. ch_backup (Native export of the durable tables — this is your data).`,
            `2. Ensure replication.xml is mounted + CH_REPLICATED=1 (compose.prod does both).`,
            `3. Recreate ClickHouse on a CLEAN data volume so migrate builds Replicated* tables:`,
            `   - stop the stack, remove the chdata volume (DESTRUCTIVE — only after step 1), bring it back up; migrate runs.`,
            `4. ch_restore_db backupDir:<the ch-… from step 1> confirm:true — reloads the data into the new replicated tables.`,
            `5. ch_replication mode:status — confirm tables show in system.replicas + Keeper reachable.`,
            ``,
            `DR caveat (from replication.xml): a Replicated table dropped + recreated must be dropped with \`... SYNC\` first, else the stale Keeper path collides ("Replica already exists").`,
            `This is disruptive — do it off-campaign with the backup verified. To then add a SECOND node: mode:add-replica-steps.`,
          ].join("\n");
        }

        if (a.mode === "add-replica-steps") {
          return [
            `# Add a ClickHouse replica — ${srv.name}`,
            `The primary must already be replicated (mode:enable-plan done; tables visible in system.replicas).`,
            `Replicated* tables auto-clone from Keeper, so a new node with the SAME database/table names + a DISTINCT`,
            `<replica> macro joins the existing tables and back-fills automatically.`,
            ``,
            `On the new node (a fresh AdPix checkout):`,
            `1. Give it a distinct replica identity — edit ops/clickhouse/config.d/replication.xml <macros>:`,
            `     <shard>01</shard>  <replica>replica-02</replica>   (must differ from replica-01)`,
            `2. Point both nodes' <zookeeper> at a SHARED Keeper ensemble. The embedded single-node Keeper in`,
            `   replication.xml is fine for one box; for real HA run an external 3-node Keeper raft and list all`,
            `   3 in <zookeeper> on every CH node (see docs/runbooks — embedded Keeper is not a quorum).`,
            `3. Bring up ClickHouse + run migrate with CH_REPLICATED=1: it issues CREATE ... IF NOT EXISTS, the`,
            `   engine sees the existing Keeper path and registers this node as replica-02, then syncs parts.`,
            `4. ch_replication mode:status on both — total_replicas=2, active_replicas=2, delay → 0.`,
            ``,
            `Then put both CH endpoints behind the app (or a Distributed table) for read scale-out.`,
          ].join("\n");
        }

        // sync
        const reps = tsv((await chq(s, dir, c, "SELECT table FROM system.replicas")).stdout).map((r) => r[0]);
        if (!reps.length) return "No ReplicatedMergeTree tables to sync (single-node MergeTree). See mode:enable-plan.";
        if (!a.confirm) return `REFUSED: sync runs SYSTEM SYNC REPLICA on ${reps.length} table(s) and can block while queues drain. Re-run with confirm:true.`;
        const results: string[] = [];
        for (const t of reps) {
          const r = await chDDL(s, dir, c, `SYSTEM SYNC REPLICA ${c.db}.${t}`, 600_000);
          results.push(`  - ${t}: ${r.code === 0 ? "synced" : "FAILED/timeout — " + lastLines(r.stdout, 3)}`);
        }
        return `# SYSTEM SYNC REPLICA — ${srv.name}\n${results.join("\n")}\n\nRe-check with mode:status.`;
      });
    },
  },

  {
    name: "ch_retention",
    title: "ClickHouse retention / TTL (cost lever)",
    description:
      "Manage the data-retention TTLs that bound ClickHouse disk — the single biggest cost lever at scale. Modes: " +
      "status (per-table partitions by month + size + the current TTL); set-ttl (ALTER TABLE ... MODIFY TTL to N " +
      "months/days — idempotent metadata change, confirm:true since it schedules deletion of older data); " +
      "drop-partition (immediately reclaim one old month, confirm:true). Knows the time column for AdPix's tables; " +
      "events_local row shape stays FROZEN (TTL is metadata-only, ADR-0010).",
    schema: {
      server: serverParam,
      mode: z.enum(["status", "set-ttl", "drop-partition"]).default("status"),
      table: z.string().optional().describe("Target table (set-ttl / drop-partition; status shows all)"),
      interval: z.number().int().min(1).optional().describe("set-ttl: keep this many <unit> of data"),
      unit: z.enum(["DAY", "MONTH"]).default("MONTH").describe("set-ttl: interval unit"),
      partition: z.string().optional().describe("drop-partition: the partition id, e.g. '202401' (toYYYYMM)"),
      timeExpr: z.string().optional().describe("Override the TTL time expression for an unknown table, e.g. toDateTime(event_time)"),
      confirm: z.boolean().default(false).describe("Required for set-ttl + drop-partition (both delete data)"),
    },
    annotations: { destructiveHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; mode: string; table?: string; interval?: number; unit: "DAY" | "MONTH"; partition?: string; timeExpr?: string; confirm: boolean };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const notInstalled = await ensureInstalled(s, dir);
        if (notInstalled) return notInstalled;
        const c = await chCtx(s, dir);
        const validTable = (t?: string): t is string => !!t && /^[a-zA-Z0-9_]+$/.test(t);

        if (a.mode === "status") {
          const tables = tsv((await chq(s, dir, c,
            "SELECT table, formatReadableSize(sum(bytes_on_disk)), toString(count()), min(partition), max(partition) " +
            "FROM system.parts WHERE active AND database=currentDatabase() GROUP BY table ORDER BY sum(bytes_on_disk) DESC LIMIT 12")).stdout);
          const ttls = tsv((await chq(s, dir, c,
            "SELECT name, replaceAll(extract(create_table_query, 'TTL [^\\n]+'), '\\t', ' ') FROM system.tables WHERE database=currentDatabase() AND create_table_query LIKE '%TTL %'")).stdout);
          const ttlMap = new Map(ttls.map((r) => [r[0], r[1]]));
          const topPart = (a.table && validTable(a.table))
            ? tsv((await chq(s, dir, c,
                `SELECT partition, formatReadableSize(sum(bytes_on_disk)), toString(sum(rows)) FROM system.parts ` +
                `WHERE active AND database=currentDatabase() AND table='${a.table}' GROUP BY partition ORDER BY partition DESC LIMIT 12`)).stdout)
            : [];
          return [
            `# ClickHouse retention — ${srv.name}`,
            `Retention is the main disk cost lever. Shorten a TTL to cut storage; events_local keeps 25mo, raw_events_jsonl 24mo by default.`,
            ``,
            table(["TABLE", "SIZE", "PARTS", "OLDEST", "NEWEST"], tables.map((r) => [r[0], r[1], r[2], r[3], r[4]])),
            ``,
            `## Current TTLs`,
            tables.map((r) => `  - ${r[0]}: ${ttlMap.get(r[0]) ? ttlMap.get(r[0])!.trim() : "(no TTL — grows forever)"}`).join("\n"),
            topPart.length ? `\n## ${a.table} partitions (newest first)\n${table(["PARTITION", "SIZE", "ROWS"], topPart)}` : "",
            ``,
            `Shorten with mode:set-ttl table:<t> interval:<n> unit:MONTH. Reclaim one month now with mode:drop-partition.`,
          ].filter(Boolean).join("\n");
        }

        if (a.mode === "set-ttl") {
          if (!validTable(a.table)) return "set-ttl needs a valid `table`.";
          if (!a.interval) return "set-ttl needs `interval` (how many <unit> of data to keep).";
          const expr = a.timeExpr ?? RETENTION_EXPR[a.table];
          if (!expr) return `Don't know the time column for ${a.table}. Pass timeExpr (e.g. toDateTime(event_time)). Known: ${Object.keys(RETENTION_EXPR).join(", ")}.`;
          const stmt = `ALTER TABLE ${c.db}.${a.table} MODIFY TTL ${expr} + INTERVAL ${a.interval} ${a.unit} DELETE SETTINGS materialize_ttl_after_modify=0`;
          if (!a.confirm) {
            return [
              `# set-ttl (dry-run) — ${srv.name}`,
              `Would run:\n  ${stmt}`,
              ``,
              `This keeps ~${a.interval} ${a.unit.toLowerCase()}(s) of ${a.table} and schedules deletion of anything older.`,
              `materialize_ttl_after_modify=0 makes it a fast metadata change (old parts drop as merges run, not in one storm).`,
              `Re-run with confirm:true to apply. Back up first (ch_backup) if this data isn't reproducible.`,
            ].join("\n");
          }
          const r = await chDDL(s, dir, c, stmt);
          return `set-ttl on ${a.table} (${srv.name}): ${r.code === 0 ? `done — keeping ${a.interval} ${a.unit.toLowerCase()}(s). Old data drops as background merges run.` : `FAILED:\n${lastLines(r.stdout, 12)}`}`;
        }

        // drop-partition
        if (!validTable(a.table)) return "drop-partition needs a valid `table`.";
        if (!a.partition) return "drop-partition needs `partition` (e.g. '202401'). See mode:status table:<t> for the list.";
        if (!/^[0-9]+$/.test(a.partition)) return "partition must be a numeric toYYYYMM id, e.g. '202401'.";
        if (!a.confirm) return `REFUSED: dropping partition ${a.partition} of ${a.table} permanently deletes that month. Re-run with confirm:true (ch_backup first if it's not reproducible).`;
        const r = await chDDL(s, dir, c, `ALTER TABLE ${c.db}.${a.table} DROP PARTITION '${a.partition}'`);
        return `drop-partition ${a.partition} of ${a.table} (${srv.name}): ${r.code === 0 ? "done — space reclaimed as the parts delete." : `FAILED:\n${lastLines(r.stdout, 12)}`}`;
      });
    },
  },

  {
    name: "ch_redeploy",
    title: "Redeploy / restart ClickHouse",
    description:
      "Safely apply config or image changes to ClickHouse. Actions: reload (SYSTEM RELOAD CONFIG — zero downtime, " +
      "picks up config.d/users.d); restart (compose restart — brief downtime, applies restart-context server " +
      "settings); recreate (compose up -d --force-recreate — new container, same chdata volume, picks up image/env/" +
      "mount changes); upgrade-plan (print the image-bump steps). Snapshots the schema first (unless skipBackup) for " +
      "restart/recreate, then waits for readiness + health-gates.",
    schema: {
      server: serverParam,
      action: z.enum(["reload", "restart", "recreate", "upgrade-plan"]).default("restart"),
      skipBackup: z.boolean().default(false).describe("Skip the pre-change schema snapshot (data lives in the chdata volume regardless)"),
    },
    annotations: { destructiveHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; action: string; skipBackup: boolean };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const notInstalled = await ensureInstalled(s, dir);
        if (notInstalled) return notInstalled;
        const c = await chCtx(s, dir);

        if (a.action === "upgrade-plan") {
          return [
            `# ClickHouse upgrade plan — ${srv.name}`,
            `ClickHouse runs as clickhouse/clickhouse-server:25.3 with the chdata volume. Unlike Postgres, the CH`,
            `data dir is forward-compatible, so a minor/patch bump is a rolling image swap — no dump & restore.`,
            ``,
            `1. Read the release notes for the target version (CH calls out breaking changes + settings renames).`,
            `2. ch_backup (Native export of the durable tables) — cheap insurance; CH downgrades are NOT supported.`,
            `3. Bump the image tag in compose (clickhouse/clickhouse-server:NN.N).`,
            `4. ch_redeploy action:recreate — new container, same chdata volume; it upgrades on-disk metadata in place.`,
            `5. ch_health + the relevant make verify-* gates. If a setting was renamed, fix the config.d/users.d drop-in + reload.`,
            ``,
            `Jump one major/LTS at a time (e.g. 24.3 → 24.8 → 25.3), not many at once. Do it off-campaign.`,
          ].join("\n");
        }

        if (a.action === "reload") {
          const r = await chDDL(s, dir, c, "SYSTEM RELOAD CONFIG");
          return `Reloaded ClickHouse config on ${srv.name} (exit ${r.code}) — config.d/users.d drop-ins are re-read. Restart-context server settings (max_server_memory_usage, background_pool_size) still need action:restart.`;
        }

        if (!a.skipBackup) {
          // Best-effort schema snapshot (one query — all CREATE statements). The real data lives
          // in the chdata volume regardless, so unlike pg_redeploy a failure here is not fatal.
          await s.exec(
            `cd ${shq(dir)} && mkdir -p backups && O=backups/ch-schema-$(date +%Y%m%d-%H%M%S).sql && ` +
              `${chClientRaw(c, "SELECT create_table_query || ';\\n\\n' FROM system.tables WHERE database=currentDatabase() AND engine LIKE '%MergeTree%' FORMAT TabSeparatedRaw")} > "$O" 2>/dev/null`,
            { timeoutMs: 120_000 }
          );
        }
        const cmd = a.action === "recreate" ? `${DC} up -d --force-recreate clickhouse` : `${DC} restart clickhouse`;
        const r = await s.exec(`cd ${shq(dir)} && ${cmd} 2>&1`, { timeoutMs: 300_000 });
        const ready = await s.exec(
          `cd ${shq(dir)} && for i in $(seq 1 30); do ${DC} exec -T clickhouse wget -q -O - http://localhost:8123/ping 2>/dev/null | grep -q Ok && echo ready && break; sleep 2; done`,
          { timeoutMs: 90_000 }
        );
        const gate = await s.exec(waitHealthyCmd(90), { timeoutMs: 120_000 });
        return [
          `ClickHouse ${a.action} on ${srv.name} (exit ${r.code}).`,
          redactSecrets(lastLines(r.stdout, 12)),
          `ping: ${ready.stdout.includes("ready") ? "Ok (server up)" : "NOT ready — check ch_health / adpix_logs service:clickhouse"}`,
          `Front door: ${gate.stdout.trim()}`,
        ].join("\n");
      });
    },
  },
];

/** Parse a `formatReadableSize` string (e.g. "1.50 GiB") back to bytes, for the cap comparison. */
function parseHumanSize(s: string): number {
  const m = s.trim().match(/^([\d.]+)\s*(B|KiB|MiB|GiB|TiB)$/);
  if (!m) return 0;
  const mult: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
  return parseFloat(m[1]) * (mult[m[2]] ?? 1);
}
