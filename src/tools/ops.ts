import { z } from "zod";
import { withSession } from "../deps.js";
import { composeCmd, requireStack, waitHealthyCmd, uploadFile } from "../adpix.js";
import { shq, lastLines } from "../util.js";
import type { ToolDef } from "./types.js";

const serverParam = z.string().optional().describe("Target server name. Omit to use the default.");

/**
 * Phase-3 operations tools for the control panel: per-container start/stop (the gap beyond
 * adpix_restart), a Prometheus PromQL read-through for dashboards, a recurring-job scheduler
 * (systemd timers), and advisory plans for vertical resize + data移动 (provider-specific, so
 * advisory by design). All honor the destructive-tool safety convention: verify-before-destroy,
 * preflight, warn on interruption.
 */
export const opsTools: ToolDef[] = [
  {
    name: "container_control",
    title: "Start / stop / restart a container",
    description:
      "Control one compose service on a server: start, stop (downtime!), restart, or status. " +
      "stop/restart interrupt live traffic for that service — confirm:true required. status is a quick read.",
    schema: {
      server: serverParam,
      service: z.string().describe("Compose service (ingest, api, web, worker, postgres, clickhouse, caddy, redis, …)"),
      action: z.enum(["start", "stop", "restart", "status"]).describe("status is read-only; stop/restart cause downtime"),
      confirm: z.boolean().default(false).describe("Required for stop/restart"),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; service: string; action: string; confirm: boolean };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const svc = shq(a.service);
        // refuse destructive sub-actions without confirm BEFORE touching the server (verify-before-destroy)
        if ((a.action === "stop" || a.action === "restart") && !a.confirm) {
          return `REFUSED: ${a.action} ${a.service} on ${srv.name} interrupts live traffic for that container. Re-run with confirm:true.`;
        }
        // `start` only needs the stack cloned/created (it brings stopped containers up); status/stop/
        // restart act on live containers, so require the stack running for a clear message.
        const ni = await requireStack(s, dir, srv.name, { needRunning: a.action !== "start" });
        if (ni) return ni;
        if (a.action === "status") {
          const r = await s.exec(`${composeCmd(dir)} ps ${svc} 2>&1`, { timeoutMs: 60_000 });
          return `Status of ${a.service} on ${srv.name}:\n${r.stdout.trim() || "(no such service / not running)"}`;
        }
        const r = await s.exec(`${composeCmd(dir)} ${a.action} ${svc} 2>&1`, { timeoutMs: 300_000 });
        const lines = [`${a.action} ${a.service} on ${srv.name} (exit ${r.code}).`, lastLines(r.stdout, 15)];
        if (a.action !== "stop") {
          const gate = await s.exec(waitHealthyCmd(90), { timeoutMs: 120_000 });
          lines.push(`Health: ${gate.stdout.trim()}`);
        } else {
          lines.push(`⚠ ${a.service} is now STOPPED — start it again with action:start when ready.`);
        }
        return lines.filter(Boolean).join("\n");
      });
    },
  },

  {
    name: "metrics_query",
    title: "Query Prometheus (PromQL)",
    description:
      "Read-through to the Prometheus instance on the observability host (obs_deploy). Runs an instant " +
      "PromQL query and returns the JSON result — powers the panel's metric cards/charts. Read-only.",
    schema: {
      server: serverParam.describe("The observability host (where Prometheus runs; usually the witness)"),
      query: z.string().describe("PromQL, e.g. up, rate(http_requests_total[5m]), node_load1"),
      port: z.number().int().default(9090).describe("Prometheus port"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; query: string; port: number };
      return withSession(deps, a.server, async (s, srv) => {
        const url = `http://127.0.0.1:${a.port}/api/v1/query?query=`;
        const r = await s.exec(`curl -fsS --max-time 8 ${shq(url)}"$(printf %s ${shq(a.query)} | jq -sRr @uri)" 2>&1 || curl -fsS --max-time 8 -G ${shq(url.replace(/\?query=$/, "/api/v1/query"))} --data-urlencode ${shq("query=" + a.query)} 2>&1`, { timeoutMs: 20_000 });
        if (r.code !== 0) return `Query failed on ${srv.name} (is Prometheus up on :${a.port}? run obs_status):\n${lastLines(r.stdout, 10)}`;
        return `PromQL "${a.query}" on ${srv.name}:\n${lastLines(r.stdout, 40)}`;
      });
    },
  },

  {
    name: "schedule_job",
    title: "Schedule a recurring job (systemd timer)",
    description:
      "Manage recurring maintenance via systemd timers on a server: list, add, or remove. Whitelisted " +
      "tasks only (backup, patch-check) — never arbitrary commands. Survives panel restarts. add/remove " +
      "create/disable system units — confirm:true required.",
    schema: {
      server: serverParam,
      action: z.enum(["list", "add", "remove"]).describe("list is read-only"),
      name: z.string().optional().describe("Timer name (for add/remove), e.g. nightly-backup"),
      task: z.enum(["backup", "patch-check"]).optional().describe("Whitelisted task to run (add)"),
      schedule: z.string().default("daily").describe("systemd OnCalendar, e.g. daily, *-*-* 03:00:00, Mon *-*-* 02:00"),
      confirm: z.boolean().default(false).describe("Required for add/remove"),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; action: string; name?: string; task?: string; schedule: string; confirm: boolean };
      return withSession(deps, a.server, async (s, srv) => {
        if (a.action === "list") {
          const r = await s.exec(`systemctl list-timers 'adpix-*' --all --no-pager 2>&1 || true`, { timeoutMs: 60_000 });
          return `AdPix scheduled jobs on ${srv.name}:\n${r.stdout.trim() || "(none)"}`;
        }
        if (!a.confirm) return `REFUSED: schedule_job ${a.action} creates/removes systemd units on ${srv.name}. Re-run with confirm:true.`;
        if (!a.name) return "name is required for add/remove.";
        const unit = `adpix-${a.name.replace(/[^a-z0-9-]/gi, "-")}`;
        if (a.action === "remove") {
          const r = await s.exec(`systemctl disable --now ${shq(unit + ".timer")} 2>&1; rm -f /etc/systemd/system/${unit}.timer /etc/systemd/system/${unit}.service; systemctl daemon-reload; echo removed`, { timeoutMs: 60_000 });
          return `Removed scheduled job ${unit} on ${srv.name}.\n${lastLines(r.stdout, 6)}`;
        }
        // add
        if (!a.task) return "task is required for add (backup | patch-check).";
        const dir = srv.adpixDir;
        const cmd = a.task === "backup"
          ? `mkdir -p /var/backups/adpix && cd ${shq(dir)} && ${composeCmd(dir)} exec -T postgres pg_dumpall -U postgres > /var/backups/adpix/pg-$(date +%F-%H%M).sql`
          : `apt-get update -qq && apt-get -s upgrade 2>/dev/null | grep -c '^Inst' > /var/log/adpix-patch-check.log`;
        const service = `[Unit]\nDescription=AdPix scheduled ${a.task} (${a.name})\n\n[Service]\nType=oneshot\nExecStart=/bin/bash -lc ${JSON.stringify(cmd)}\n`;
        const timer = `[Unit]\nDescription=Timer for AdPix ${a.name}\n\n[Timer]\nOnCalendar=${a.schedule}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`;
        await uploadFile(s, `/etc/systemd/system/${unit}.service`, service, "644");
        await uploadFile(s, `/etc/systemd/system/${unit}.timer`, timer, "644");
        const r = await s.exec(`systemctl daemon-reload && systemctl enable --now ${shq(unit + ".timer")} 2>&1 && systemctl list-timers ${shq(unit + ".timer")} --no-pager`, { timeoutMs: 60_000 });
        return `Scheduled ${a.task} as ${unit} (${a.schedule}) on ${srv.name}.\n${lastLines(r.stdout, 8)}`;
      });
    },
  },

  {
    name: "server_resize",
    title: "Plan a vertical resize (advisory)",
    description:
      "Inspect a server's current CPU/RAM/disk and produce a safe vertical-resize PLAN. Resizing a VM is " +
      "provider-specific (done at the cloud console / API), so this advises the safe sequence rather than " +
      "doing it — drain, snapshot, resize, verify. Read-only.",
    schema: {
      server: serverParam,
      cpu: z.number().int().optional().describe("Target vCPU (for the plan)"),
      memoryGb: z.number().optional().describe("Target RAM in GB"),
      diskGb: z.number().optional().describe("Target disk in GB"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; cpu?: number; memoryGb?: number; diskGb?: number };
      return withSession(deps, a.server, async (s, srv) => {
        const cur = await s.exec(`echo "cpu=$(nproc)"; echo "mem=$(free -g | awk '/Mem:/{print $2}')GB"; echo "disk=$(df -BG --output=size / | tail -1 | tr -d 'G ')GB used=$(df -BG --output=used / | tail -1 | tr -d 'G ')GB"`, { timeoutMs: 30_000 });
        return [
          `# Vertical resize plan — ${srv.name}`,
          `Current: ${cur.stdout.trim().replace(/\n/g, " · ")}`,
          `Target:  ${[a.cpu && `cpu=${a.cpu}`, a.memoryGb && `mem=${a.memoryGb}GB`, a.diskGb && `disk=${a.diskGb}GB`].filter(Boolean).join(" · ") || "(specify cpu/memoryGb/diskGb)"}`,
          ``,
          `Safe sequence (resize itself is done at your cloud provider):`,
          `1. ha_quorum/cluster_status — confirm the peer can carry traffic (HA) before touching this node.`,
          `2. bluegreen_deploy or drain — shift traffic off ${srv.name} (VIP moves to the peer).`,
          `3. adpix_backup + pg_backup + ch_backup — snapshot first (data safety).`,
          `4. Resize the VM at the provider (power-off resize for CPU/RAM; grow the disk online if supported).`,
          `5. For disk: grow the partition + filesystem (growpart + resize2fs/xfs_growfs).`,
          `6. adpix_status + health_check — verify, then return traffic.`,
          a.diskGb ? `\nDisk grow (after the provider enlarges the volume): growpart /dev/sda 1 && resize2fs /dev/sda1 (adjust device).` : ``,
        ].filter(Boolean).join("\n");
      });
    },
  },

  {
    name: "data_move",
    title: "Plan a data/volume migration (advisory)",
    description:
      "Produce a safe plan to move a dataset/volume between servers (e.g. relocating ClickHouse or Postgres " +
      "data). Inspects volume sizes and outlines a backup-first, verify-after migration. Advisory — it does " +
      "not move data itself, because a wrong move loses production data. Read-only.",
    schema: {
      server: serverParam.describe("Source server"),
      to: z.string().optional().describe("Destination server name"),
      dataset: z.enum(["postgres", "clickhouse", "all"]).default("all").describe("What to move"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; to?: string; dataset: string };
      return withSession(deps, a.server, async (s, srv) => {
        const vols = await s.exec(`docker system df -v 2>/dev/null | grep -iE 'postgres|clickhouse|VOLUME' | head -20 || du -sh /var/lib/docker/volumes/* 2>/dev/null | tail -10`, { timeoutMs: 60_000 });
        return [
          `# Data migration plan — ${a.dataset} from ${srv.name}${a.to ? ` → ${a.to}` : ""}`,
          `Volumes on ${srv.name}:`,
          lastLines(vols.stdout, 14) || "(could not size volumes)",
          ``,
          `Safe sequence (NOTHING is moved by this tool):`,
          `1. Provision/verify the destination (server_add ${a.to ?? "<dest>"}; ensure free disk ≥ source volume + 20%).`,
          `2. ${a.dataset === "clickhouse" || a.dataset === "all" ? "ch_backup" : "pg_backup"} on the source — a verified, consistent snapshot FIRST.`,
          `3. For Postgres: pg_backup → copy the dump → pg_restore_db on the destination (logical, safest).`,
          `4. For ClickHouse: ch_backup → copy → ch_restore_db; remember CH_REPLICATED is fresh-deploy-only.`,
          `5. Stop writes during the final delta (identity-job is a singleton — keep it single).`,
          `6. Verify row counts / pg_health / ch_health on the destination BEFORE cutover, then repoint and keep the source until verified.`,
          `\nWhy advisory: an in-place rsync of a live DB volume corrupts data. Always go through a verified backup→restore.`,
        ].filter(Boolean).join("\n");
      });
    },
  },
];
