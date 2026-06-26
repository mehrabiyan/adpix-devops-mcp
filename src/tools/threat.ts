import { z } from "zod";
import { withSession } from "../deps.js";
import { shq, lastLines } from "../util.js";
import type { ToolDef } from "./types.js";

const serverParam = z.string().optional().describe("Target server name. Omit to use the default.");

// known cryptominer / dropper process names + the IR-2026-06-26 IOCs
const MINER_RX = /xmrig|minerd|cpuminer|kinsing|kdevtmpfs|kthreaddi|moneroocean|supportxmr|nanopool|stratum\+tcp|\/tmp\/dashboard|\.shchmod|gulf\.moneroocean/i;
// common mining-pool ports (incl. the incident's 10128)
const MINER_PORTS = new Set(["3333", "4444", "5555", "7777", "9000?", "14444", "45700", "10128", "18081", "5500"]);

/**
 * threat_scan — read-only compromise hunt on a host (proactive + post-incident). Looks for the exact
 * shapes of the IR-2026-06-26 XMRig miner: known-miner / high-CPU processes, executables dropped in
 * /tmp (host + inside containers), outbound connections to mining-pool ports, public listeners beyond
 * SSH/80/443, and containers running as ROOT shipping a shell/wget (the payload-download enabler).
 * Returns findings by severity + a verdict. Pairs with quarantine for response.
 */
export const threatTools: ToolDef[] = [
  {
    name: "threat_scan",
    title: "Hunt a host for compromise (miners, droppers, bad egress)",
    description:
      "Read-only threat hunt: known-miner/high-CPU processes, /tmp droppers (host + in containers), outbound " +
      "to mining-pool ports, public listeners beyond SSH/80/443, and containers running as root shipping a " +
      "shell/wget. Returns findings + a verdict (CLEAN / SUSPICIOUS / COMPROMISED). Use quarantine to respond.",
    schema: { server: serverParam, cpuThreshold: z.number().int().min(20).max(100).default(80).describe("Flag a non-system process above this %CPU") },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; cpuThreshold: number };
      return withSession(deps, a.server, async (s, srv) => {
        const probe = [
          `echo ===PROCS; ps -eo pcpu,pid,user,comm,args --sort=-pcpu 2>/dev/null | head -12`,
          `echo ===MINER; ps -eo comm,args 2>/dev/null | grep -iE 'xmrig|minerd|cpuminer|kinsing|kdevtmpfs|moneroocean|supportxmr|nanopool|stratum|/tmp/dashboard|.shchmod' | grep -v grep | head`,
          `echo ===TMP; find /tmp /var/tmp /dev/shm -maxdepth 3 -type f -perm -u+x 2>/dev/null | head -20`,
          `echo ===CONNS; ss -tnp 2>/dev/null | awk '/ESTAB/{print $5}' | sort -u | head -50`,
          `echo ===LISTEN; ss -ltn 2>/dev/null | awk 'NR>1{print $4}' | grep -vE '127\\.0\\.0\\.1|\\[?::1' | sort -u`,
          `echo ===CTN; for c in $(docker ps -q 2>/dev/null); do n=$(docker inspect -f '{{.Name}}' $c 2>/dev/null|tr -d /); u=$(docker inspect -f '{{.Config.User}}' $c 2>/dev/null); t=$(docker exec $c sh -c 'command -v wget curl busybox 2>/dev/null' 2>/dev/null|tr '\\n' ',' ); m=$(docker top $c 2>/dev/null | grep -iE 'xmrig|miner|kinsing|stratum'|head -1); echo "$n|user=\${u:-root}|net=$t|miner=$m"; done`,
        ].join("; ");
        const r = await s.exec(probe, { timeoutMs: 60_000 });
        const sec: Record<string, string> = {};
        let cur = "";
        for (const line of r.stdout.split("\n")) { const m = line.match(/^===(\w+)/); if (m) { cur = m[1]; sec[cur] = ""; } else if (cur) sec[cur] += line + "\n"; }

        const findings: { level: "CRIT" | "WARN" | "INFO"; what: string }[] = [];
        // miner processes
        const miners = (sec.MINER || "").trim();
        if (miners) findings.push({ level: "CRIT", what: `cryptominer/dropper process running:\n      ${lastLines(miners, 6).replace(/\n/g, "\n      ")}` });
        // high-CPU non-system processes
        for (const ln of (sec.PROCS || "").split("\n").slice(1)) {
          const m = ln.trim().match(/^(\d+(?:\.\d+)?)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
          if (!m) continue;
          const cpu = parseFloat(m[1]); const comm = m[4]; const argv = m[5];
          if (cpu >= a.cpuThreshold && !/^(clickhouse|postgres|node|next-server|caddy|redis|minio|java|dockerd|containerd)/.test(comm)) {
            findings.push({ level: MINER_RX.test(argv) ? "CRIT" : "WARN", what: `process ${comm} (pid ${m[2]}, ${m[3]}) at ${cpu}% CPU${MINER_RX.test(argv) ? " — MINER signature" : " — investigate"}` });
          }
        }
        // /tmp droppers
        const tmp = (sec.TMP || "").trim().split("\n").filter(Boolean);
        if (tmp.length) findings.push({ level: MINER_RX.test(sec.TMP) ? "CRIT" : "WARN", what: `executable files in tmp dirs (payload droppers live here): ${tmp.slice(0, 8).join(", ")}` });
        // outbound to mining ports
        const badConns = (sec.CONNS || "").split("\n").map((l) => l.trim()).filter(Boolean).filter((c) => { const p = c.split(":").pop() || ""; return MINER_PORTS.has(p) || /77\.90\.13\.20|moneroocean/.test(c); });
        if (badConns.length) findings.push({ level: "CRIT", what: `outbound connection to a mining-pool port / IOC: ${badConns.join(", ")}` });
        // public listeners beyond SSH/80/443
        const pub = (sec.LISTEN || "").split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => { const port = l.split(":").pop() || ""; return !["80", "443", String(srv.port), "22"].includes(port); });
        if (pub.length) findings.push({ level: "WARN", what: `public listeners beyond SSH/80/443 (attack surface — bind internal): ${pub.slice(0, 12).join(", ")}` });
        // containers root + shippable network tools
        for (const ln of (sec.CTN || "").split("\n").map((l) => l.trim()).filter(Boolean)) {
          if (/miner=\S/.test(ln)) findings.push({ level: "CRIT", what: `container ${ln.split("|")[0]} is running a miner process` });
          const user = ((ln.match(/user=([^|]*)/) || [])[1] || "").trim();
          const root = user === "" || user === "root" || user === "0";
          const tools = (ln.match(/net=([^|]*)/) || [])[1] || "";
          if (root && /wget|curl|busybox/.test(tools)) findings.push({ level: "WARN", what: `container ${ln.split("|")[0]} runs as ROOT and ships ${tools.replace(/,$/, "")} — this is what let the dropper wget+exec the miner (IR 2.2). Use a non-root, minimal image` });
        }

        const crit = findings.filter((f) => f.level === "CRIT").length;
        const warn = findings.filter((f) => f.level === "WARN").length;
        const verdict = crit ? "COMPROMISED" : warn ? "SUSPICIOUS" : "CLEAN";
        return [
          `# Threat scan — ${srv.name}  → ${verdict}`,
          findings.length ? findings.map((f) => `  ${f.level === "CRIT" ? "🔴" : f.level === "WARN" ? "🟠" : "·"} [${f.level}] ${f.what}`).join("\n") : "  ✓ No miner processes, droppers, mining-pool connections, or root+shell containers found.",
          ``,
          crit
            ? `→ COMPROMISED. Contain now: quarantine server=${srv.name} container=<name> stop:true (kills the process), block the egress IP, snapshot evidence. Then rotate ALL secrets + rebuild from a clean image (IR Part 3).`
            : warn
            ? `→ Reduce attack surface: harden_server (firewall + key-only SSH + fail2ban), bind internal ports to loopback, and run app containers non-root on a minimal image.`
            : `→ Clean on these checks. Keep harden_server + the watchdog + patch_system current.`,
        ].join("\n");
      });
    },
  },

  {
    name: "quarantine",
    title: "Contain a compromised container (snapshot + stop + block egress)",
    description:
      "Incident response for a compromised container: SNAPSHOT evidence (docker inspect, logs, in-container ps + " +
      "/tmp listing) to /root/ir-<ts>/ (always, read-only), then optionally STOP it (kills a miner) and BLOCK " +
      "egress to a bad IP (iptables DROP). stop/blockIp change the system — confirm:true required. Snapshot the " +
      "evidence BEFORE you rebuild.",
    schema: {
      server: serverParam,
      container: z.string().describe("Container name/id to contain (e.g. adanalytics-web-1)"),
      stop: z.boolean().default(false).describe("Stop the container (kills the running payload)"),
      blockIp: z.string().optional().describe("Block all egress to this IP (the payload/C2 host), e.g. 77.90.13.20"),
      confirm: z.boolean().default(false).describe("Required for stop / blockIp (they change the system)"),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; container: string; stop: boolean; blockIp?: string; confirm: boolean };
      if ((a.stop || a.blockIp) && !a.confirm) return `REFUSED: stop / blockIp change the system. Re-run with confirm:true (snapshot still runs read-only without it).`;
      const c = shq(a.container);
      return withSession(deps, a.server, async (s, srv) => {
        const out: string[] = [`# Quarantine ${a.container} on ${srv.name}`];
        // 1. snapshot evidence (read-only) — preserve before any rebuild
        const snap = await s.exec(
          `D=/root/ir-$(date -u +%Y%m%d-%H%M%S); mkdir -p $D && ` +
          `docker inspect ${c} > $D/inspect.json 2>&1; docker logs --tail 2000 ${c} > $D/logs.txt 2>&1; ` +
          `docker top ${c} auxww > $D/ps.txt 2>&1 || docker exec ${c} ps aux > $D/ps.txt 2>&1; ` +
          `docker exec ${c} sh -c 'ls -la /tmp /dev/shm /var/tmp 2>/dev/null' > $D/tmp.txt 2>&1; ` +
          `docker diff ${c} > $D/diff.txt 2>&1; echo $D`,
          { timeoutMs: 60_000 }
        );
        const dir = snap.stdout.trim().split("\n").pop() || "/root/ir-?";
        out.push(`## Evidence\nSnapshotted to ${dir}/ (inspect.json, logs.txt, ps.txt, tmp.txt, diff.txt). Copy it OFF-box before rebuilding.`);

        if (a.blockIp) {
          const ip = a.blockIp.replace(/[^0-9.]/g, "");
          const b = await s.exec(`iptables -C OUTPUT -d ${shq(ip)} -j DROP 2>/dev/null || iptables -I OUTPUT -d ${shq(ip)} -j DROP; iptables -C DOCKER-USER -d ${shq(ip)} -j DROP 2>/dev/null || iptables -I DOCKER-USER -d ${shq(ip)} -j DROP 2>/dev/null || true; echo blocked`, { timeoutMs: 30_000 });
          out.push(`## Egress block\nDROP all traffic to ${ip} (host + DOCKER-USER) — exit ${b.code}. (Not persistent across reboot; add to your firewall rules.)`);
        }
        if (a.stop) {
          const st = await s.exec(`docker stop ${c} 2>&1`, { timeoutMs: 120_000 });
          out.push(`## Stopped\n${st.stdout.trim()} (exit ${st.code}). The container is stopped — the running payload is killed. Do NOT just restart it: rebuild from a known-good image (the fs is untrusted).`);
        }
        out.push(`## Next\nRotate every secret the container's env held (it's exfiltrated), rebuild from a clean minimal non-root image, then re-run threat_scan + security_audit to confirm.`);
        return out.join("\n\n");
      });
    },
  },
];
