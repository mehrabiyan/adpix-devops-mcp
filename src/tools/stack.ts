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
  composeFile?: string; project?: string; service?: string; migrateCmd?: string;
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
  health: (t: number, a: Args, compose: string) => string;
}
const STACKS: Record<string, StackCfg> = {
  analytics: {
    repoUrl: ADPIX_REPO_URL,
    compose: (dir) => composeCmd(dir),
    stateless: () => ["ingest", "api", "worker", "identity-job", "mmm-job", "integrity-job", "lift-job", "web", "caddy"],
    stateful: ["postgres", "clickhouse", "redis"],
    migrate: () => "run --rm migrate",
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
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as unknown as Args;
      const cfg = STACKS[a.stack];
      return withSession(deps, a.server, async (s, srv) => {
        if (!a.confirm) return `REFUSED: stack_update ${a.stack} rebuilds + recreates ${a.statelessOnly ? "the stateless" : "all"} containers and runs migrations. Re-run with confirm:true.`;
        const dir = a.dir || cfg.defaultDir || srv.adpixDir;
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
          `${migrateNote}recreated ${a.statelessOnly ? `${stateless.length} stateless service(s) (${stateless.join(", ")})` : "all services"}.`,
          `Stateful preserved (never recreated or deleted): ${preserved}.`,
          gate.ok ? "Front door healthy." : "⚠ health gate did not confirm — check the stack.",
        ].join("\n");
      });
    },
  },
];

async function rollupHealth(s: Session, cmd: string): Promise<{ ok: boolean; detail: string }> {
  const r = await s.exec(cmd, { timeoutMs: 180_000 });
  return { ok: r.code === 0, detail: r.stdout };
}
