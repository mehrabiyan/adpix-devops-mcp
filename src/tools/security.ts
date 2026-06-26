import { z } from "zod";
import { withSession } from "../deps.js";
import type { Session } from "../ssh.js";
import type { ServerConfig } from "../registry.js";
import { shq, lastLines } from "../util.js";
import type { ToolDef } from "./types.js";

const serverParam = z
  .string()
  .optional()
  .describe("Registered server name. Omit to use the default server.");

const DATASTORE_PORTS = new Set([5432, 8123, 9000, 9009, 3306, 6379, 27017, 9092, 2375, 2376]);

const SSH_HARDENING_FILE = "/etc/ssh/sshd_config.d/90-adpix-hardening.conf";
const SSH_HARDENING_CONTENT = [
  "# Installed by adpix-devops-mcp harden_server",
  "PasswordAuthentication no",
  "PermitRootLogin prohibit-password",
  "MaxAuthTries 5",
  "X11Forwarding no",
  "ClientAliveInterval 300",
  "ClientAliveCountMax 4",
].join("\\n");

export interface AuditFinding {
  level: "PASS" | "WARN" | "FAIL";
  what: string;
}

export async function runAudit(s: Session, srv: ServerConfig): Promise<AuditFinding[]> {
  const r = await s.exec(
    [
      `echo ===SSHD; sshd -T 2>/dev/null | grep -E '^(permitrootlogin|passwordauthentication) ' || grep -rhiE '^\\s*(PermitRootLogin|PasswordAuthentication)\\b' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ 2>/dev/null || echo unknown`,
      `echo ===UFW; ufw status 2>/dev/null | head -1 || echo missing`,
      `echo ===PORTS; ss -tlnH 2>/dev/null | awk '{print $4}' | grep -E '(0\\.0\\.0\\.0|\\[::\\]|\\*):' | grep -oE '[0-9]+$' | sort -un | tr '\\n' ' '; echo`,
      `echo ===F2B; systemctl is-active fail2ban 2>/dev/null || echo inactive`,
      `echo ===AUTOUPD; grep -h 'APT::Periodic::Unattended-Upgrade' /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null || echo missing`,
      `echo ===UPD; apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep ^Inst | wc -l; apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep ^Inst | grep -ci securi || true`,
      `echo ===REBOOT; test -f /var/run/reboot-required && echo yes || echo no`,
      `echo ===DOCKERPORTS; docker ps --format '{{.Names}} -> {{.Ports}}' 2>/dev/null | grep -E '0\\.0\\.0\\.0|:::' || echo none`,
      `echo ===ENVPERM; stat -c '%a %U' ${shq(srv.adpixDir + "/.env")} 2>/dev/null || echo missing`,
      `echo ===CTNROOT; for c in $(docker ps -q 2>/dev/null|head -20); do n=$(docker inspect -f '{{.Name}}' $c 2>/dev/null|tr -d /); u=$(docker inspect -f '{{.Config.User}}' $c 2>/dev/null); t=$(docker exec $c sh -c 'command -v wget curl 2>/dev/null' 2>/dev/null|tr '\\n' ','); if [ -z "$u" ] && [ -n "$t" ]; then echo "$n ships $t as root"; fi; done 2>/dev/null`,
      `echo ===BRUTE; journalctl --since '24 hours ago' 2>/dev/null | grep -c 'Failed password' || true`,
    ].join("; "),
    { timeoutMs: 240_000 }
  );

  const sec: Record<string, string> = {};
  let cur = "";
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^===(\w+)/);
    if (m) { cur = m[1]; sec[cur] = ""; }
    else if (cur) sec[cur] += line + "\n";
  }
  const g = (k: string) => (sec[k] ?? "").trim();
  const f: AuditFinding[] = [];

  const sshd = g("SSHD").toLowerCase();
  if (/passwordauthentication yes/.test(sshd)) f.push({ level: "WARN", what: "SSH password authentication enabled — brute-forceable; harden_server (sshHardening) disables it" });
  else if (/passwordauthentication no/.test(sshd)) f.push({ level: "PASS", what: "SSH password authentication disabled" });
  else f.push({ level: "WARN", what: `SSH PasswordAuthentication unclear (${sshd.split("\n")[0] || "unknown"})` });
  if (/permitrootlogin yes/.test(sshd)) f.push({ level: "WARN", what: "PermitRootLogin yes — prefer prohibit-password (keys only)" });
  else if (/permitrootlogin (no|prohibit-password|without-password)/.test(sshd)) f.push({ level: "PASS", what: "root SSH login is key-only or disabled" });

  if (/active/.test(g("UFW")) && !/inactive/.test(g("UFW"))) f.push({ level: "PASS", what: "ufw firewall active" });
  else f.push({ level: "WARN", what: `firewall not active (${g("UFW") || "?"}) — harden_server (firewall) enables ufw allowing ${srv.port}/80/443` });

  const openPorts = g("PORTS").split(/\s+/).filter(Boolean).map(Number);
  const allowed = new Set([22, srv.port, 80, 443]);
  const unexpected = openPorts.filter((p) => !allowed.has(p));
  const exposedStores = unexpected.filter((p) => DATASTORE_PORTS.has(p));
  if (exposedStores.length) f.push({ level: "FAIL", what: `internal datastore/API ports listening on all interfaces: ${exposedStores.join(", ")} — production must only expose ${srv.port}/80/443 (is the DEV compose running instead of compose.prod.yaml?)` });
  if (unexpected.filter((p) => !DATASTORE_PORTS.has(p)).length)
    f.push({ level: "WARN", what: `unexpected public listeners: ${unexpected.filter((p) => !DATASTORE_PORTS.has(p)).join(", ")}` });
  if (!unexpected.length) f.push({ level: "PASS", what: `only expected ports listen publicly (${openPorts.join(", ") || "none seen"})` });

  if (g("F2B") === "active") f.push({ level: "PASS", what: "fail2ban active" });
  else f.push({ level: "WARN", what: "fail2ban not active — harden_server (fail2ban) installs an sshd jail" });

  if (/"1"/.test(g("AUTOUPD"))) f.push({ level: "PASS", what: "unattended security upgrades enabled" });
  else f.push({ level: "WARN", what: "unattended-upgrades not configured — harden_server (autoUpdates) fixes this" });

  const [updTotal = "0", updSec = "0"] = g("UPD").split("\n").map((x) => x.trim());
  if (Number(updSec) > 0) f.push({ level: "WARN", what: `${updSec} security update(s) pending (of ${updTotal} total) — run patch_system` });
  else f.push({ level: "PASS", what: `no pending security updates (${updTotal} total upgradable)` });

  if (g("REBOOT") === "yes") f.push({ level: "WARN", what: "reboot required to finish earlier updates (kernel/libc) — patch_system with autoReboot, in a quiet window" });

  const dockerPorts = g("DOCKERPORTS");
  const badPublish = dockerPorts
    .split("\n")
    .filter((l) => l && l !== "none")
    .filter((l) => !/caddy/.test(l) || !/:(80|443)->/.test(l.replace(/0\.0\.0\.0|:::/g, "")));
  if (dockerPorts === "none" || badPublish.length === 0) f.push({ level: "PASS", what: "docker publishes only Caddy 80/443" });
  else f.push({ level: "FAIL", what: `containers publishing unexpected host ports:\n      ${badPublish.join("\n      ")}` });

  const envPerm = g("ENVPERM");
  if (envPerm === "missing") f.push({ level: "WARN", what: `${srv.adpixDir}/.env not found (not installed yet?)` });
  else if (/^[64]00 root/.test(envPerm)) f.push({ level: "PASS", what: `.env permissions tight (${envPerm})` });
  else f.push({ level: "WARN", what: `.env is ${envPerm} — should be 600 root (chmod 600, chown root)` });

  const ctnRoot = g("CTNROOT");
  if (ctnRoot) f.push({ level: "WARN", what: `container(s) run as ROOT and ship wget/curl — a code-exec bug then downloads + runs a payload (this is exactly IR 2.2 → the XMRig drop):\n      ${ctnRoot.split("\n").filter(Boolean).join("\n      ")}\n      Fix: non-root USER, minimal/distroless image (no wget/curl/shell), /tmp noexec.` });
  else f.push({ level: "PASS", what: "no running container ships wget/curl as root" });

  const brute = Number(g("BRUTE") || 0);
  if (brute > 200) f.push({ level: "WARN", what: `${brute} failed SSH password attempts in 24h — enable fail2ban + disable password auth` });
  else f.push({ level: "PASS", what: `${brute} failed SSH login attempts in last 24h` });

  return f;
}

function renderFindings(findings: AuditFinding[]): string {
  const order = { FAIL: 0, WARN: 1, PASS: 2 } as const;
  const sorted = [...findings].sort((x, y) => order[x.level] - order[y.level]);
  const fails = findings.filter((x) => x.level === "FAIL").length;
  const warns = findings.filter((x) => x.level === "WARN").length;
  const verdict = fails ? "ACTION REQUIRED" : warns ? "ROOM TO HARDEN" : "GOOD";
  return (
    `Verdict: ${verdict} (${fails} fail, ${warns} warn, ${findings.length - fails - warns} pass)\n\n` +
    sorted.map((x) => `${x.level.padEnd(4)} ${x.what}`).join("\n")
  );
}

export const securityTools: ToolDef[] = [
  {
    name: "security_audit",
    title: "Security audit",
    description:
      "Read-only security posture check: SSH config, firewall, publicly listening ports (catches a " +
      "dev stack exposing Postgres/ClickHouse), fail2ban, unattended upgrades, pending security " +
      "patches, reboot-required, docker-published ports, containers running as root that ship wget/curl, " +
      ".env permissions, and 24h brute-force volume. For active-compromise hunting (miners, droppers, bad " +
      "egress) use threat_scan; to contain a hit use quarantine.",
    schema: { server: serverParam },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string };
      return withSession(deps, a.server, async (s, srv) => {
        const findings = await runAudit(s, srv);
        return `# Security audit — ${srv.name} (${srv.host})\n` + renderFindings(findings) +
          `\n\nFix the gaps with harden_server (firewall, fail2ban, autoUpdates, sshHardening) and patch_system.`;
      });
    },
  },

  {
    name: "harden_server",
    title: "Harden server",
    description:
      "Apply a security baseline: ufw firewall (allow SSH/80/443, deny the rest), fail2ban sshd jail, " +
      "unattended security upgrades, and SSH hardening (no password auth, key-only root). " +
      "Dry-run by default — set apply:true to make changes. SSH hardening is refused when the current " +
      "session authenticated with a password (it would lock you out).",
    schema: {
      server: serverParam,
      apply: z.boolean().default(false).describe("false = show the plan only; true = execute it"),
      components: z
        .array(z.enum(["firewall", "fail2ban", "autoUpdates", "sshHardening"]))
        .default(["firewall", "fail2ban", "autoUpdates", "sshHardening"]),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; apply: boolean; components: string[] };
      return withSession(deps, a.server, async (s, srv) => {
        const apt = "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq";
        const steps: { name: string; cmd: string; note?: string }[] = [];

        if (a.components.includes("firewall")) {
          steps.push({
            name: "firewall (ufw)",
            // SSH port is allowed BEFORE enabling so we can't cut ourselves off.
            cmd:
              `(command -v ufw >/dev/null || (apt-get update -qq && ${apt} ufw)) && ` +
              `ufw allow ${srv.port}/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ` +
              `ufw --force enable && ufw status verbose | head -15`,
            note: `allows ${srv.port} (SSH), 80, 443; default-deny everything else`,
          });
        }
        if (a.components.includes("fail2ban")) {
          steps.push({
            name: "fail2ban (sshd jail)",
            cmd:
              `(command -v fail2ban-server >/dev/null || (apt-get update -qq && ${apt} fail2ban)) && ` +
              `printf '[sshd]\\nenabled = true\\nbackend = systemd\\n' > /etc/fail2ban/jail.d/adpix-sshd.local && ` +
              `systemctl enable --now fail2ban && systemctl restart fail2ban && sleep 2 && systemctl is-active fail2ban`,
            note: "bans IPs that brute-force SSH",
          });
        }
        if (a.components.includes("autoUpdates")) {
          steps.push({
            name: "unattended security upgrades",
            cmd:
              `(dpkg -s unattended-upgrades >/dev/null 2>&1 || (apt-get update -qq && ${apt} unattended-upgrades)) && ` +
              `printf 'APT::Periodic::Update-Package-Lists "1";\\nAPT::Periodic::Unattended-Upgrade "1";\\n' > /etc/apt/apt.conf.d/20auto-upgrades && ` +
              `cat /etc/apt/apt.conf.d/20auto-upgrades`,
            note: "security patches install themselves daily",
          });
        }
        if (a.components.includes("sshHardening")) {
          if (s.authMethod === "password") {
            steps.push({
              name: "SSH hardening — SKIPPED",
              cmd: "",
              note: "this session authenticated with a PASSWORD; disabling password auth would lock you out. Set up key auth first.",
            });
          } else {
            steps.push({
              name: "SSH hardening",
              // sshd -t validates before reload; on failure the drop-in is removed so sshd keeps working.
              cmd:
                `mkdir -p /etc/ssh/sshd_config.d && ` +
                `printf '${SSH_HARDENING_CONTENT}\\n' > ${SSH_HARDENING_FILE} && ` +
                `(sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd) && echo 'sshd reloaded with hardening' ` +
                `|| (rm -f ${SSH_HARDENING_FILE}; echo 'sshd config validation FAILED — hardening rolled back'; exit 1))`,
              note: "key-only auth (PasswordAuthentication no, PermitRootLogin prohibit-password)",
            });
          }
        }

        if (!a.apply) {
          return (
            `# Hardening plan for ${srv.name} (dry-run — nothing changed)\n\n` +
            steps.map((st) => `## ${st.name}\n${st.note ? `(${st.note})\n` : ""}${st.cmd || "(no command)"}`).join("\n\n") +
            `\n\nRe-run with apply:true to execute.`
          );
        }

        const results: string[] = [];
        for (const st of steps) {
          if (!st.cmd) {
            results.push(`## ${st.name}\n${st.note ?? ""}`);
            continue;
          }
          const r = await s.exec(st.cmd, { timeoutMs: 420_000 });
          results.push(
            `## ${st.name} — ${r.code === 0 ? "done" : `FAILED (exit ${r.code})`}\n` +
              lastLines((r.stdout + (r.stderr ? "\n" + r.stderr : "")).trim(), 18)
          );
        }
        const after = await runAudit(s, srv);
        return (
          `# Hardening applied on ${srv.name}\n\n` +
          results.join("\n\n") +
          `\n\n# Post-hardening audit\n` +
          renderFindings(after)
        );
      });
    },
  },

  {
    name: "patch_system",
    title: "Patch the OS",
    description:
      "Apply OS package updates (apt). securityOnly limits it to security fixes via unattended-upgrade. " +
      "Reports whether a reboot is needed; will only reboot when BOTH autoReboot and confirm are true " +
      "(reboot happens 1 minute later; the stack auto-starts via Docker restart policies).",
    schema: {
      server: serverParam,
      securityOnly: z.boolean().default(false),
      autoReboot: z.boolean().default(false),
      confirm: z.boolean().default(false).describe("Required (with autoReboot) for the server to actually reboot"),
      timeoutSeconds: z.number().int().min(60).max(3600).default(1200),
    },
    annotations: { destructiveHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; securityOnly: boolean; autoReboot: boolean; confirm: boolean; timeoutSeconds: number };
      return withSession(deps, a.server, async (s, srv) => {
        await s.exec("apt-get update -qq", { timeoutMs: 300_000 });
        const upgradeCmd = a.securityOnly
          ? "command -v unattended-upgrade >/dev/null && unattended-upgrade -v 2>&1 || echo 'unattended-upgrades not installed — run harden_server (autoUpdates) or use securityOnly:false'"
          : "DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade 2>&1";
        const up = await s.exec(upgradeCmd, { timeoutMs: a.timeoutSeconds * 1000 });
        const reboot = await s.exec("test -f /var/run/reboot-required && echo yes || echo no");
        const needsReboot = reboot.stdout.trim() === "yes";

        let rebootMsg = needsReboot
          ? "A reboot is REQUIRED to finish (kernel/libc updated)."
          : "No reboot required.";
        if (needsReboot && a.autoReboot && a.confirm) {
          await s.exec("shutdown -r +1 'adpix-devops-mcp: post-patch reboot'");
          rebootMsg =
            "Reboot scheduled in 1 minute. The AdPix stack restarts automatically (Docker restart policies + watchdog). " +
            "Re-run health_check in ~3 minutes.";
        } else if (needsReboot && a.autoReboot && !a.confirm) {
          rebootMsg = "Reboot required and autoReboot requested, but confirm:false — re-run with confirm:true to reboot.";
        }

        return [
          `# Patching ${srv.name} (${a.securityOnly ? "security-only" : "full upgrade"}) — exit ${up.code}`,
          lastLines(up.stdout.trim() || "(no output)", 40),
          ``,
          rebootMsg,
        ].join("\n");
      });
    },
  },
];
