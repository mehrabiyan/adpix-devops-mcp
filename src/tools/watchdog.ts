import { z } from "zod";
import { withSession } from "../deps.js";
import { uploadFile } from "../adpix.js";
import {
  WATCHDOG_LOG_DIR,
  WATCHDOG_SCRIPT_PATH,
  WATCHDOG_SERVICE,
  WATCHDOG_TIMER,
  WATCHDOG_SERVICE_UNIT,
  renderWatchdogScript,
  renderWatchdogTimer,
} from "../remote/watchdog.js";
import { isoDaysAgo, pct, shq } from "../util.js";
import type { ToolDef } from "./types.js";

const serverParam = z
  .string()
  .optional()
  .describe("Registered server name. Omit to use the default server.");

/** Parse watchdog per-check lines into a per-day uptime summary. */
export function summarizeChecks(
  lines: string[],
  sinceIso: string
): { text: string; total: number; failed: number } {
  const byDay = new Map<string, { total: number; failed: number }>();
  let total = 0;
  let failed = 0;
  let worstStreak = 0;
  let streak = 0;
  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(/^(\S+)\s+(ok|fail)(?:\s+(.*))?$/);
    if (!m || m[1] < sinceIso) continue;
    const day = m[1].slice(0, 10);
    const rec = byDay.get(day) ?? { total: 0, failed: 0 };
    rec.total++;
    total++;
    if (m[2] === "fail") {
      rec.failed++;
      failed++;
      streak++;
      worstStreak = Math.max(worstStreak, streak);
    } else {
      streak = 0;
    }
    byDay.set(day, rec);
  }
  const days = [...byDay.entries()].sort(([x], [y]) => (x < y ? -1 : 1));
  const text =
    days.length === 0
      ? "(no checks recorded in the window)"
      : days
          .map(([d, r]) => `${d}  ${pct(r.total - r.failed, r.total).padStart(8)}  (${r.failed} failed of ${r.total} checks)`)
          .join("\n") +
        `\n\nOverall: ${pct(total - failed, total)} of ${total} checks` +
        (worstStreak ? `; longest outage streak: ${worstStreak} consecutive checks` : "");
  return { text, total, failed };
}

export const watchdogTools: ToolDef[] = [
  {
    name: "watchdog_install",
    title: "Install the uptime watchdog",
    description:
      "Install/update the on-server watchdog: a systemd timer that, every interval, verifies every " +
      "AdPix container and the Caddy front door (HTTP + TLS), auto-restarts anything unhealthy, " +
      "records per-check uptime data + incident history, and POSTs webhook alerts on outage/recovery. " +
      "Runs on the server itself, so protection continues when no MCP client is connected. Idempotent.",
    schema: {
      server: serverParam,
      intervalSeconds: z.number().int().min(15).max(3600).default(60),
      autoRestart: z.boolean().default(true).describe("Restart unhealthy containers automatically"),
      webhookUrl: z
        .string()
        .optional()
        .describe("Alert webhook (Slack/Discord/generic). Defaults to the server's registered webhookUrl."),
      httpPath: z.string().default("/_apx_health").describe("Front-door path that must answer"),
      realertEvery: z.number().int().min(2).max(1440).default(30).describe("While down, re-alert every N checks"),
    },
    annotations: { idempotentHint: true },
    handler: async (deps, args) => {
      const a = args as {
        server?: string; intervalSeconds: number; autoRestart: boolean;
        webhookUrl?: string; httpPath: string; realertEvery: number;
      };
      return withSession(deps, a.server, async (s, srv) => {
        const webhook = a.webhookUrl ?? srv.webhookUrl;
        const script = renderWatchdogScript({
          adpixDir: srv.adpixDir,
          webhookUrl: webhook,
          autoRestart: a.autoRestart,
          httpPath: a.httpPath,
          realertEvery: a.realertEvery,
        });
        await uploadFile(s, WATCHDOG_SCRIPT_PATH, script, "755");
        await uploadFile(s, `/etc/systemd/system/${WATCHDOG_SERVICE}`, WATCHDOG_SERVICE_UNIT, "644");
        await uploadFile(s, `/etc/systemd/system/${WATCHDOG_TIMER}`, renderWatchdogTimer(a.intervalSeconds), "644");
        const en = await s.exec(
          `systemctl daemon-reload && systemctl enable --now ${WATCHDOG_TIMER} && systemctl start ${WATCHDOG_SERVICE} && sleep 1 && cat ${WATCHDOG_LOG_DIR}/state.json 2>/dev/null`,
          { timeoutMs: 120_000 }
        );
        if (en.code !== 0) {
          return `Watchdog files installed but enabling failed (exit ${en.code}):\n${en.stderr || en.stdout}`;
        }
        return [
          `Watchdog installed on ${srv.name} — checking every ${a.intervalSeconds}s` +
            (a.autoRestart ? ", auto-restarting unhealthy services" : " (observe-only: autoRestart:false)") +
            (webhook ? ", alerting to the configured webhook" : ", no webhook configured (pass webhookUrl to get alerts)"),
          `First check result: ${en.stdout.trim() || "(state pending)"}`,
          ``,
          `Data on the server: ${WATCHDOG_LOG_DIR}/{checks-YYYYMM.log, incidents.jsonl, state.json}`,
          `Use watchdog_status for current state and uptime_report for uptime %.`,
        ].join("\n");
      });
    },
  },

  {
    name: "watchdog_status",
    title: "Watchdog status",
    description: "Current watchdog state: timer schedule, last check result, and recent incidents.",
    schema: {
      server: serverParam,
      incidents: z.number().int().min(1).max(100).default(10).describe("How many recent incidents to show"),
    },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; incidents: number };
      return withSession(deps, a.server, async (s, srv) => {
        const r = await s.exec(
          [
            `echo ===TIMER; systemctl is-enabled ${WATCHDOG_TIMER} 2>/dev/null || echo not-installed; systemctl list-timers ${WATCHDOG_TIMER} --no-pager 2>/dev/null | head -3`,
            `echo ===STATE; cat ${WATCHDOG_LOG_DIR}/state.json 2>/dev/null || echo '(no state yet)'`,
            `echo ===INCIDENTS; tail -n ${a.incidents} ${WATCHDOG_LOG_DIR}/incidents.jsonl 2>/dev/null || echo '(none recorded)'`,
          ].join("; "),
          { timeoutMs: 60_000 }
        );
        const sec: Record<string, string> = {};
        let cur = "";
        for (const line of r.stdout.split("\n")) {
          const m = line.match(/^===(\w+)/);
          if (m) { cur = m[1]; sec[cur] = ""; }
          else if (cur) sec[cur] += line + "\n";
        }
        if ((sec.TIMER ?? "").includes("not-installed")) {
          return `Watchdog is not installed on ${srv.name} — run watchdog_install for 24/7 self-healing + alerts.`;
        }
        return [
          `# Watchdog on ${srv.name}`,
          `## Timer\n${(sec.TIMER ?? "").trim()}`,
          `## Last check\n${(sec.STATE ?? "").trim()}`,
          `## Recent incidents (newest last)\n${(sec.INCIDENTS ?? "").trim()}`,
        ].join("\n\n");
      });
    },
  },

  {
    name: "uptime_report",
    title: "Uptime report",
    description:
      "Uptime percentage per day (computed from the watchdog's per-check records) plus the incident " +
      "log for the window: when it went down, what was wrong, what the watchdog restarted, when it recovered.",
    schema: {
      server: serverParam,
      days: z.number().int().min(1).max(120).default(7),
    },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; days: number };
      return withSession(deps, a.server, async (s, srv) => {
        const since = isoDaysAgo(a.days);
        const r = await s.exec(
          `cat ${WATCHDOG_LOG_DIR}/checks-*.log 2>/dev/null | awk -v c=${shq(since)} '$1 >= c' | tail -n 200000`,
          { timeoutMs: 120_000 }
        );
        if (!r.stdout.trim()) {
          const installed = await s.exec(`systemctl is-enabled ${WATCHDOG_TIMER} 2>/dev/null || echo no`);
          return installed.stdout.includes("no")
            ? `No uptime data on ${srv.name}: the watchdog isn't installed. Run watchdog_install first — uptime tracking starts from then.`
            : `Watchdog is installed on ${srv.name} but no checks recorded in the last ${a.days} day(s) yet.`;
        }
        const summary = summarizeChecks(r.stdout.split("\n"), since);
        const inc = await s.exec(
          `awk -v c=${shq(`{"ts":"${since}`)} '$0 >= c' ${WATCHDOG_LOG_DIR}/incidents.jsonl 2>/dev/null | tail -n 50`
        );
        return [
          `# Uptime — ${srv.name}, last ${a.days} day(s)`,
          summary.text,
          ``,
          `## Incidents in window (newest last)`,
          inc.stdout.trim() || "(none — no downtime events recorded)",
        ].join("\n");
      });
    },
  },
];
