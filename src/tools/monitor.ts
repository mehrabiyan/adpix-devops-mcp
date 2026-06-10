import { z } from "zod";
import { withSession } from "../deps.js";
import { HEALTH_ROUTES, composeCmd, localProbeCmd, readSiteAddress } from "../adpix.js";
import { shq, parseComposePs, table, daysUntil } from "../util.js";
import type { ToolDef } from "./types.js";

const serverParam = z
  .string()
  .optional()
  .describe("Registered server name. Omit to use the default server.");

export const monitorTools: ToolDef[] = [
  {
    name: "health_check",
    title: "Health check",
    description:
      "Full health check: every container's state/health, plus HTTP probes of the front door " +
      "(ingest /_apx_health, api version, dashboard, tracker script) through the local Caddy — " +
      "in domain mode this exercises the real TLS path. Ends with a HEALTHY/DEGRADED/DOWN verdict.",
    schema: { server: serverParam },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const problems: string[] = [];

        const ps = await s.exec(`${composeCmd(dir)} ps -a --format json`, { timeoutMs: 60_000 });
        const rows = parseComposePs(ps.stdout).filter(
          (c) => !/migrate|run-/.test(c.Name || c.Service || "")
        );
        if (rows.length === 0) problems.push("no containers running");
        const containerRows = rows.map((c) => {
          const bad = c.State !== "running" || /unhealthy/i.test(c.Health ?? "");
          if (bad) problems.push(`${c.Service || c.Name}: ${c.State}${c.Health ? `/${c.Health}` : ""}`);
          return [c.Service || c.Name, c.State, c.Health || "-", bad ? "PROBLEM" : "ok"];
        });

        const site = await readSiteAddress(s, dir);
        const probeRows: string[][] = [];
        for (const route of HEALTH_ROUTES) {
          const r = await s.exec(localProbeCmd(site, route.path), { timeoutMs: 30_000 });
          const [code = "000", time = "0"] = r.stdout.trim().split(/\s+/);
          const ms = `${Math.round(parseFloat(time) * 1000)}ms`;
          const ok = /^[23]/.test(code);
          if (!ok) problems.push(`${route.path} → HTTP ${code}`);
          probeRows.push([route.path, route.service, code, ms, ok ? "ok" : "PROBLEM"]);
        }

        const wd = await s.exec(
          "systemctl is-active adpix-watchdog.timer 2>/dev/null; cat /var/log/adpix-watchdog/state.json 2>/dev/null"
        );

        const verdict =
          problems.length === 0
            ? "HEALTHY"
            : problems.length >= rows.length + HEALTH_ROUTES.length - 1 || rows.length === 0
              ? "DOWN"
              : "DEGRADED";

        return [
          `# Health of AdPix on ${srv.name} (${srv.host}) — ${verdict}`,
          problems.length ? `Problems:\n${problems.map((p) => `  - ${p}`).join("\n")}` : "No problems found.",
          ``,
          `## Containers\n${table(["SERVICE", "STATE", "HEALTH", ""], containerRows)}`,
          ``,
          `## Front door (${site.domain ? `https via ${site.domain}` : "http on IP"})\n` +
            table(["PATH", "BACKS", "HTTP", "TIME", ""], probeRows),
          ``,
          `## Watchdog\n${wd.stdout.trim() || "not installed (watchdog_install adds 24/7 self-healing + alerts)"}`,
        ].join("\n");
      });
    },
  },

  {
    name: "system_metrics",
    title: "System metrics",
    description:
      "Host resource snapshot: load vs cores, memory, disk usage, per-container CPU/RAM, " +
      "and the top memory consumers — with warnings when anything runs hot.",
    schema: { server: serverParam },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string };
      return withSession(deps, a.server, async (s, srv) => {
        const r = await s.exec(
          [
            "echo ===UPTIME; uptime -p 2>/dev/null || uptime",
            "echo ===LOAD; cat /proc/loadavg; nproc",
            "echo ===MEM; free -m",
            "echo ===DISK; df -h / 2>/dev/null | tail -1",
            "echo ===DOCKER; docker stats --no-stream --format '{{.Name}}  cpu {{.CPUPerc}}  mem {{.MemUsage}}' 2>/dev/null | sort",
            "echo ===TOP; ps -eo pid,comm,%mem,%cpu --sort=-%mem | head -8",
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

        const warnings: string[] = [];
        const load1 = parseFloat((sec.LOAD ?? "").split(/\s+/)[0] || "0");
        const cores = parseInt((sec.LOAD ?? "").trim().split("\n").pop() || "1", 10) || 1;
        if (load1 > cores) warnings.push(`load ${load1} exceeds ${cores} cores — CPU saturated`);
        const memLine = (sec.MEM ?? "").split("\n").find((l) => l.startsWith("Mem:")) ?? "";
        const memCols = memLine.split(/\s+/).map(Number);
        const memTotal = memCols[1] || 0;
        const memAvail = memCols[6] || 0;
        if (memTotal && memAvail / memTotal < 0.1) warnings.push(`only ${memAvail}MB of ${memTotal}MB RAM available`);
        const diskPct = parseInt(((sec.DISK ?? "").match(/(\d+)%/) || [])[1] || "0", 10);
        if (diskPct >= 90) warnings.push(`root disk ${diskPct}% full — backups/builds will start failing`);
        else if (diskPct >= 80) warnings.push(`root disk ${diskPct}% full — plan cleanup`);

        return [
          `# ${srv.name} (${srv.host}) — ${(sec.UPTIME ?? "").trim()}`,
          warnings.length ? `Warnings:\n${warnings.map((w) => `  - ${w}`).join("\n")}` : "No resource warnings.",
          ``,
          `Load (1/5/15m + cores): ${(sec.LOAD ?? "").trim().replace("\n", "  cores=")}`,
          `Memory (MB):\n${(sec.MEM ?? "").trimEnd()}`,
          `Disk: ${(sec.DISK ?? "").trim()}`,
          ``,
          `## Containers\n${(sec.DOCKER ?? "").trimEnd() || "(docker not running?)"}`,
          ``,
          `## Top memory processes\n${(sec.TOP ?? "").trimEnd()}`,
        ].join("\n");
      });
    },
  },

  {
    name: "performance_report",
    title: "Loading-speed report",
    description:
      "Measure loading speed of the key AdPix URLs (dashboard, tracker t.js, API, collect health) " +
      "via the public URL: DNS, connect, TLS, TTFB and total time plus transfer size, averaged over " +
      "several runs, with a slow/ok verdict per URL. Probes run from the server, so they isolate " +
      "server-side speed from the client's network.",
    schema: {
      server: serverParam,
      runs: z.number().int().min(1).max(10).default(3),
    },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; runs: number };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const site = await readSiteAddress(s, dir);
        const base = site.publicBaseUrl.replace(/\/$/, "");
        const fmt = "%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{size_download}";
        const rows: string[][] = [];
        const notes: string[] = [];

        for (const route of HEALTH_ROUTES) {
          const url = base + route.path;
          const r = await s.exec(
            `for i in $(seq 1 ${a.runs}); do curl -ksS --compressed -o /dev/null -m 20 -w ${shq(fmt + "\n")} ${shq(url)} 2>/dev/null || echo '000 0 0 0 0 0 0'; done`,
            { timeoutMs: 120_000 }
          );
          const samples = r.stdout
            .trim()
            .split("\n")
            .map((l) => l.trim().split(/\s+/).map(Number))
            .filter((c) => c.length === 7);
          if (samples.length === 0) {
            rows.push([route.path, "?", "-", "-", "-", "-", "unreachable"]);
            continue;
          }
          const ok = samples.filter((c) => c[0] >= 200 && c[0] < 400);
          const use = ok.length ? ok : samples;
          const avg = (i: number) => use.reduce((t, c) => t + c[i], 0) / use.length;
          const ms = (v: number) => `${Math.round(v * 1000)}ms`;
          const ttfb = avg(4);
          const verdict = ok.length === 0 ? `HTTP ${samples[0][0]}` : ttfb < 0.2 ? "fast" : ttfb < 0.5 ? "ok" : ttfb < 1 ? "slow" : "VERY SLOW";
          rows.push([
            route.path,
            String(use[0][0]),
            ms(avg(1) /* dns */),
            ms(avg(3) - avg(2) /* tls */),
            ms(ttfb),
            ms(avg(5)),
            `${(avg(6) / 1024).toFixed(1)}KB ${verdict}`,
          ]);
          if (route.path === "/t.js" && avg(6) > 30 * 1024) {
            notes.push(`tracker t.js transfers ${(avg(6) / 1024).toFixed(0)}KB — budget is a few KB gzipped; check compression`);
          }
        }

        return [
          `# Loading speed — ${base} (avg of ${a.runs} runs, measured from the server)`,
          table(["PATH", "HTTP", "DNS", "TLS", "TTFB", "TOTAL", "SIZE/VERDICT"], rows),
          notes.length ? `\nNotes:\n${notes.map((n) => `  - ${n}`).join("\n")}` : "",
          `\nTTFB verdicts: <200ms fast, <500ms ok, <1s slow. Client-perceived speed adds the visitor's network on top.`,
        ].filter(Boolean).join("\n");
      });
    },
  },

  {
    name: "tls_status",
    title: "TLS certificate status",
    description:
      "Inspect the live HTTPS certificate (issuer, validity window, days remaining). Caddy auto-renews " +
      "~30 days before expiry, so anything under 14 days means renewal is failing and needs attention.",
    schema: { server: serverParam },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string };
      return withSession(deps, a.server, async (s, srv) => {
        const site = await readSiteAddress(s, srv.adpixDir);
        if (!site.domain) {
          return `AdPix on ${srv.name} runs in HTTP-on-IP mode (no domain configured) — no TLS certificate to check. Re-run adpix_install with a domain, or set SITE_ADDRESS in .env, for automatic HTTPS.`;
        }
        const r = await s.exec(
          `echo | openssl s_client -servername ${shq(site.domain)} -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -subject -issuer -startdate -enddate 2>/dev/null`,
          { timeoutMs: 30_000 }
        );
        if (!r.stdout.includes("notAfter=")) {
          return `Could not read a certificate for ${site.domain} on ${srv.name} — is Caddy up and has it issued a cert yet? (caddy logs: adpix_logs service:caddy). Raw: ${r.stdout || r.stderr || "(empty)"}`;
        }
        const get = (k: string) => (r.stdout.match(new RegExp(`${k}=(.*)`)) || [])[1]?.trim() ?? "?";
        const notAfter = get("notAfter");
        const expMs = Date.parse(notAfter);
        const days = Number.isNaN(expMs) ? NaN : daysUntil(expMs);
        const verdict = Number.isNaN(days)
          ? "could not parse expiry"
          : days < 0
            ? `EXPIRED ${-days} days ago — visitors see TLS errors NOW`
            : days < 14
              ? `WARNING: ${days} days left — Caddy renews ~30d out, so renewal is failing (check port 80 reachability + caddy logs)`
              : `OK: ${days} days remaining (Caddy auto-renews ~30 days before expiry)`;
        return [
          `# TLS — ${site.domain} on ${srv.name}`,
          `subject: ${get("subject")}`,
          `issuer:  ${get("issuer")}`,
          `valid:   ${get("notBefore")} → ${notAfter}`,
          ``,
          verdict,
        ].join("\n");
      });
    },
  },
];
