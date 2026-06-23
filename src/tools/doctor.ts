import { z } from "zod";
import { withSession } from "../deps.js";
import { composeCmd, stackState, waitHealthyCmd } from "../adpix.js";
import { WATCHDOG_TIMER, WATCHDOG_LOG_DIR } from "../remote/watchdog.js";
import { shq, lastLines } from "../util.js";
import type { ToolDef } from "./types.js";

/**
 * stack_doctor — read-only, end-to-end diagnosis of an AdPix Analytics server. One call answers
 * "what's wrong / is it healthy", from the host (OS, Docker daemon, disk/RAM) down through the
 * deployment (cloned? containers running? which are down? front door healthy? Postgres + ClickHouse
 * reachable? watchdog armed?). Each check is PASS / WARN / FAIL with a concrete remediation, plus the
 * single most important next action. This is the "re-validate everything" tool — safe to run anytime,
 * and the one the assistant should reach for when asked to diagnose a server.
 */
type Level = "PASS" | "WARN" | "FAIL";
interface Check { level: Level; name: string; detail: string; fix?: string }

const ICON: Record<Level, string> = { PASS: "✓", WARN: "▲", FAIL: "✗" };

export const doctorTools: ToolDef[] = [
  {
    name: "stack_doctor",
    title: "Diagnose a server's deployment",
    description:
      "Read-only end-to-end diagnosis of an AdPix server: OS, Docker daemon, disk/RAM, repo checkout + version, " +
      "container running-state (which services are down), front-door health, Postgres + ClickHouse reachability, " +
      "and the watchdog. Returns a PASS/WARN/FAIL checklist + the single most important next action. The " +
      "'re-validate everything' tool — safe anytime.",
    schema: { server: z.string().optional().describe("Server to diagnose. Omit for the default.") },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const cs: Check[] = [];
        const add = (level: Level, name: string, detail: string, fix?: string) => cs.push({ level, name, detail, fix });

        // 1. Host: OS + Docker (installed + daemon) + disk + RAM — one probe.
        const host = await s.exec(
          `. /etc/os-release 2>/dev/null; printf 'OS=%s\\n' "$PRETTY_NAME"; ` +
            `printf 'DOCKER=%s\\n' "$(command -v docker >/dev/null 2>&1 && docker --version 2>/dev/null | head -1 || echo none)"; ` +
            `printf 'DAEMON=%s\\n' "$(docker info >/dev/null 2>&1 && echo up || echo down)"; ` +
            `printf 'DISKMB=%s\\n' "$(df -m / | awk 'NR==2{print $4}')"; printf 'RAMMB=%s\\n' "$(free -m | awk '/^Mem:/{print $2}')"`,
          { timeoutMs: 30_000 }
        );
        const kv: Record<string, string> = {};
        host.stdout.trim().split("\n").forEach((l) => { const i = l.indexOf("="); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1).trim(); });
        const diskMb = Number(kv.DISKMB || 0), ramMb = Number(kv.RAMMB || 0);
        if (/(debian|ubuntu)/i.test(kv.OS || "")) add("PASS", "OS", kv.OS);
        else add("WARN", "OS", `${kv.OS || "unknown"} — deploy.sh targets Ubuntu/Debian`);
        if ((kv.DOCKER || "none") === "none") add("FAIL", "Docker", "not installed", "run adpix_install (it installs Docker)");
        else if (kv.DAEMON !== "up") add("FAIL", "Docker daemon", "installed but NOT running", "start it: `sudo systemctl start docker` (then re-run install)");
        else add("PASS", "Docker", `${kv.DOCKER} · daemon up`);
        if (diskMb && diskMb < 3000) add("FAIL", "Disk", `only ${(diskMb / 1024).toFixed(1)}GB free on / — builds/data will fail`, "free space or grow the disk (server_resize plans it)");
        else if (diskMb && diskMb < 10_000) add("WARN", "Disk", `${(diskMb / 1024).toFixed(1)}GB free on / — 20GB+ recommended at scale`);
        else if (diskMb) add("PASS", "Disk", `${(diskMb / 1024).toFixed(1)}GB free`);
        if (ramMb && ramMb < 1800) add("WARN", "RAM", `${ramMb}MB — 4GB recommended (Postgres + ClickHouse + builds)`);
        else if (ramMb) add("PASS", "RAM", `${ramMb}MB`);

        // 2. Deployment state.
        const st = await stackState(s, dir);
        if (!st.cloned) {
          add("FAIL", "AdPix install", `not installed at ${dir} (no checkout)`, "provision it: Deploys → Install (adpix_install)");
          return render(srv.name, dir, cs);
        }
        const ver = await s.exec(`cd ${shq(dir)} && printf '%s ' "$(git rev-parse --short HEAD 2>/dev/null)"; b=$(git rev-parse --abbrev-ref HEAD 2>/dev/null); git fetch -q origin 2>/dev/null; printf '%s %s' "$b" "$(git rev-list --count HEAD..origin/$b 2>/dev/null || echo '?')"`, { timeoutMs: 40_000 });
        const [commit = "?", branch = "?", behind = "?"] = ver.stdout.trim().split(/\s+/);
        add("PASS", "AdPix install", `cloned at ${dir} · ${commit} (${branch})${behind !== "0" && behind !== "?" ? ` · ${behind} behind origin` : ""}`, behind !== "0" && behind !== "?" ? "update with stack_update (stateless-only)" : undefined);

        // 3. Containers.
        if (!st.up) {
          add("FAIL", "Containers", `${st.running}/${st.total} running — the stack is DOWN`, "re-run adpix_install (idempotent) to bring it up, then re-check");
          // still surface what compose knows
          const ps = await s.exec(`${composeCmd(dir)} ps -a --format json 2>/dev/null`, { timeoutMs: 60_000 });
          if (ps.stdout.trim()) add("WARN", "Compose", "containers exist but are stopped/exited — see adpix_status / adpix_logs");
          return render(srv.name, dir, cs);
        }
        const ps = await s.exec(`${composeCmd(dir)} ps --format '{{.Service}} {{.State}}' 2>/dev/null`, { timeoutMs: 60_000 });
        const down = ps.stdout.trim().split("\n").map((l) => l.trim()).filter((l) => l && !/running|healthy/i.test(l.split(/\s+/).slice(1).join(" ")));
        if (down.length) add("WARN", "Containers", `${st.running}/${st.total} up; not running: ${down.map((d) => d.split(/\s+/)[0]).join(", ")}`, "inspect: adpix_logs <service>; restart: container_control");
        else add("PASS", "Containers", `${st.running}/${st.total} up`);

        // 4. Front door + datastores (only meaningful when up).
        const gate = await s.exec(waitHealthyCmd(20), { timeoutMs: 30_000 });
        if (gate.code === 0) add("PASS", "Front door", gate.stdout.trim() || "answering 2xx/3xx");
        else add("WARN", "Front door", `not answering 2xx/3xx yet (${lastLines(gate.stdout, 1) || "no response"})`, "give it a minute; if it persists check caddy/web/api logs (adpix_logs)");

        const pg = await s.exec(`${composeCmd(dir)} exec -T postgres pg_isready 2>&1 | tail -1`, { timeoutMs: 30_000 });
        add(/accepting connections/i.test(pg.stdout) ? "PASS" : "FAIL", "Postgres", (pg.stdout.trim() || "no response").slice(0, 120), /accepting/i.test(pg.stdout) ? undefined : "check postgres: adpix_logs postgres, pg_health");
        const ch = await s.exec(`${composeCmd(dir)} exec -T clickhouse wget -q -O- http://localhost:8123/ping 2>/dev/null || echo DOWN`, { timeoutMs: 30_000 });
        add(/Ok\./.test(ch.stdout) ? "PASS" : "FAIL", "ClickHouse", /Ok\./.test(ch.stdout) ? "ping Ok." : "not responding on :8123/ping", /Ok\./.test(ch.stdout) ? undefined : "check clickhouse: adpix_logs clickhouse, ch_health");

        // 5. Watchdog.
        const wd = await s.exec(`systemctl is-active ${WATCHDOG_TIMER} 2>/dev/null; cat ${WATCHDOG_LOG_DIR}/state.json 2>/dev/null | tr -d '\\n'`, { timeoutMs: 20_000 });
        const wdLines = wd.stdout.trim().split("\n");
        if (wdLines[0] === "active") {
          const stateJson = wdLines.slice(1).join("");
          let wdStatus = ""; try { wdStatus = JSON.parse(stateJson || "{}").status || ""; } catch { /* ignore */ }
          add(wdStatus === "fail" ? "WARN" : "PASS", "Watchdog", `armed${wdStatus ? ` · last check: ${wdStatus}` : ""}`, wdStatus === "fail" ? "the watchdog is reporting a problem — see watchdog_status" : undefined);
        } else add("WARN", "Watchdog", "not installed — no 24/7 self-healing + alerts", "install it: watchdog_install");

        return render(srv.name, dir, cs);
      });
    },
  },
];

function render(server: string, dir: string, cs: Check[]): string {
  const fails = cs.filter((c) => c.level === "FAIL");
  const warns = cs.filter((c) => c.level === "WARN");
  const verdict: Level = fails.length ? "FAIL" : warns.length ? "WARN" : "PASS";
  const body = cs.map((c) => `${ICON[c.level]} ${c.name}: ${c.detail}${c.fix ? `\n     → ${c.fix}` : ""}`).join("\n");
  const next = (fails[0] || warns[0])?.fix;
  const summary =
    verdict === "PASS"
      ? "VERDICT: healthy — all checks pass."
      : `VERDICT: ${verdict} — ${fails.length} fail, ${warns.length} warn.` + (next ? `\nNEXT: ${next}` : "");
  return `# stack_doctor — ${server} (${dir})\n${body}\n\n${summary}`;
}
