import { z } from "zod";
import { withSession } from "../deps.js";
import type { Session } from "../ssh.js";
import {
  ADPIX_REPO_URL,
  composeCmd,
  requireStack,
  stackState,
  readEnvVar,
  readSiteAddress,
  waitHealthyCmd,
} from "../adpix.js";
import {
  coreSshCommand,
  ensureSharedDeployKey,
  gitSshEnv,
  sharedKeyInstructions,
  toSshUrl,
} from "../github.js";
import { shq, redactSecrets, lastLines, parseComposePs, table } from "../util.js";
import type { ToolDef } from "./types.js";

const serverParam = z
  .string()
  .optional()
  .describe("Registered server name. Omit to use the default server.");

const SERVICES = [
  "ingest",
  "api",
  "worker",
  "identity-job",
  "web",
  "caddy",
  "postgres",
  "clickhouse",
] as const;

async function composePsTable(s: Session, dir: string): Promise<string> {
  const r = await s.exec(`${composeCmd(dir)} ps -a --format json`, { timeoutMs: 60_000 });
  const rows = parseComposePs(r.stdout);
  if (rows.length === 0) return "(no containers found — is the stack up?)";
  return table(
    ["SERVICE", "STATE", "HEALTH", "STATUS"],
    rows.map((c) => [c.Service || c.Name, c.State, c.Health || "-", c.Status])
  );
}

interface Preflight {
  ok: boolean;
  report: string;
}

async function preflight(s: Session, dir: string): Promise<Preflight> {
  const checks: string[] = [];
  let ok = true;
  const fail = (m: string) => { ok = false; checks.push(`FAIL ${m}`); };
  const warn = (m: string) => checks.push(`WARN ${m}`);
  const pass = (m: string) => checks.push(`ok   ${m}`);

  const os = await s.exec(". /etc/os-release 2>/dev/null && echo $ID/$ID_LIKE/$PRETTY_NAME");
  const [id = "", idLike = "", pretty = ""] = os.stdout.trim().split("/");
  if (/(debian|ubuntu)/.test(id) || /(debian|ubuntu)/.test(idLike)) pass(`OS: ${pretty || id}`);
  else fail(`OS "${pretty || id || "unknown"}" — deploy.sh targets Ubuntu/Debian`);

  const mem = await s.exec("free -m | awk '/^Mem:/{print $2}'");
  const memMb = Number(mem.stdout.trim() || 0);
  if (memMb < 1800) fail(`RAM ${memMb}MB — need >=2GB (4GB recommended: Postgres+ClickHouse+builds)`);
  else if (memMb < 3800) warn(`RAM ${memMb}MB — works, but 4GB recommended for builds + ClickHouse`);
  else pass(`RAM ${memMb}MB`);

  const disk = await s.exec("df -m / | awk 'NR==2{print $4}'");
  const diskMb = Number(disk.stdout.trim() || 0);
  if (diskMb < 10_000) fail(`free disk ${(diskMb / 1024).toFixed(1)}GB on / — need >=10GB`);
  else if (diskMb < 20_000) warn(`free disk ${(diskMb / 1024).toFixed(1)}GB on / — 20GB+ recommended`);
  else pass(`free disk ${(diskMb / 1024).toFixed(1)}GB`);

  // Ports 80/443 must be free, unless it's our own Caddy already there.
  const ports = await s.exec(
    `ss -ltnp 2>/dev/null | awk '$4 ~ /:(80|443)$/ {print $4, $6}' | sort -u`
  );
  const portsOut = ports.stdout.trim();
  if (!portsOut) pass("ports 80/443 free");
  else if (/docker|caddy/i.test(portsOut)) warn(`ports 80/443 already used by docker/caddy (existing install?):\n       ${portsOut.replace(/\n/g, "\n       ")}`);
  else fail(`ports 80/443 in use by another process:\n     ${portsOut.replace(/\n/g, "\n     ")}`);

  const existing = await s.exec(`test -d ${shq(dir + "/.git")} && echo yes || echo no`);
  if (existing.stdout.trim() === "yes")
    warn(`AdPix checkout already at ${dir} — install will update it (deploy.sh is idempotent); adpix_update is the usual tool for that`);

  return { ok, report: checks.join("\n") };
}

export const lifecycleTools: ToolDef[] = [
  {
    name: "adpix_install",
    title: "Install AdPix",
    description:
      "Install AdPix Analytics on the server: preflight checks (OS, RAM, disk, ports 80/443), " +
      "clone the repo, then run its idempotent scripts/deploy.sh (installs Docker, generates .env " +
      "with random secrets, builds the stack, applies migrations) and wait for the front door to be healthy. " +
      "With a domain, Caddy gets automatic Let's Encrypt HTTPS; without one it serves plain HTTP on the server IP. " +
      "First run builds images — expect 10–25 minutes.",
    schema: {
      server: serverParam,
      domain: z
        .string()
        .optional()
        .describe("Domain for HTTPS, e.g. analytics.example.com (its A-record must point at the server). Omit for HTTP-on-IP."),
      adminEmail: z.string().optional().describe("Admin login email (default admin@example.com)"),
      branch: z.string().default("main"),
      repoUrl: z.string().default(ADPIX_REPO_URL),
      deployKey: z
        .boolean()
        .default(false)
        .describe(
          "Private repo: generate a read-only SSH deploy key on the server and clone over SSH. " +
            "On first run it prints the one key line to add to GitHub, then re-run. Auto-on for git@ URLs."
        ),
      skipPreflight: z.boolean().default(false),
      timeoutSeconds: z.number().int().min(60).max(7200).default(2400),
    },
    annotations: { idempotentHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as {
        server?: string; domain?: string; adminEmail?: string; branch: string;
        repoUrl: string; deployKey: boolean; skipPreflight: boolean; timeoutSeconds: number;
      };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const sections: string[] = [];

        if (!a.skipPreflight) {
          const pf = await preflight(s, dir);
          sections.push(`## Preflight\n${pf.report}`);
          if (!pf.ok) {
            return sections.join("\n\n") + "\n\nInstall aborted — fix the FAIL items (or pass skipPreflight:true to force).";
          }
        }

        // git + curl present (deploy.sh installs Docker itself). git is also needed
        // for the deploy-key ls-remote probe below.
        await s.exec(
          "command -v git >/dev/null && command -v curl >/dev/null || " +
            "(apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates)",
          { timeoutMs: 300_000 }
        );

        // Private repo: use the ONE shared deploy key managed on the MCP (added to GitHub once,
        // distributed to each server) — no per-server key. The on-server path is shared with
        // cicd_enable, so enabling CD later needs no re-auth.
        const cloneCmd = (url: string, kEnv: string, postCfg: string) =>
          `if [ -d ${shq(dir + "/.git")} ]; then cd ${shq(dir)} && ${kEnv}git fetch origin ${shq(a.branch)} && git checkout ${shq(a.branch)} && ${kEnv}git pull --ff-only origin ${shq(a.branch)}; ` +
          `else mkdir -p $(dirname ${shq(dir)}) && ${kEnv}git clone -b ${shq(a.branch)} ${shq(url)} ${shq(dir)}${postCfg}; fi`;
        const useKey = a.deployKey || /^(git@|ssh:\/\/)/.test(a.repoUrl);
        let cloneUrl = a.repoUrl, keyEnv = "", postCloneCfg = "";
        // Switch to the shared key: returns false (and pushes a "## Repo is private" section) when
        // the key isn't authorized on GitHub yet, so the caller stops and asks to add it once.
        const applyKey = async (): Promise<boolean> => {
          const k = await ensureSharedDeployKey(deps, s, toSshUrl(a.repoUrl) ?? a.repoUrl, "adpix");
          if (!k.authorized) { sections.push(`## Repo is private — add ONE deploy key (reused for every server)\n${sharedKeyInstructions(k)}`); return false; }
          cloneUrl = k.sshUrl;
          keyEnv = gitSshEnv(k.prodKeyPath);
          postCloneCfg = ` && git -C ${shq(dir)} config core.sshCommand ${shq(coreSshCommand(k.prodKeyPath))}`;
          sections.push(`## Repo access\nShared read-only deploy key (managed on the MCP) authorized for ${k.owner}/${k.repo}; distributed to ${srv.name} and cloning over SSH.`);
          return true;
        };
        if (useKey && !(await applyKey())) {
          return sections.join("\n\n") + "\n\n(Nothing installed yet — add the key above to the repo's Deploy keys ONCE, then re-run adpix_install. Every future server reuses it.)";
        }

        let clone = await s.exec(cloneCmd(cloneUrl, keyEnv, postCloneCfg), { timeoutMs: 300_000 });
        if (clone.code !== 0 && !useKey) {
          const authish = /could not read Username|Authentication failed|terminal prompts disabled|repository not found|Permission denied|fatal: Could not read/i.test(clone.stderr + clone.stdout);
          if (authish) {
            // Private repo over HTTPS (no TTY) — auto-switch to the shared deploy key.
            if (!(await applyKey())) return sections.join("\n\n") + "\n\n(Nothing installed yet — add the key above to the repo's Deploy keys ONCE, then re-run adpix_install. Every future server reuses it.)";
            clone = await s.exec(cloneCmd(cloneUrl, keyEnv, postCloneCfg), { timeoutMs: 300_000 });
          }
        }
        if (clone.code !== 0) {
          return sections.join("\n\n") + `\n\n## Checkout FAILED (exit ${clone.code})\n${lastLines(clone.stderr || clone.stdout, 40)}`;
        }
        sections.push(`## Checkout\n${cloneUrl} @ ${a.branch} → ${dir}`);

        // Docker may be installed but the daemon stopped (e.g. after a reboot) — deploy.sh's
        // `docker info` check would then abort. Start it first (best-effort; deploy.sh installs
        // Docker itself if it's entirely absent).
        await s.exec(
          "command -v docker >/dev/null 2>&1 && (docker info >/dev/null 2>&1 || sudo -n systemctl start docker 2>/dev/null || systemctl start docker 2>/dev/null || service docker start 2>/dev/null) || true",
          { timeoutMs: 60_000 }
        );

        // deploy.sh: non-interactive (no TTY over exec). DOMAIN= empty selects HTTP-on-IP mode.
        const env = `DOMAIN=${shq(a.domain ?? "")}${a.adminEmail ? ` ADMIN_EMAIL=${shq(a.adminEmail)}` : ""}`;
        const dep = await s.exec(`cd ${shq(dir)} && ${env} ./scripts/deploy.sh 2>&1`, {
          timeoutMs: a.timeoutSeconds * 1000,
        });
        sections.push(`## deploy.sh (exit ${dep.code})\n${redactSecrets(lastLines(dep.stdout, 80))}`);
        if (dep.code !== 0) {
          return sections.join("\n\n") +
            "\n\n## Deploy FAILED\ndeploy.sh exited non-zero — the stack is NOT up. The script is idempotent: fix the cause and re-run adpix_install to resume. " +
            "Common causes: Docker daemon not running, out of disk on /var/lib/docker, OOM during the image build (need ~4GB RAM), or a migration error (Postgres/ClickHouse not healthy within 120s). " +
            "Dig in with adpix_logs / run_command. (The error is usually in the last lines above.)";
        }

        // deploy.sh exit 0 does NOT guarantee a running stack — verify the containers actually came up.
        const st = await stackState(s, dir);
        if (!st.up) {
          return sections.join("\n\n") +
            `\n\n## Deploy INCOMPLETE\ndeploy.sh finished but only ${st.running}/${st.total} containers are running — the stack is not up.\n${await composePsTable(s, dir)}\n` +
            `Re-run adpix_install (idempotent) after checking adpix_logs.`;
        }
        sections.push(`## Containers\n${st.running}/${st.total} running.`);

        const gate = await s.exec(waitHealthyCmd(150), { timeoutMs: 180_000 });
        sections.push(`## Health gate\n${gate.stdout.trim()}`);
        if (gate.code !== 0) {
          return sections.join("\n\n") +
            `\n\n## Front door not healthy yet\nContainers are up but the front door isn't answering 2xx/3xx. Give it a minute, then check adpix_status / adpix_logs — a service may still be starting or crash-looping.`;
        }
        const site = await readSiteAddress(s, dir);
        sections.push(
          `## Done\n` +
            `URL: ${site.publicBaseUrl}\n` +
            `Admin login: ${(await readEnvVar(s, dir, "ADMIN_EMAIL")) || "admin@example.com"} — password is in ${dir}/.env (ADMIN_PASSWORD; kept off this transcript)\n` +
            `Open ports 80+443 in the cloud firewall/security group.\n` +
            (site.domain ? `Point the ${site.domain} A-record at ${srv.host} — Caddy then issues HTTPS automatically.\n` : "") +
            `Recommended next: harden_server (firewall/fail2ban/auto-updates), watchdog_install (24/7 self-healing + alerts).`
        );
        return sections.join("\n\n");
      });
    },
  },

  {
    name: "adpix_update",
    title: "Update AdPix",
    description:
      "Update the AdPix install to the latest code: backup first (default), git pull, re-run the " +
      "idempotent deploy (rebuild + migrate), health-gate the result, and roll back to the previous " +
      "commit automatically if the stack doesn't come back healthy.",
    schema: {
      server: serverParam,
      branch: z.string().optional().describe("Branch to deploy (default: the branch currently checked out)"),
      skipBackup: z.boolean().default(false).describe("Skip the pre-update backup (not recommended)"),
      rollbackOnFailure: z.boolean().default(true),
      force: z.boolean().default(false).describe("Redeploy even when already on the newest commit"),
      timeoutSeconds: z.number().int().min(60).max(7200).default(2400),
    },
    annotations: { openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as {
        server?: string; branch?: string; skipBackup: boolean;
        rollbackOnFailure: boolean; force: boolean; timeoutSeconds: number;
      };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const sections: string[] = [];

        const isRepo = await s.exec(`test -d ${shq(dir + "/.git")} && echo yes || echo no`);
        if (isRepo.stdout.trim() !== "yes") {
          return `No AdPix checkout at ${dir} on ${srv.name} — run adpix_install first.`;
        }

        const prev = (await s.exec(`cd ${shq(dir)} && git rev-parse HEAD`)).stdout.trim();
        const curBranch = (await s.exec(`cd ${shq(dir)} && git rev-parse --abbrev-ref HEAD`)).stdout.trim();
        const branch = a.branch || curBranch;

        if (!a.skipBackup) {
          const bk = await s.exec(`cd ${shq(dir)} && ./scripts/backup.sh 2>&1`, { timeoutMs: 900_000 });
          if (bk.code !== 0) {
            return (
              `Pre-update backup FAILED (exit ${bk.code}) — update aborted to stay safe:\n` +
              lastLines(bk.stdout + bk.stderr, 30) +
              `\n\nFix the backup (is the stack running?) or pass skipBackup:true to proceed without one.`
            );
          }
          sections.push(`## Backup\n${lastLines(bk.stdout.trim(), 12)}`);
        }

        const pull = await s.exec(
          `cd ${shq(dir)} && git fetch origin ${shq(branch)} && git checkout ${shq(branch)} && git pull --ff-only origin ${shq(branch)} && git rev-parse HEAD`,
          { timeoutMs: 300_000 }
        );
        if (pull.code !== 0) {
          return sections.concat(`Git update failed (exit ${pull.code}):\n${lastLines(pull.stderr || pull.stdout, 30)}`).join("\n\n");
        }
        const next = pull.stdout.trim().split("\n").pop() ?? "";
        sections.push(`## Code\n${prev.slice(0, 10)} → ${next.slice(0, 10)} on ${branch}`);
        if (next === prev && !a.force) {
          return sections.join("\n\n") + "\n\nAlready up to date — nothing deployed (pass force:true to redeploy anyway).";
        }

        const dep = await s.exec(`cd ${shq(dir)} && ./scripts/deploy.sh 2>&1`, { timeoutMs: a.timeoutSeconds * 1000 });
        sections.push(`## deploy.sh (exit ${dep.code})\n${redactSecrets(lastLines(dep.stdout, 40))}`);

        let healthy = false;
        if (dep.code === 0) {
          const gate = await s.exec(waitHealthyCmd(150), { timeoutMs: 180_000 });
          healthy = gate.code === 0;
          sections.push(`## Health gate\n${gate.stdout.trim()}`);
        }

        if (!healthy && a.rollbackOnFailure && next !== prev) {
          sections.push(`## ROLLBACK → ${prev.slice(0, 10)}`);
          const rb = await s.exec(
            `cd ${shq(dir)} && git checkout ${shq(prev)} && ./scripts/deploy.sh 2>&1`,
            { timeoutMs: a.timeoutSeconds * 1000 }
          );
          const rbGate = await s.exec(waitHealthyCmd(150), { timeoutMs: 180_000 });
          sections.push(
            `rollback deploy exit ${rb.code}; ${rbGate.stdout.trim()}\n` +
              (rbGate.code === 0
                ? `Update FAILED but rollback restored the previous version. Investigate before retrying (adpix_logs).`
                : `Rollback did NOT come back healthy either — manual intervention needed (adpix_logs, health_check).`)
          );
        } else if (healthy) {
          sections.push(`## Done\nUpdate deployed and healthy.`);
        } else if (!healthy) {
          sections.push(`## Result\nDeploy unhealthy and rollback disabled/not possible — investigate with adpix_logs.`);
        }
        return sections.join("\n\n");
      });
    },
  },

  {
    name: "adpix_status",
    title: "AdPix status",
    description:
      "Snapshot of the install: container states/health, deployed git version, public URL, " +
      "Docker disk usage, and whether the watchdog timer is active.",
    schema: { server: serverParam },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const isRepo = await s.exec(`test -d ${shq(dir + "/.git")} && echo yes || echo no`);
        if (isRepo.stdout.trim() !== "yes") {
          return `No AdPix checkout at ${dir} on ${srv.name} — run adpix_install.`;
        }
        const [git, ps, site, df, wd] = [
          await s.exec(`cd ${shq(dir)} && git log -1 --format='%h %s (%ci)' && git rev-parse --abbrev-ref HEAD`),
          await composePsTable(s, dir),
          await readSiteAddress(s, dir),
          await s.exec("docker system df 2>/dev/null | head -6"),
          await s.exec("systemctl is-active adpix-watchdog.timer 2>/dev/null || true"),
        ];
        const gitLines = git.stdout.trim().split("\n");
        return [
          `# AdPix on ${srv.name} (${srv.host})`,
          `URL: ${site.publicBaseUrl}   mode: ${site.domain ? `HTTPS (${site.domain})` : "HTTP on IP"}`,
          `Version: ${gitLines[0] ?? "?"}   branch: ${gitLines[1] ?? "?"}`,
          `Watchdog timer: ${wd.stdout.trim() || "not installed"}`,
          ``,
          `## Containers\n${ps}`,
          ``,
          `## Docker disk\n${df.stdout.trim()}`,
        ].join("\n");
      });
    },
  },

  {
    name: "adpix_restart",
    title: "Restart AdPix service(s)",
    description:
      "Restart one AdPix service (ingest, api, worker, identity-job, web, caddy, postgres, clickhouse) " +
      "or the whole stack, then re-check front-door health.",
    schema: {
      server: serverParam,
      service: z.enum(SERVICES).optional().describe("Omit to restart the whole stack"),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; service?: (typeof SERVICES)[number] };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const ni = await requireStack(s, dir, srv.name, { needRunning: true });
        if (ni) return ni;
        const target = a.service ?? "";
        const r = await s.exec(`${composeCmd(dir)} restart ${target} 2>&1`, { timeoutMs: 300_000 });
        const gate = await s.exec(waitHealthyCmd(90), { timeoutMs: 120_000 });
        return [
          `Restarted ${target || "all services"} on ${srv.name} (exit ${r.code}).`,
          r.stdout.trim() ? lastLines(r.stdout, 20) : "",
          `Health: ${gate.stdout.trim()}`,
        ].filter(Boolean).join("\n");
      });
    },
  },

  {
    name: "adpix_logs",
    title: "AdPix logs",
    description: "Tail logs from the stack or one service, optionally filtered by a pattern or time window.",
    schema: {
      server: serverParam,
      service: z.enum(SERVICES).optional().describe("Omit for all services"),
      lines: z.number().int().min(10).max(2000).default(100),
      since: z.string().optional().describe('Time window like "30m", "2h", "2026-06-09T10:00:00"'),
      grep: z.string().optional().describe("Only lines matching this pattern (case-insensitive)"),
    },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; service?: string; lines: number; since?: string; grep?: string };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const ni = await requireStack(s, dir, srv.name, { needRunning: true });
        if (ni) return ni;
        let cmd = `${composeCmd(dir)} logs --no-color --tail=${a.lines}`;
        if (a.since) cmd += ` --since=${shq(a.since)}`;
        if (a.service) cmd += ` ${a.service}`;
        if (a.grep) cmd += ` 2>&1 | grep -i ${shq(a.grep)} | tail -n ${a.lines}`;
        else cmd += " 2>&1";
        const r = await s.exec(cmd, { timeoutMs: 120_000 });
        const body = redactSecrets(lastLines(r.stdout || r.stderr, a.lines));
        return `Logs from ${a.service ?? "all services"} on ${srv.name}:\n${body || "(empty)"}`;
      });
    },
  },

  {
    name: "adpix_backup",
    title: "Backup AdPix",
    description:
      "Run AdPix's backup script: pg_dump of Postgres + ClickHouse Native exports of the durable " +
      "tables, with a MANIFEST, under backups/<timestamp> on the server (script keeps the 14 newest; " +
      "off-host sync/encryption via BACKUP_SYNC_DEST / BACKUP_AGE_RECIPIENT in .env).",
    schema: { server: serverParam },
    handler: async (deps, args) => {
      const a = args as { server?: string };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        // backup.sh pg_dumps the live postgres/clickhouse CONTAINERS — they must be running.
        const ni = await requireStack(s, dir, srv.name, { needRunning: true });
        if (ni) return ni;
        const r = await s.exec(`cd ${shq(dir)} && ./scripts/backup.sh 2>&1`, { timeoutMs: 900_000 });
        if (r.code !== 0) {
          return `Backup FAILED (exit ${r.code}):\n${lastLines(r.stdout + r.stderr, 30)}`;
        }
        const size = await s.exec(
          `cd ${shq(dir)} && d=$(ls -1dt backups/*/ | head -1) && du -sh "$d" && ls -lh "$d"`
        );
        return `Backup complete on ${srv.name}:\n${lastLines(r.stdout, 15)}\n\n${size.stdout.trim()}`;
      });
    },
  },

  {
    name: "adpix_restore",
    title: "Restore AdPix from backup",
    description:
      "Restore Postgres + ClickHouse from a backup directory created by adpix_backup. " +
      "DESTRUCTIVE: overwrites current data — requires confirm:true.",
    schema: {
      server: serverParam,
      backupDir: z.string().describe('Backup dir relative to the AdPix checkout, e.g. "backups/20260609-031500"'),
      confirm: z.boolean().default(false).describe("Must be true — this overwrites the live databases"),
    },
    annotations: { destructiveHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; backupDir: string; confirm: boolean };
      if (!a.confirm) {
        return "REFUSED: restore overwrites the live databases. Re-run with confirm:true after double-checking backupDir.";
      }
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const ni = await requireStack(s, dir, srv.name, { needRunning: true });
        if (ni) return ni;
        const exists = await s.exec(`test -d ${shq(dir)}/${shq(a.backupDir)} && echo yes || echo no`);
        if (exists.stdout.trim() !== "yes") {
          const avail = await s.exec(`ls -1dt ${shq(dir)}/backups/*/ 2>/dev/null | head -10`);
          return `Backup dir "${a.backupDir}" not found. Available:\n${avail.stdout.trim() || "(none)"}`;
        }
        const r = await s.exec(`cd ${shq(dir)} && ./scripts/restore.sh ${shq(a.backupDir)} 2>&1`, {
          timeoutMs: 1800_000,
        });
        const gate = await s.exec(waitHealthyCmd(120), { timeoutMs: 150_000 });
        return [
          `Restore from ${a.backupDir} ${r.code === 0 ? "completed" : `FAILED (exit ${r.code})`} on ${srv.name}:`,
          lastLines(r.stdout + r.stderr, 40),
          `Health: ${gate.stdout.trim()}`,
        ].join("\n");
      });
    },
  },
];
