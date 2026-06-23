import { z } from "zod";
import { withSession } from "../deps.js";
import { composeCmd, readEnvVar, requireStack, stackState } from "../adpix.js";
import { loadRegistry } from "../registry.js";
import { shq, lastLines } from "../util.js";
import type { Session } from "../ssh.js";
import type { ToolDef } from "./types.js";

/**
 * launch_readiness + scale_ingest — the enterprise-launch layer for AdPix Analytics.
 *
 * The capacity model (ADR-0043 / docs/CAPACITY): ~200k sites ≈ 1–6k events/s avg, 5–25k peak;
 * ClickHouse ~16 TB over 12 months. That needs: 3–4 stateless ingest replicas behind the CDN, a
 * SHARED Redis (global rate-limit), managed Postgres primary + read-replica, a ReplicatedMergeTree
 * ClickHouse node (CH_REPLICATED=1 + Keeper), and a CDN in front. launch_readiness scores the live
 * deployment against the launch-critical invariants and emits a go/no-go with blockers; scale_ingest
 * performs the one horizontal scale action the MCP owns (the stateless ingest tier).
 */

const serverParam = z.string().optional().describe("Target server. Omit for the default.");

interface Tier { sites: string; topology: string }
function recommendedTopology(sites: number): Tier {
  if (sites <= 1000) return { sites: "≤1k", topology: "1 VM (2 for HA). Single-node Postgres/ClickHouse/Redis is fine." };
  if (sites <= 20000) return { sites: "1k–20k", topology: "2 app nodes (2 AZs), managed-HA Postgres + Redis, 2 ClickHouse replicas." };
  return { sites: "100k–250k", topology: "HA cluster: witness + ≥2 serving nodes; 3–4 ingest replicas behind a CDN; ReplicatedMergeTree ClickHouse (CH_REPLICATED=1 + Keeper); managed Postgres primary + read-replica; SHARED managed Redis; nightly off-host encrypted backups; obs stack + alerting." };
}

type Level = "PASS" | "WARN" | "FAIL";
const ICON: Record<Level, string> = { PASS: "✓", WARN: "▲", FAIL: "✗" };

export const readinessTools: ToolDef[] = [
  {
    name: "launch_readiness",
    title: "200k-launch readiness scorecard",
    description:
      "Read-only go/no-go for a high-scale launch of AdPix Analytics. Scores the live deployment against the " +
      "launch-critical invariants for the target site count — capacity (RAM/CPU/disk vs the model), the recommended " +
      "topology, APP_ENV=production, ClickHouse replication (CH_REPLICATED), SHARED Redis (needed before scaling " +
      "ingest), ingest replica count, secret strength, backups, monitoring + watchdog, the P1 launch gate, and TLS. " +
      "Returns PASS/WARN/FAIL per check, blockers, and the gap to the recommended topology.",
    schema: {
      server: serverParam,
      sites: z.number().int().min(100).max(5_000_000).default(200_000).describe("Target number of websites to support"),
    },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; sites: number };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const cs: { level: Level; name: string; detail: string; fix?: string }[] = [];
        const add = (level: Level, name: string, detail: string, fix?: string) => cs.push({ level, name, detail, fix });
        const tier = recommendedTopology(a.sites);
        const big = a.sites >= 50_000;

        // host capacity
        const cap = await s.exec(`printf '%s %s %s' "$(nproc)" "$(free -m | awk '/^Mem:/{print $2}')" "$(df -m / | awk 'NR==2{print $4}')"`, { timeoutMs: 20_000 });
        const [cpu = 0, ramMb = 0, diskMb = 0] = cap.stdout.trim().split(/\s+/).map((n) => Number(n) || 0);
        const ramGb = ramMb / 1024, diskGb = diskMb / 1024;
        if (big) {
          // single-host minimums for a serving node in the cluster (CH + ingest replicas + builds)
          if (ramGb < 15) add("FAIL", "Capacity (RAM)", `${ramGb.toFixed(0)}GB on this host — a 200k serving node wants ≥16GB`, "resize the VM (server_resize) or move to the HA cluster topology");
          else add("PASS", "Capacity (RAM)", `${ramGb.toFixed(0)}GB`);
          if (cpu < 4) add("WARN", "Capacity (CPU)", `${cpu} vCPU — ≥4 recommended per serving node`);
          else add("PASS", "Capacity (CPU)", `${cpu} vCPU`);
          if (diskGb < 200) add("WARN", "Capacity (disk)", `${diskGb.toFixed(0)}GB free — ClickHouse grows ~16TB/yr at 200k; use managed/large volumes + TTL`, "ch_retention sets TTL; plan storage (consult_topic)");
          else add("PASS", "Capacity (disk)", `${diskGb.toFixed(0)}GB free`);
        } else {
          add(ramGb >= 4 ? "PASS" : "WARN", "Capacity", `${cpu} vCPU · ${ramGb.toFixed(0)}GB RAM · ${diskGb.toFixed(0)}GB disk`);
        }

        // must be deployed + running to assess the rest
        const ni = await requireStack(s, dir, srv.name, { needRunning: true });
        if (ni) {
          add("FAIL", "Deployment", ni.split(".")[0], "Deploys → Install (adpix_install), then re-run launch_readiness");
          return render(srv.name, a.sites, tier, cs);
        }
        const st = await stackState(s, dir);

        const env = async (k: string) => (await readEnvVar(s, dir, k)).trim();
        const appEnv = await env("APP_ENV");
        add(appEnv === "production" ? "PASS" : "FAIL", "APP_ENV", appEnv || "(unset)", appEnv === "production" ? undefined : "set APP_ENV=production in .env (fail-fast secret checks) and redeploy");

        const chRepl = await env("CH_REPLICATED");
        add(chRepl === "1" ? "PASS" : big ? "WARN" : "PASS", "ClickHouse replication", chRepl === "1" ? "CH_REPLICATED=1 (ReplicatedMergeTree)" : `CH_REPLICATED=${chRepl || "0"} (single-node MergeTree)`, chRepl === "1" || !big ? undefined : "for HA/scale: enable CH_REPLICATED=1 on a FRESH deploy (ch_backup first — events_local only converts clean); see ch_replication");

        const redis = await env("REDIS_URL");
        add(redis ? "PASS" : big ? "FAIL" : "WARN", "Shared Redis", redis ? "REDIS_URL set (global rate-limit)" : "REDIS_URL unset", redis ? undefined : "set REDIS_URL (compose.prod uses redis://redis:6379) BEFORE scaling ingest — without it each replica rate-limits independently (N× the intended rate)");

        const ingest = await s.exec(`docker ps --filter label=com.docker.compose.project=adanalytics --filter label=com.docker.compose.service=ingest -q 2>/dev/null | wc -l | tr -d ' '`, { timeoutMs: 20_000 });
        const nIngest = Number(ingest.stdout.trim()) || 0;
        if (big) add(nIngest >= 3 ? "PASS" : "WARN", "Ingest replicas", `${nIngest} running`, nIngest >= 3 ? undefined : "scale to 3–4 behind the CDN: scale_ingest replicas:3 (needs shared Redis)");
        else add("PASS", "Ingest replicas", `${nIngest} running`);

        // secret strength (present + not the dev placeholder)
        const weak: string[] = [];
        for (const k of ["POSTGRES_PASSWORD", "CLICKHOUSE_PASSWORD", "SESSION_SECRET", "ADMIN_PASSWORD"]) {
          const v = await env(k);
          if (!v || /change|dev-insecure|example|password|admin/i.test(v) || v.length < 16) weak.push(k);
        }
        add(weak.length ? "FAIL" : "PASS", "Secrets", weak.length ? `weak/placeholder/unset: ${weak.join(", ")}` : "strong (random, ≥16 chars)", weak.length ? "regenerate with `openssl rand -hex 32` and redeploy" : undefined);

        // backups: a recent backups/ dir OR a systemd backup timer
        const bk = await s.exec(`ls -1dt ${shq(dir)}/backups/*/ 2>/dev/null | head -1; systemctl list-timers 2>/dev/null | grep -ci backup || echo 0`, { timeoutMs: 20_000 });
        const bkLines = bk.stdout.trim().split("\n");
        const hasBackup = (bkLines[0] || "").includes("/backups/") || Number(bkLines[bkLines.length - 1]) > 0;
        add(hasBackup ? "PASS" : "WARN", "Backups", hasBackup ? "backups present / timer scheduled" : "no recent backup or schedule", hasBackup ? undefined : "schedule nightly off-host encrypted backups: schedule_job (task backup) + sync off-host");

        // monitoring + watchdog
        const obs = await s.exec(`docker ps --filter label=com.docker.compose.project=adanalytics --format '{{.Names}}' 2>/dev/null | grep -ci prometheus || echo 0; systemctl is-active adpix-watchdog.timer 2>/dev/null || echo inactive`, { timeoutMs: 20_000 });
        const [promN = "0", wdState = "inactive"] = obs.stdout.trim().split("\n");
        const monOk = Number(promN) > 0 && wdState === "active";
        add(monOk ? "PASS" : "WARN", "Monitoring", `prometheus ${Number(promN) > 0 ? "up" : "off"} · watchdog ${wdState}`, monOk ? undefined : "obs_deploy (Prometheus/Grafana/Alertmanager) + watchdog_install + a real alert receiver");

        // P1 launch gate (the hard go-live blockers)
        const gate = loadRegistry().launchGate;
        add(gate?.resolved ? "PASS" : "FAIL", "Launch gate (P1)", gate?.resolved ? `cleared${gate.at ? ` ${gate.at}` : ""}` : "NOT cleared — Analytics P1 release-blockers outstanding", gate?.resolved ? undefined : "resolve the P1 blockers and clear with launch_gate");

        // TLS / domain
        const site = await env("SITE_ADDRESS");
        const httpsLikely = /[a-z]\.[a-z]/i.test(site) && !site.includes("://");
        add(httpsLikely ? "PASS" : big ? "WARN" : "PASS", "TLS / domain", site ? `SITE_ADDRESS=${site.slice(0, 60)}` : "(HTTP-on-IP)", httpsLikely ? undefined : "use a domain so Caddy issues HTTPS; put a CDN in front for the tracker");

        void st;
        return render(srv.name, a.sites, tier, cs);
      });
    },
  },

  {
    name: "scale_ingest",
    title: "Scale the ingest tier",
    description:
      "Horizontally scale the STATELESS AdPix ingest tier (the collect hot path) to N replicas behind the CDN/" +
      "front door: `docker compose up -d --no-recreate --scale ingest=N`. Preflights that REDIS_URL is set — " +
      "without a shared Redis each replica enforces the rate limit independently (N× the intended rate). Datastores " +
      "are untouched. confirm:true required.",
    schema: {
      server: serverParam,
      replicas: z.number().int().min(1).max(12).default(3).describe("Number of ingest replicas (3–4 at 200k)"),
      confirm: z.boolean().default(false),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; replicas: number; confirm: boolean };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const ni = await requireStack(s, dir, srv.name, { needRunning: true });
        if (ni) return ni;
        if (!a.confirm) return `REFUSED: scale ingest to ${a.replicas} replica(s) on ${srv.name}. Re-run with confirm:true.`;
        const redis = (await readEnvVar(s, dir, "REDIS_URL")).trim();
        if (!redis && a.replicas > 1) {
          return `REFUSED: REDIS_URL is unset, so ${a.replicas} ingest replicas would each enforce the rate limit independently (≈${a.replicas}× the intended rate). Set REDIS_URL (compose.prod uses redis://redis:6379) in ${dir}/.env and redeploy, then re-run scale_ingest.`;
        }
        const up = await s.exec(`${composeCmd(dir)} up -d --no-recreate --scale ingest=${a.replicas} ingest 2>&1`, { timeoutMs: 300_000 });
        if (up.code !== 0) return `Scale FAILED (exit ${up.code}):\n${lastLines(up.stdout, 20)}`;
        const now = await ingestCount(s);
        return `Scaled ingest to ${a.replicas} on ${srv.name} — ${now} replica(s) now running.\nThe front door (Caddy) load-balances across them via Docker DNS. Datastores untouched.`;
      });
    },
  },
];

async function ingestCount(s: Session): Promise<number> {
  const r = await s.exec(`docker ps --filter label=com.docker.compose.project=adanalytics --filter label=com.docker.compose.service=ingest -q 2>/dev/null | wc -l | tr -d ' '`, { timeoutMs: 20_000 });
  return Number(r.stdout.trim()) || 0;
}

function render(server: string, sites: number, tier: Tier, cs: { level: Level; name: string; detail: string; fix?: string }[]): string {
  const fails = cs.filter((c) => c.level === "FAIL");
  const warns = cs.filter((c) => c.level === "WARN");
  const body = cs.map((c) => `${ICON[c.level]} ${c.name}: ${c.detail}${c.fix ? `\n     → ${c.fix}` : ""}`).join("\n");
  const verdict = fails.length ? "NO-GO" : warns.length ? "GO WITH RISKS" : "GO";
  const blockers = fails.length ? `\nBLOCKERS (${fails.length}):\n${fails.map((f) => `  • ${f.name}: ${f.fix || f.detail}`).join("\n")}` : "";
  return [
    `# Launch readiness — ${server} · target ${sites.toLocaleString()} sites`,
    `Recommended topology (${tier.sites}): ${tier.topology}`,
    ``,
    body,
    ``,
    `VERDICT: ${verdict} — ${fails.length} fail, ${warns.length} warn.${blockers}`,
  ].join("\n");
}
