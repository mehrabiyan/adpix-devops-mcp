import { z } from "zod";
import { withSession } from "../deps.js";
import { uploadFile } from "../adpix.js";
import { shq, lastLines } from "../util.js";
import type { ToolDef } from "./types.js";

const serverParam = z.string().optional().describe("Target server name. Omit to use the default.");
const HP_DIR = "/opt/adpix-honeypot";
const PROJECT = "adpix-honeypot";

/**
 * Decoy service catalog. Each entry occupies an ATTACKER-EXPECTED host port (a service an intruder would
 * scan for) that must NOT be one a real service uses — the deploy path only binds ports found free. The
 * container listens on a high port (so it can run as unprivileged `nobody`); Docker DNATs the low host
 * port to it. `banner` is the fake service greeting used to keep the attacker engaged.
 */
const DECOYS: { svc: string; host: number; listen: number; banner: string }[] = [
  { svc: "telnet", host: 23, listen: 20023, banner: "\r\nUbuntu 22.04 LTS\r\nlogin: " },
  { svc: "ssh-alt", host: 2222, listen: 22222, banner: "SSH-2.0-OpenSSH_8.9p1 Ubuntu-3" },
  { svc: "mysql", host: 3306, listen: 13306, banner: "5.7.42-log" },
  { svc: "postgres", host: 5432, listen: 15432, banner: "" },
  { svc: "redis", host: 6379, listen: 16379, banner: "-NOAUTH Authentication required.\r\n" },
  { svc: "mongo", host: 27017, listen: 27018, banner: "" },
  { svc: "elastic", host: 9200, listen: 19200, banner: "" },
  { svc: "http-admin", host: 8080, listen: 18080, banner: "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"admin\"\r\n\r\n" },
];

// stdlib-only (no pip) asyncio TCP honeypot: fake banner, tarpit, log every peer + payload, never auth.
const HONEYPOT_PY = String.raw`import asyncio, json, datetime, os
CFG = json.load(open("/opt/hp/config.json"))
LOG = "/log/hits.log"
def log(ev):
    ev["ts"] = datetime.datetime.utcnow().isoformat() + "Z"
    try:
        with open(LOG, "a") as f: f.write(json.dumps(ev) + "\n")
    except Exception: pass
async def handle(reader, writer, svc, banner):
    peer = writer.get_extra_info("peername") or ("?", 0)
    ip = peer[0] if isinstance(peer, (list, tuple)) else "?"
    log({"event": "connect", "svc": svc, "src_ip": ip})
    try:
        if banner:
            writer.write(banner.encode("latin1", "ignore")); await writer.drain()
        total = 0
        while total < 8192:
            try:
                data = await asyncio.wait_for(reader.read(1024), timeout=30)
            except asyncio.TimeoutError:
                break
            if not data: break
            total += len(data)
            log({"event": "data", "svc": svc, "src_ip": ip, "bytes": len(data), "sample": data[:240].decode("latin1", "ignore")})
            await asyncio.sleep(3)  # tarpit — waste the attacker's time
            try:
                writer.write(b"\r\nAccess denied. Login incorrect.\r\n"); await writer.drain()
            except Exception: break
    except Exception as e:
        log({"event": "error", "svc": svc, "src_ip": ip, "err": str(e)})
    finally:
        try: writer.close()
        except Exception: pass
        log({"event": "close", "svc": svc, "src_ip": ip})
async def main():
    servers = []
    for e in CFG["listeners"]:
        async def h(r, w, svc=e["svc"], banner=e.get("banner", "")): await handle(r, w, svc, banner)
        try:
            servers.append(await asyncio.start_server(h, "0.0.0.0", e["listen"]))
            log({"event": "listen", "svc": e["svc"], "port": e["listen"]})
        except Exception as ex:
            log({"event": "bind-failed", "svc": e["svc"], "port": e["listen"], "err": str(ex)})
    if servers:
        await asyncio.gather(*[s.serve_forever() for s in servers])
asyncio.run(main())
`;

function composeYaml(bound: typeof DECOYS): string {
  const ports = bound.map((d) => `      - "${d.host}:${d.listen}"`).join("\n");
  return (
    `# AdPix honeypot — ISOLATED decoy. internal:true = no egress, no route to real services.\n` +
    `# Hardened: non-root nobody, read-only rootfs, all caps dropped, no-new-privileges, no secrets/env.\n` +
    `services:\n` +
    `  trap:\n` +
    `    image: python:3.12-alpine\n` +
    `    command: ["python", "/opt/hp/honeypot.py"]\n` +
    `    restart: unless-stopped\n` +
    `    user: "65534:65534"\n` +
    `    read_only: true\n` +
    `    cap_drop: ["ALL"]\n` +
    `    security_opt: ["no-new-privileges:true"]\n` +
    `    pids_limit: 64\n` +
    `    mem_limit: 128m\n` +
    `    tmpfs: ["/tmp"]\n` +
    `    networks: ["trap"]\n` +
    `    ports:\n${ports}\n` +
    `    volumes:\n` +
    `      - ${HP_DIR}/honeypot.py:/opt/hp/honeypot.py:ro\n` +
    `      - ${HP_DIR}/config.json:/opt/hp/config.json:ro\n` +
    `      - ${HP_DIR}/log:/log\n` +
    `networks:\n` +
    `  trap:\n` +
    `    internal: true\n`   // no default route → the container can receive but never reach anything
  );
}

export const honeypotTools: ToolDef[] = [
  {
    name: "honeypot",
    title: "Deception honeypot — isolated decoy that traps + reports attackers",
    description:
      "Deploy an ISOLATED deception honeypot: a hardened decoy container that occupies attacker-expected ports " +
      "(telnet/ssh-alt/mysql/postgres/redis/mongo/elastic/http-admin) — never a port a real service uses — serves " +
      "fake banners, tarpits to waste the attacker's time, and logs every source IP + payload. It is FULLY " +
      "CONTAINED (internal-only network = no egress and no route to real services, non-root, read-only rootfs, all " +
      "capabilities dropped, no-new-privileges, no secrets) so it can lead nowhere and gives no escalation path. " +
      "actions: plan (dry-run — shows which free ports it would trap + the isolation guarantees), deploy (confirm), " +
      "status, report (top attacker IPs / creds / payloads; block:true DROPs them on the host), remove (confirm).",
    schema: {
      server: serverParam,
      action: z.enum(["plan", "deploy", "status", "report", "remove"]).default("plan"),
      services: z.array(z.enum(DECOYS.map((d) => d.svc) as [string, ...string[]])).optional().describe("Which decoys to run (default: every one whose port is free)"),
      block: z.boolean().default(false).describe("report: iptables-DROP the caught attacker IPs on the host"),
      confirm: z.boolean().default(false).describe("Required for deploy / remove"),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; action: "plan" | "deploy" | "status" | "report" | "remove"; services?: string[]; block: boolean; confirm: boolean };
      return withSession(deps, a.server, async (s, srv) => {
        const wanted = a.services?.length ? DECOYS.filter((d) => a.services!.includes(d.svc)) : DECOYS;

        if (a.action === "status") {
          const r = await s.exec(`docker ps --filter label=com.docker.compose.project=${PROJECT} --format '{{.Names}} {{.Status}} {{.Ports}}' 2>/dev/null; echo ---; tail -1 ${shq(HP_DIR + "/log/hits.log")} 2>/dev/null || echo "no hits yet"`, { timeoutMs: 20_000 });
          const [ps, tail] = r.stdout.split("---");
          return `# Honeypot status — ${srv.name}\n${(ps || "").trim() || "not deployed (honeypot plan → deploy)"}\n\nLast log line: ${(tail || "").trim()}`;
        }

        if (a.action === "report") {
          const r = await s.exec(
            `L=${shq(HP_DIR + "/log/hits.log")}; test -f "$L" || { echo __NOLOG__; exit 0; }; ` +
            `echo ===HITS; grep -c '"event": "connect"' "$L" 2>/dev/null || echo 0; ` +
            `echo ===IPS; grep -oE '"src_ip": "[^"]+"' "$L" | sed 's/.*: "//;s/"//' | sort | uniq -c | sort -rn | head -15; ` +
            `echo ===SVC; grep -oE '"svc": "[^"]+"' "$L" | sed 's/.*: "//;s/"//' | sort | uniq -c | sort -rn; ` +
            `echo ===SAMPLES; grep '"event": "data"' "$L" | tail -8`,
            { timeoutMs: 30_000 }
          );
          if (r.stdout.includes("__NOLOG__")) return `No honeypot log yet at ${HP_DIR}/log/hits.log — deploy it first (honeypot action=deploy confirm:true).`;
          const sec: Record<string, string> = {}; let cur = "";
          for (const ln of r.stdout.split("\n")) { const m = ln.match(/^===(\w+)/); if (m) { cur = m[1]; sec[cur] = ""; } else if (cur) sec[cur] += ln + "\n"; }
          const ips = (sec.IPS || "").trim().split("\n").filter(Boolean).map((l) => l.trim().split(/\s+/)).map(([n, ip]) => ({ n: parseInt(n, 10) || 0, ip }));
          let blocked = "";
          if (a.block && ips.length) {
            const top = ips.slice(0, 20).map((x) => x.ip).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
            if (top.length) { await s.exec(top.map((ip) => `iptables -C INPUT -s ${shq(ip)} -j DROP 2>/dev/null || iptables -I INPUT -s ${shq(ip)} -j DROP`).join("; "), { timeoutMs: 30_000 }); blocked = `\n\nBlocked ${top.length} attacker IP(s) at the host firewall (INPUT DROP): ${top.join(", ")}. (Not persistent across reboot.)`; }
          }
          return [
            `# Honeypot report — ${srv.name}`,
            `Total decoy connections: ${(sec.HITS || "0").trim()}`,
            `Top attacker IPs:\n${ips.map((x) => `  ${String(x.n).padStart(4)} × ${x.ip}`).join("\n") || "  (none yet)"}`,
            `Services probed:\n${(sec.SVC || "").trim().split("\n").map((l) => "  " + l.trim()).join("\n") || "  (none)"}`,
            `Recent payloads:\n${lastLines((sec.SAMPLES || "").trim(), 8)}`,
            blocked || `\nRe-run with block:true to DROP these IPs on the host.`,
          ].join("\n\n");
        }

        // plan / deploy / remove need the free-port set
        if (a.action === "remove") {
          if (!a.confirm) return `REFUSED: remove tears down the honeypot. Re-run with confirm:true.`;
          const r = await s.exec(`cd ${shq(HP_DIR)} 2>/dev/null && docker compose -p ${PROJECT} down 2>&1; echo done`, { timeoutMs: 60_000 });
          return `# Honeypot removed — ${srv.name}\n${lastLines(r.stdout, 6)}\n\nEvidence kept at ${HP_DIR}/log/. Decoy ports are freed.`;
        }

        // which decoy host ports are actually free (never steal a real service's port)
        const listen = await s.exec(`ss -ltnH 2>/dev/null | awk '{print $4}' | grep -oE '[0-9]+$' | sort -un | tr '\\n' ' '`, { timeoutMs: 15_000 });
        const used = new Set(listen.stdout.trim().split(/\s+/).filter(Boolean).map(Number));
        const bound = wanted.filter((d) => !used.has(d.host));
        const skipped = wanted.filter((d) => used.has(d.host));

        const guarantees =
          `Isolation (why it can lead nowhere):\n` +
          `  · network internal:true → no egress, no route to real services or the internet\n` +
          `  · runs as nobody (65534), read-only rootfs, ALL caps dropped, no-new-privileges\n` +
          `  · no secrets, no env, mem 128m / pids 64 — nothing to steal, no privilege to escalate\n` +
          `  · only binds ports found FREE — never takes over a real service`;

        if (a.action === "plan") {
          return [
            `# Honeypot plan — ${srv.name}`,
            bound.length ? `Would trap these free attacker-magnet ports:\n${bound.map((d) => `  ${String(d.host).padEnd(6)} ${d.svc}`).join("\n")}` : `No free decoy ports — every candidate port is already in use.`,
            skipped.length ? `Skipped (a real service holds the port): ${skipped.map((d) => `${d.host}/${d.svc}`).join(", ")}` : ``,
            guarantees,
            `Deploy: honeypot action=deploy confirm:true  → then honeypot action=report to see who's knocking.`,
          ].filter(Boolean).join("\n\n");
        }

        // deploy
        if (!a.confirm) return `REFUSED: deploy runs a decoy container binding ${bound.length} port(s). Re-run with confirm:true. (Run action=plan first to preview.)`;
        if (!bound.length) return `No free decoy ports to trap on ${srv.name} — nothing deployed. (Harden the host first so the attacker-magnet ports are free for the honeypot.)`;
        const config = JSON.stringify({ listeners: bound.map((d) => ({ svc: d.svc, listen: d.listen, banner: d.banner })) }, null, 2);
        await s.exec(`mkdir -p ${shq(HP_DIR + "/log")}`, { timeoutMs: 10_000 });
        await uploadFile(s, `${HP_DIR}/honeypot.py`, HONEYPOT_PY, "644");
        await uploadFile(s, `${HP_DIR}/config.json`, config, "644");
        await uploadFile(s, `${HP_DIR}/docker-compose.yml`, composeYaml(bound), "644");
        const up = await s.exec(`cd ${shq(HP_DIR)} && docker compose -p ${PROJECT} up -d 2>&1`, { timeoutMs: 180_000 });
        const ok = /Started|Running|Created|Recreated/.test(up.stdout) || up.code === 0;
        return [
          `# Honeypot ${ok ? "deployed" : "deploy FAILED"} — ${srv.name}`,
          ok ? `Trapping ${bound.length} port(s): ${bound.map((d) => `${d.host}/${d.svc}`).join(", ")}.` : lastLines(up.stdout, 8),
          skipped.length ? `Skipped (real service on the port): ${skipped.map((d) => d.host).join(", ")}` : ``,
          guarantees,
          ok ? `Any connection to these ports is now a confirmed intruder — honeypot action=report (block:true to firewall them).` : `If the image couldn't be pulled (egress-blocked node), relay python:3.12-alpine and retry.`,
        ].filter(Boolean).join("\n\n");
      });
    },
  },
];
