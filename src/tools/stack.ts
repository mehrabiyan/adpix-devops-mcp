import { z } from "zod";
import { withSession } from "../deps.js";
import type { Session } from "../ssh.js";
import { ADPIX_REPO_URL, composeCmd, waitHealthyCmd } from "../adpix.js";
import { tmCompose, tmHealthGate } from "./tagmanager.js";
import { shq, lastLines } from "../util.js";
import type { ToolDef } from "./types.js";

const TM_REPO_URL = "https://github.com/mehrabiyan/AdpixTagManager.git";

interface Args {
  server?: string; stack: "analytics" | "tagmanager" | "idp"; dir?: string; branch?: string;
  statelessOnly: boolean; rollbackOnFailure: boolean; force: boolean; confirm: boolean; timeoutSeconds: number;
  composeFile?: string; project?: string; service?: string; migrateCmd?: string; backupFirst: boolean;
}

/**
 * stack_update — pull a product stack from GitHub and update it SAFELY: build, run migrations,
 * and recreate ONLY the stateless services (`up -d --no-deps <stateless>`). The stateful
 * containers + their named volumes (postgres / clickhouse / redis / minio) are never recreated
 * or deleted; never runs `down -v`. Health-gated with auto-rollback of the CODE (migrations are
 * expand-only and stay).
 *
 * analytics + tagmanager are wired to their real composes. `idp` (apps/auth) ships with NO
 * compose in the repo (the account center deploys separately), so it is fully configurable —
 * the operator supplies composeFile / project / service (and optionally migrateCmd).
 */
interface StackCfg {
  repoUrl: string;
  defaultDir?: string;
  compose: (dir: string, a: Args) => string;
  stateless: (a: Args) => string[];
  stateful: string[];
  migrate?: (a: Args) => string | undefined; // compose subcommand, e.g. "run --rm migrate"
  backup?: string; // shell run from the checkout dir, before migrating, when backupFirst:true
  health: (t: number, a: Args, compose: string) => string;
}
const STACKS: Record<string, StackCfg> = {
  analytics: {
    repoUrl: ADPIX_REPO_URL,
    compose: (dir) => composeCmd(dir),
    stateless: () => ["ingest", "api", "worker", "identity-job", "mmm-job", "integrity-job", "lift-job", "web", "caddy"],
    stateful: ["postgres", "clickhouse", "redis"],
    migrate: () => "run --rm migrate",
    backup: "bash scripts/backup.sh",
    health: (t) => waitHealthyCmd(t),
  },
  tagmanager: {
    repoUrl: TM_REPO_URL,
    defaultDir: "/opt/adpix-tagmanager",
    compose: (dir) => tmCompose(dir),
    stateless: () => ["api", "edge", "varnish", "purge-bridge"],
    stateful: ["redis", "minio"],
    health: (t) => tmHealthGate(t),
  },
  idp: {
    repoUrl: TM_REPO_URL,
    defaultDir: "/opt/adpix-auth",
    // No compose ships in the repo for apps/auth — operator supplies the file/project/service.
    compose: (dir, a) => `cd ${shq(dir)} && docker compose -p ${shq(a.project || "adpix-auth")} -f ${shq(a.composeFile || "deploy/docker-compose.yml")}`,
    stateless: (a) => [a.service || "auth"],
    stateful: [], // the account center's DB is the external control Postgres — not in this compose
    migrate: (a) => a.migrateCmd, // usually none — control-DB migrations run by the operator/api
    health: (_t, a, compose) => `${compose} ps ${shq(a.service || "auth")} 2>/dev/null | grep -qiE 'up|running|healthy' && echo ok || { echo 'auth service not running'; exit 1; }`,
  },
};

/** Public meta (repo + default checkout dir) per stack — shared with the panel's /api/stacks aggregator. */
export const STACK_META: Record<string, { repoUrl: string; defaultDir?: string }> =
  Object.fromEntries(Object.entries(STACKS).map(([k, v]) => [k, { repoUrl: v.repoUrl, defaultDir: v.defaultDir }]));

export function stackDir(srv: { adpixDir?: string }, stack: string, dir?: string): string {
  return dir || STACKS[stack].defaultDir || srv.adpixDir || "/opt/adpix";
}

export interface StackProbe { installed: boolean; commit: string; branch: string; behind: string; subject: string; dir: string }
/** One read-only exec: is the checkout a git repo, its HEAD, branch, commits-behind origin, and last subject. */
export async function probeStack(s: Session, dir: string): Promise<StackProbe> {
  const r = await s.exec(
    `cd ${shq(dir)} 2>/dev/null && test -d .git && { git fetch -q origin 2>/dev/null; b=$(git rev-parse --abbrev-ref HEAD); printf '%s\\t%s\\t%s\\t%s' "$(git rev-parse --short HEAD)" "$b" "$(git rev-list --count HEAD..origin/$b 2>/dev/null || echo '?')" "$(git log -1 --format=%s)"; } || printf 'NOGIT'`,
    { timeoutMs: 40_000 }
  );
  const out = r.stdout.trim();
  if (!out || out === "NOGIT") return { installed: false, commit: "", branch: "", behind: "?", subject: "", dir };
  const [commit = "", branch = "", behind = "?", subject = ""] = out.split("\t");
  return { installed: true, commit, branch, behind, subject, dir };
}

export const stackTools: ToolDef[] = [
  {
    name: "stack_update",
    title: "Update a product stack (stateless-only)",
    description:
      "Pull a product stack (analytics | tagmanager | idp) from GitHub and update it safely: build → run " +
      "migrations → recreate ONLY the stateless services (up -d --no-deps), so the stateful containers + named " +
      "volumes (postgres/clickhouse/redis/minio) are never recreated or deleted. Health-gated with automatic " +
      "CODE rollback (migrations are expand-only and stay). statelessOnly:false recreates everything (still never " +
      "`down -v`). confirm:true required. idp ships no compose in the repo — pass composeFile/project/service " +
      "(and optionally migrateCmd) for the account center.",
    schema: {
      server: z.string().optional().describe("Target server (a serving node). Omit for the default."),
      stack: z.enum(["analytics", "tagmanager", "idp"]),
      dir: z.string().optional().describe("Checkout dir on the server (defaults per stack)"),
      branch: z.string().optional().describe("Branch to deploy (default: the checked-out branch)"),
      statelessOnly: z.boolean().default(true).describe("Recreate only stateless services; never touch the datastores"),
      rollbackOnFailure: z.boolean().default(true),
      force: z.boolean().default(false).describe("Rebuild even if already on the newest commit"),
      confirm: z.boolean().default(false),
      timeoutSeconds: z.number().int().min(60).max(7200).default(1800),
      composeFile: z.string().optional().describe("idp: compose file relative to the checkout (e.g. deploy/auth.yml)"),
      project: z.string().optional().describe("idp: docker compose -p project name"),
      service: z.string().optional().describe("idp: the auth compose service to recreate (default: auth)"),
      migrateCmd: z.string().optional().describe("idp: optional compose subcommand to run migrations (e.g. run --rm migrate)"),
      backupFirst: z.boolean().default(false).describe("analytics: run a pg_dump + ClickHouse-native backup before migrating"),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as unknown as Args;
      const cfg = STACKS[a.stack];
      return withSession(deps, a.server, async (s, srv) => {
        if (!a.confirm) return `REFUSED: stack_update ${a.stack} rebuilds + recreates ${a.statelessOnly ? "the stateless" : "all"} containers and runs migrations. Re-run with confirm:true.`;
        const dir = stackDir(srv, a.stack, a.dir);
        const compose = cfg.compose(dir, a);
        const big = a.timeoutSeconds * 1000;
        const at = (cmd: string, ms = big) => s.exec(`cd ${shq(dir)} && ${cmd}`, { timeoutMs: ms });
        const git = (cmd: string, ms = 120_000) => at(`git ${cmd}`, ms);

        if ((await s.exec(`test -d ${shq(dir + "/.git")} && echo yes || echo no`)).stdout.trim() !== "yes")
          return `No ${a.stack} checkout at ${dir} — install it first, or pass dir:.`;
        const branch = a.branch || (await git("rev-parse --abbrev-ref HEAD")).stdout.trim() || "main";
        const before = (await git("rev-parse --short HEAD")).stdout.trim();
        const pull = await git(`fetch origin ${shq(branch)} 2>&1 && git checkout ${shq(branch)} 2>&1 && git pull --ff-only origin ${shq(branch)} 2>&1`);
        if (pull.code !== 0) return `git pull failed:\n${lastLines(pull.stdout, 15)}`;
        const after = (await git("rev-parse --short HEAD")).stdout.trim();
        if (before === after && !a.force) return `${a.stack} already up to date (${before}). Pass force:true to rebuild anyway.`;

        const stateless = cfg.stateless(a);
        const svc = a.statelessOnly ? stateless.join(" ") : "";
        const build = await s.exec(`${compose} build ${svc} 2>&1`, { timeoutMs: big });
        if (build.code !== 0) return `Updated ${before} → ${after} but BUILD FAILED — still running the old containers:\n${lastLines(build.stdout, 20)}`;

        let backupNote = "";
        if (a.backupFirst && cfg.backup) {
          const bk = await at(cfg.backup, big);
          if (bk.code !== 0) {
            if (a.rollbackOnFailure) await git(`checkout ${shq(before)} 2>&1`);
            return `Pre-update BACKUP FAILED — aborted before migrating (rolled the checkout back to ${before}, nothing changed):\n${lastLines(bk.stdout, 15)}`;
          }
          backupNote = "backup taken; ";
        }

        let migrateNote = "";
        const migrate = cfg.migrate?.(a);
        if (migrate) {
          const mig = await s.exec(`${compose} ${migrate} 2>&1`, { timeoutMs: big });
          if (mig.code !== 0) {
            if (a.rollbackOnFailure) await git(`checkout ${shq(before)} 2>&1`);
            return `Migrations FAILED on ${a.stack} — rolled the checkout back to ${before}, containers untouched (no data changed):\n${lastLines(mig.stdout, 20)}`;
          }
          migrateNote = "migrations applied; ";
        }

        const up = await s.exec(`${compose} up -d ${a.statelessOnly ? "--no-deps" : ""} ${svc} 2>&1`, { timeoutMs: big });
        if (up.code !== 0) return `Updated + migrated but 'compose up' failed:\n${lastLines(up.stdout, 20)}`;

        const gate = await rollupHealth(s, cfg.health(120, a, compose));
        if (!gate.ok && a.rollbackOnFailure) {
          await s.exec(`cd ${shq(dir)} && git checkout ${shq(before)} 2>&1 && ${compose} build ${svc} 2>&1 && ${compose} up -d ${a.statelessOnly ? "--no-deps" : ""} ${svc} 2>&1`, { timeoutMs: big });
          const g2 = await rollupHealth(s, cfg.health(120, a, compose));
          return `Updated ${before} → ${after} but the HEALTH GATE FAILED → ROLLED BACK the code to ${before} (stateful + migrations untouched).\nAfter rollback: ${g2.ok ? "healthy" : "STILL UNHEALTHY — investigate"}.\nFailed deploy output:\n${lastLines(gate.detail, 8)}`;
        }
        const preserved = cfg.stateful.length ? `${cfg.stateful.join(", ")} + their named volumes` : "none in this compose (the account center's control DB is external)";
        return [
          `# ${a.stack} updated ${before} → ${after} (${branch})`,
          `${backupNote}${migrateNote}recreated ${a.statelessOnly ? `${stateless.length} stateless service(s) (${stateless.join(", ")})` : "all services"}.`,
          `Stateful preserved (never recreated or deleted): ${preserved}.`,
          gate.ok ? "Front door healthy." : "⚠ health gate did not confirm — check the stack.",
        ].join("\n");
      });
    },
  },
  {
    name: "stack_status",
    title: "Product stack update status",
    description:
      "Read-only: for each product stack (analytics | tagmanager | idp) — whether it's installed, its current " +
      "commit + subject, branch, and how many commits it is behind its GitHub origin. Omit `stack` to report all " +
      "three. Powers the panel's per-stack update buttons (the read-only counterpart to stack_update).",
    schema: {
      server: z.string().optional().describe("Target server. Omit for the default."),
      stack: z.enum(["analytics", "tagmanager", "idp"]).optional().describe("One stack; omit for all three"),
      dir: z.string().optional().describe("Override the checkout dir (only meaningful with a single stack)"),
    },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; stack?: "analytics" | "tagmanager" | "idp"; dir?: string };
      const stacks = a.stack ? [a.stack] : ["analytics", "tagmanager", "idp"];
      return withSession(deps, a.server, async (s, srv) => {
        const rows: string[] = [];
        for (const st of stacks) {
          const p = await probeStack(s, stackDir(srv, st, a.stack ? a.dir : undefined));
          rows.push(p.installed
            ? `${st}: ${p.commit} (${p.branch}) — ${p.behind === "0" ? "up to date" : `${p.behind} behind origin`}  ·  ${p.subject}`
            : `${st}: not installed at ${p.dir}`);
        }
        return rows.join("\n");
      });
    },
  },
];

async function rollupHealth(s: Session, cmd: string): Promise<{ ok: boolean; detail: string }> {
  const r = await s.exec(cmd, { timeoutMs: 180_000 });
  return { ok: r.code === 0, detail: r.stdout };
}
