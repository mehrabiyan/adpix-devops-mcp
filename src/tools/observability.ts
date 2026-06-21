import { z } from "zod";
import { withSession } from "../deps.js";
import type { Session } from "../ssh.js";
import { composeCmd } from "../adpix.js";
import { shq, lastLines, table } from "../util.js";
import type { ToolDef } from "./types.js";

const serverParam = z.string().optional().describe("Registered server name (the witness, ideally). Omit to use the default.");

/** The Analytics observability stack ships in compose under `profiles: ["extras"]` (DEPLOYMENT_SRE §4/§12). */
const OBS_SERVICES = ["prometheus", "alertmanager", "grafana"] as const;

async function ensureInstalled(s: Session, dir: string): Promise<string | null> {
  const r = await s.exec(`test -d ${shq(dir + "/.git")} && echo yes || echo no`);
  return r.stdout.trim() === "yes" ? null : `No AdPix checkout at ${dir} — the observability stack ships in its compose. Install it first (adpix_install) or point server at the witness's AdPix checkout.`;
}

export const observabilityTools: ToolDef[] = [
  {
    name: "obs_deploy",
    title: "Deploy the observability stack",
    description:
      "Bring up the Analytics observability stack — Prometheus + Alertmanager + Grafana — which ships in the " +
      "compose project under the `extras` profile (it scrapes /healthz + the worker:9100 / identity-job:9101 " +
      "metrics + node/PG/Redis/CH exporters; Grafana has the pipeline + golden-signals dashboards). Per " +
      "DEPLOYMENT_SRE §4 run this on the WITNESS, off the serving nodes. Idempotent.",
    schema: { server: serverParam },
    annotations: { idempotentHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const notInstalled = await ensureInstalled(s, dir);
        if (notInstalled) return notInstalled;
        const r = await s.exec(`${composeCmd(dir)} --profile extras up -d ${OBS_SERVICES.join(" ")} 2>&1`, { timeoutMs: 600_000 });
        if (r.code !== 0) return `obs_deploy FAILED (exit ${r.code}):\n${lastLines(r.stdout, 30)}`;
        return [
          `Observability stack up on ${srv.name} (Prometheus + Alertmanager + Grafana).`,
          lastLines(r.stdout, 12),
          ``,
          `Check it with obs_status. Set a real Alertmanager receiver (ops/alertmanager/alertmanager.yml — defaults to nowhere) + cert-expiry / replication-lag / 5xx / outbox-depth alerts.`,
          `Grafana is internal-only (no host port) — tunnel to it or front it with Caddy; anonymous Admin is on by default (GF_AUTH_ANONYMOUS), lock that down before exposing it.`,
        ].join("\n");
      });
    },
  },

  {
    name: "obs_status",
    title: "Observability stack status",
    description:
      "Status of Prometheus/Alertmanager/Grafana: container states, Prometheus readiness + how many scrape targets " +
      "are up vs down (the actual 'are we observing everything' signal), Alertmanager readiness, and Grafana health.",
    schema: { server: serverParam },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const notInstalled = await ensureInstalled(s, dir);
        if (notInstalled) return notInstalled;
        const problems: string[] = [];

        const ps = await s.exec(`${composeCmd(dir)} ps --format json ${OBS_SERVICES.join(" ")} 2>/dev/null`, { timeoutMs: 60_000 });
        const up = new Set<string>();
        for (const line of ps.stdout.trim().split("\n")) {
          try {
            const c = JSON.parse(line) as { Service?: string; State?: string };
            if (c.Service && c.State === "running") up.add(c.Service);
          } catch {
            /* skip */
          }
        }
        for (const svc of OBS_SERVICES) if (!up.has(svc)) problems.push(`${svc} is not running (obs_deploy)`);

        const rows: string[][] = [];
        // Prometheus: readiness + target up/down counts
        if (up.has("prometheus")) {
          const ready = await s.exec(`${composeCmd(dir)} exec -T prometheus wget -qO- http://localhost:9090/-/ready 2>/dev/null || true`);
          const t = await s.exec(`${composeCmd(dir)} exec -T prometheus wget -qO- 'http://localhost:9090/api/v1/targets?state=active' 2>/dev/null || true`);
          const ups = (t.stdout.match(/"health":"up"/g) || []).length;
          const downs = (t.stdout.match(/"health":"down"/g) || []).length;
          if (downs > 0) problems.push(`${downs} Prometheus scrape target(s) DOWN — something isn't being observed`);
          rows.push(["prometheus", /Ready/i.test(ready.stdout) ? "ready" : "NOT ready", `${ups} up / ${downs} down targets`]);
        } else rows.push(["prometheus", "down", "-"]);

        if (up.has("alertmanager")) {
          const ready = await s.exec(`${composeCmd(dir)} exec -T alertmanager wget -qO- http://localhost:9093/-/ready 2>/dev/null || true`);
          rows.push(["alertmanager", /ready|ok/i.test(ready.stdout) || ready.stdout.trim() === "" ? "ready" : "?", "set a real receiver"]);
        } else rows.push(["alertmanager", "down", "-"]);

        if (up.has("grafana")) {
          const h = await s.exec(`${composeCmd(dir)} exec -T grafana wget -qO- http://localhost:3000/api/health 2>/dev/null || true`);
          rows.push(["grafana", /"database":\s*"ok"/.test(h.stdout) ? "ok" : "?", "dashboards: pipeline + golden-signals"]);
        } else rows.push(["grafana", "down", "-"]);

        const verdict = problems.length === 0 ? "HEALTHY" : problems.some((p) => /not running|DOWN/.test(p)) ? "NEEDS ATTENTION" : "OK with warnings";
        return [
          `# Observability — ${srv.name}  —  ${verdict}`,
          problems.length ? "Findings:\n" + problems.map((p) => `  - ${p}`).join("\n") : "Prometheus, Alertmanager and Grafana all up; all scrape targets healthy.",
          ``,
          table(["COMPONENT", "STATE", "DETAIL"], rows),
        ].join("\n");
      });
    },
  },
];
