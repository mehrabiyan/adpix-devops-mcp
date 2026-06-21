import { z } from "zod";
import { withSession } from "../deps.js";
import type { Session } from "../ssh.js";
import { uploadFile } from "../adpix.js";
import { shq, redactSecrets, lastLines, parseComposePs, table } from "../util.js";
import type { ToolDef } from "./types.js";

const serverParam = z.string().optional().describe("Registered server name. Omit to use the default server.");
const dirParam = z.string().default("/opt/adpix-tagmanager").describe("Tag Manager checkout dir on the server");

const TM_REPO_URL = "https://github.com/mehrabiyan/AdpixTagManager.git";
const TM_PROJECT = "adpix-tm";

/** The Tag Manager delivery core (deploy/docker-compose.yml). api+edge+varnish are the serving services. */
const TM_SERVICES = ["redis", "minio", "api", "edge", "varnish", "purge-bridge"] as const;

/** compose secrets the deploy/docker-compose.yml requires (`:?` — compose fails fast without them). */
const TM_REQUIRED = ["DATABASE_URL", "AUTH_ISSUER", "S3_ACCESS_KEY", "S3_SECRET_KEY", "PURGE_TOKEN"] as const;

/** Production compose invocation for the TM delivery core, run from the checkout dir. */
export function tmCompose(dir: string): string {
  return `cd ${shq(dir)} && docker compose -p ${TM_PROJECT} -f deploy/docker-compose.yml --env-file deploy/.env`;
}

/** Single remote loop that waits for both the api (8686) and edge (8585) /healthz to answer 200. */
export function tmHealthGate(timeoutSec = 150): string {
  const tries = Math.max(1, Math.floor(timeoutSec / 5));
  return (
    `a=000; e=000; for i in $(seq 1 ${tries}); do ` +
    `a=$(curl -fsS -o /dev/null -m 5 -w '%{http_code}' http://localhost:8686/healthz 2>/dev/null || echo 000); ` +
    `e=$(curl -fsS -o /dev/null -m 5 -w '%{http_code}' http://localhost:8585/healthz 2>/dev/null || echo 000); ` +
    `if [ "$a" = 200 ] && [ "$e" = 200 ]; then echo "healthy after ~$((i*5))s (api+edge 200)"; exit 0; fi; sleep 5; done; ` +
    `echo "NOT healthy after ${timeoutSec}s (api=$a edge=$e)"; exit 1`
  );
}

async function tmInstalled(s: Session, dir: string): Promise<boolean> {
  return (await s.exec(`test -d ${shq(dir + "/.git")} && echo yes || echo no`)).stdout.trim() === "yes";
}

async function tmPsTable(s: Session, dir: string): Promise<string> {
  const r = await s.exec(`${tmCompose(dir)} ps -a --format json`, { timeoutMs: 60_000 });
  const rows = parseComposePs(r.stdout).filter((c) => !/minio-init/.test(c.Name || c.Service || ""));
  if (!rows.length) return "(no containers — is the stack up?)";
  return table(["SERVICE", "STATE", "HEALTH", "STATUS"], rows.map((c) => [c.Service || c.Name, c.State, c.Health || "-", c.Status]));
}

export const tagmanagerTools: ToolDef[] = [
  {
    name: "tm_install",
    title: "Install Tag Manager (delivery core)",
    description:
      "Install the AdPix Tag Manager delivery core (deploy/docker-compose.yml: redis + minio + api:8686 + " +
      "edge:8585 + varnish + purge-bridge) on a host — this is also the per-PoP unit. Clones the repo, writes the " +
      "required secrets to deploy/.env (DATABASE_URL, AUTH_ISSUER, S3_ACCESS_KEY/SECRET_KEY, PURGE_TOKEN — never " +
      "echoed), builds the images, brings the stack up, and health-gates api+edge /healthz. apps/auth (the IdP) and " +
      "console/sgtm deploy separately; this is the delivery/publish plane.",
    schema: {
      server: serverParam,
      dir: dirParam,
      repoUrl: z.string().default(TM_REPO_URL),
      branch: z.string().default("main"),
      databaseUrl: z.string().optional().describe("Postgres URL for the authoring/control DB (required on first install)"),
      authIssuer: z.string().optional().describe("OIDC issuer, e.g. https://account.adpix.io (required on first install)"),
      s3AccessKey: z.string().optional().describe("Object-store access key (required on first install)"),
      s3SecretKey: z.string().optional().describe("Object-store secret key (required on first install)"),
      purgeToken: z.string().optional().describe("PURGE token shared with varnish.vcl (required on first install)"),
      s3Bucket: z.string().default("adpix-tags"),
      timeoutSeconds: z.number().int().min(60).max(7200).default(1800),
    },
    annotations: { idempotentHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as {
        server?: string; dir: string; repoUrl: string; branch: string;
        databaseUrl?: string; authIssuer?: string; s3AccessKey?: string; s3SecretKey?: string; purgeToken?: string;
        s3Bucket: string; timeoutSeconds: number;
      };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = a.dir;
        const sections: string[] = [];

        // Docker present?
        const docker = await s.exec("command -v docker >/dev/null && docker compose version >/dev/null 2>&1 && echo ok || echo no");
        if (docker.stdout.trim() !== "ok") {
          return `Docker (with the compose plugin) isn't available on ${srv.name}. Install Docker first (adpix_install sets it up on an AdPix host), then re-run tm_install.`;
        }

        await s.exec("command -v git >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git ca-certificates)", { timeoutMs: 300_000 });

        const clone = await s.exec(
          `if [ -d ${shq(dir + "/.git")} ]; then cd ${shq(dir)} && git fetch origin ${shq(a.branch)} && git checkout ${shq(a.branch)} && git pull --ff-only origin ${shq(a.branch)}; ` +
            `else mkdir -p $(dirname ${shq(dir)}) && git clone -b ${shq(a.branch)} ${shq(a.repoUrl)} ${shq(dir)}; fi`,
          { timeoutMs: 300_000 }
        );
        if (clone.code !== 0) {
          const authish = /could not read Username|Authentication failed|terminal prompts disabled|repository not found|Permission denied/i.test(clone.stderr + clone.stdout);
          return `## Checkout FAILED (exit ${clone.code})\n${lastLines(clone.stderr || clone.stdout, 30)}` +
            (authish ? `\n\nAdpixTagManager looks private — get the code onto the host with a credential you have (a PAT clone), then re-run tm_install pointing dir at it.` : "");
        }
        sections.push(`## Checkout\n${a.repoUrl} @ ${a.branch} → ${dir}`);

        // Secrets: (re)write deploy/.env only when secret params are supplied; require all on first write.
        const envExists = (await s.exec(`test -f ${shq(dir + "/deploy/.env")} && echo yes || echo no`)).stdout.trim() === "yes";
        const provided = [a.databaseUrl, a.authIssuer, a.s3AccessKey, a.s3SecretKey, a.purgeToken];
        const anyProvided = provided.some((v) => v !== undefined);
        if (anyProvided) {
          const missing = TM_REQUIRED.filter((_k, i) => !provided[i]);
          if (missing.length) return `tm_install: when providing secrets, provide all required: missing ${missing.join(", ")}.`;
          const envBody =
            `DATABASE_URL=${a.databaseUrl}\n` +
            `AUTH_ISSUER=${a.authIssuer}\n` +
            `S3_ACCESS_KEY=${a.s3AccessKey}\n` +
            `S3_SECRET_KEY=${a.s3SecretKey}\n` +
            `PURGE_TOKEN=${a.purgeToken}\n` +
            `S3_BUCKET=${a.s3Bucket}\n`;
          await uploadFile(s, `${dir}/deploy/.env`, envBody, "600");
          sections.push(`## Secrets\nWrote deploy/.env (mode 600, ${TM_REQUIRED.length} required keys + S3_BUCKET) — values kept off this transcript.`);
        } else if (!envExists) {
          return sections.join("\n\n") + `\n\n## Secrets — action needed\ndeploy/.env is missing and no secrets were provided. Re-run tm_install with databaseUrl, authIssuer, s3AccessKey, s3SecretKey, purgeToken (all required). Nothing was deployed.`;
        } else {
          sections.push(`## Secrets\nReusing existing deploy/.env.`);
        }

        const build = await s.exec(`${tmCompose(dir)} build 2>&1`, { timeoutMs: a.timeoutSeconds * 1000 });
        if (build.code !== 0) return sections.join("\n\n") + `\n\n## build FAILED (exit ${build.code})\n${redactSecrets(lastLines(build.stdout, 40))}`;
        const up = await s.exec(`${tmCompose(dir)} up -d 2>&1`, { timeoutMs: 600_000 });
        sections.push(`## compose up (exit ${up.code})\n${redactSecrets(lastLines(up.stdout, 25))}`);
        if (up.code !== 0) return sections.join("\n\n") + `\n\nBring-up FAILED — see above (tm_logs to dig in).`;

        const gate = await s.exec(tmHealthGate(150), { timeoutMs: 180_000 });
        sections.push(`## Health gate\n${gate.stdout.trim()}`);
        sections.push(
          `## Done\nDelivery core up: api :8686 · edge :8585 · varnish :8080 (PoP cache). ` +
            `Front it with TLS (deploy/nginx.conf) for cdn.adpix.net and route /a/* + /c/* to it. ` +
            `apps/auth (IdP) is separate — check it with oidc_health.`
        );
        return sections.join("\n\n");
      });
    },
  },

  {
    name: "tm_status",
    title: "Tag Manager status",
    description: "Snapshot of the TM delivery core: container states/health, deployed git version, and Docker disk.",
    schema: { server: serverParam, dir: dirParam },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; dir: string };
      return withSession(deps, a.server, async (s, srv) => {
        if (!(await tmInstalled(s, a.dir))) return `No Tag Manager checkout at ${a.dir} on ${srv.name} — run tm_install.`;
        const git = await s.exec(`cd ${shq(a.dir)} && git log -1 --format='%h %s (%ci)' && git rev-parse --abbrev-ref HEAD`);
        const ps = await tmPsTable(s, a.dir);
        const gitLines = git.stdout.trim().split("\n");
        return [
          `# Tag Manager on ${srv.name} (${srv.host})  —  ${a.dir}`,
          `Version: ${gitLines[0] ?? "?"}   branch: ${gitLines[1] ?? "?"}`,
          ``,
          `## Containers\n${ps}`,
        ].join("\n");
      });
    },
  },

  {
    name: "tm_health",
    title: "Tag Manager health",
    description:
      "Health of the TM delivery core: container states + HTTP probes of api:8686/healthz, edge:8585/healthz and " +
      "the varnish PoP cache (:8080), with a HEALTHY/DEGRADED/DOWN verdict.",
    schema: { server: serverParam, dir: dirParam },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; dir: string };
      return withSession(deps, a.server, async (s, srv) => {
        if (!(await tmInstalled(s, a.dir))) return `No Tag Manager checkout at ${a.dir} on ${srv.name} — run tm_install.`;
        const problems: string[] = [];

        const ps = await s.exec(`${tmCompose(a.dir)} ps -a --format json`, { timeoutMs: 60_000 });
        const rows = parseComposePs(ps.stdout).filter((c) => !/minio-init/.test(c.Name || c.Service || ""));
        const containerRows = rows.map((c) => {
          const bad = c.State !== "running" || /unhealthy/i.test(c.Health ?? "");
          if (bad) problems.push(`${c.Service || c.Name}: ${c.State}${c.Health ? `/${c.Health}` : ""}`);
          return [c.Service || c.Name, c.State, c.Health || "-", bad ? "PROBLEM" : "ok"];
        });
        if (!rows.length) problems.push("no containers running");

        const probe = await s.exec(
          `for p in 8686:/healthz 8585:/healthz 8080:/; do ` +
            `port=\${p%%:*}; path=\${p#*:}; ` +
            `code=$(curl -fsS -o /dev/null -m 5 -w '%{http_code}' http://localhost:$port$path 2>/dev/null || echo 000); ` +
            `echo "$port $code"; done`,
          { timeoutMs: 60_000 }
        );
        const probeRows = probe.stdout.trim().split("\n").map((l) => {
          const [port = "?", code = "000"] = l.trim().split(/\s+/);
          const svc = port === "8686" ? "api" : port === "8585" ? "edge" : "varnish";
          const ok = /^[23]/.test(code);
          if (!ok) problems.push(`${svc} (:${port}) → HTTP ${code}`);
          return [svc, port, code, ok ? "ok" : "PROBLEM"];
        });

        const verdict = problems.length === 0 ? "HEALTHY" : rows.length === 0 || problems.length >= rows.length + 2 ? "DOWN" : "DEGRADED";
        return [
          `# Tag Manager health on ${srv.name} — ${verdict}`,
          problems.length ? `Problems:\n${problems.map((p) => `  - ${p}`).join("\n")}` : "No problems found.",
          ``,
          `## Containers\n${containerRows.length ? table(["SERVICE", "STATE", "HEALTH", ""], containerRows) : "(none)"}`,
          ``,
          `## Front door\n${table(["SERVICE", "PORT", "HTTP", ""], probeRows)}`,
        ].join("\n");
      });
    },
  },

  {
    name: "tm_logs",
    title: "Tag Manager logs",
    description: "Tail logs from the TM delivery core or one service (secrets redacted).",
    schema: {
      server: serverParam,
      dir: dirParam,
      service: z.enum(TM_SERVICES).optional().describe("Omit for all services"),
      lines: z.number().int().min(10).max(2000).default(100),
      since: z.string().optional().describe('Time window like "30m", "2h"'),
      grep: z.string().optional().describe("Only lines matching this pattern (case-insensitive)"),
    },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; dir: string; service?: string; lines: number; since?: string; grep?: string };
      return withSession(deps, a.server, async (s, srv) => {
        if (!(await tmInstalled(s, a.dir))) return `No Tag Manager checkout at ${a.dir} on ${srv.name} — run tm_install.`;
        let cmd = `${tmCompose(a.dir)} logs --no-color --tail=${a.lines}`;
        if (a.since) cmd += ` --since=${shq(a.since)}`;
        if (a.service) cmd += ` ${a.service}`;
        cmd += a.grep ? ` 2>&1 | grep -i ${shq(a.grep)} | tail -n ${a.lines}` : " 2>&1";
        const r = await s.exec(cmd, { timeoutMs: 120_000 });
        return `TM logs from ${a.service ?? "all services"} on ${srv.name}:\n${redactSecrets(lastLines(r.stdout || r.stderr, a.lines)) || "(empty)"}`;
      });
    },
  },

  {
    name: "tm_restart",
    title: "Restart Tag Manager service(s)",
    description: "Restart one TM service (redis, minio, api, edge, varnish, purge-bridge) or the whole delivery core, then re-check health.",
    schema: { server: serverParam, dir: dirParam, service: z.enum(TM_SERVICES).optional().describe("Omit to restart the whole stack") },
    handler: async (deps, args) => {
      const a = args as { server?: string; dir: string; service?: string };
      return withSession(deps, a.server, async (s, srv) => {
        if (!(await tmInstalled(s, a.dir))) return `No Tag Manager checkout at ${a.dir} on ${srv.name} — run tm_install.`;
        const r = await s.exec(`${tmCompose(a.dir)} restart ${a.service ?? ""} 2>&1`, { timeoutMs: 300_000 });
        const gate = await s.exec(tmHealthGate(90), { timeoutMs: 120_000 });
        return [
          `Restarted ${a.service || "all TM services"} on ${srv.name} (exit ${r.code}).`,
          r.stdout.trim() ? lastLines(r.stdout, 15) : "",
          `Health: ${gate.stdout.trim()}`,
        ].filter(Boolean).join("\n");
      });
    },
  },

  {
    name: "tm_update",
    title: "Update Tag Manager",
    description:
      "Update the TM delivery core: git pull → rebuild → up -d → health-gate api+edge, with automatic rollback to " +
      "the previous commit if it doesn't come back healthy. No data backup needed — artifacts are recomputable from " +
      "the authoring DB and the control DB is external/managed.",
    schema: {
      server: serverParam,
      dir: dirParam,
      branch: z.string().optional().describe("Branch to deploy (default: the checked-out branch)"),
      rollbackOnFailure: z.boolean().default(true),
      force: z.boolean().default(false),
      timeoutSeconds: z.number().int().min(60).max(7200).default(1800),
    },
    annotations: { openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; dir: string; branch?: string; rollbackOnFailure: boolean; force: boolean; timeoutSeconds: number };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = a.dir;
        if (!(await tmInstalled(s, dir))) return `No Tag Manager checkout at ${dir} on ${srv.name} — run tm_install.`;
        const sections: string[] = [];

        const prev = (await s.exec(`cd ${shq(dir)} && git rev-parse HEAD`)).stdout.trim();
        const curBranch = (await s.exec(`cd ${shq(dir)} && git rev-parse --abbrev-ref HEAD`)).stdout.trim();
        const branch = a.branch || curBranch;
        const pull = await s.exec(
          `cd ${shq(dir)} && git fetch origin ${shq(branch)} && git checkout ${shq(branch)} && git pull --ff-only origin ${shq(branch)} && git rev-parse HEAD`,
          { timeoutMs: 300_000 }
        );
        if (pull.code !== 0) return `Git update failed (exit ${pull.code}):\n${lastLines(pull.stderr || pull.stdout, 25)}`;
        const next = pull.stdout.trim().split("\n").pop() ?? "";
        sections.push(`## Code\n${prev.slice(0, 10)} → ${next.slice(0, 10)} on ${branch}`);
        if (next === prev && !a.force) return sections.join("\n\n") + "\n\nAlready up to date — nothing deployed (force:true to redeploy anyway).";

        const redeploy = async () => {
          const b = await s.exec(`${tmCompose(dir)} build 2>&1`, { timeoutMs: a.timeoutSeconds * 1000 });
          if (b.code !== 0) return { ok: false, out: `build exit ${b.code}\n${redactSecrets(lastLines(b.stdout, 25))}` };
          const u = await s.exec(`${tmCompose(dir)} up -d 2>&1`, { timeoutMs: 600_000 });
          const g = await s.exec(tmHealthGate(150), { timeoutMs: 180_000 });
          return { ok: u.code === 0 && g.code === 0, out: `up exit ${u.code}; ${g.stdout.trim()}` };
        };

        const r = await redeploy();
        sections.push(`## Redeploy\n${r.out}`);
        if (!r.ok && a.rollbackOnFailure && next !== prev) {
          await s.exec(`cd ${shq(dir)} && git checkout ${shq(prev)}`, { timeoutMs: 60_000 });
          const rb = await redeploy();
          sections.push(`## ROLLBACK → ${prev.slice(0, 10)}\n${rb.out}\n${rb.ok ? "Rollback healthy — previous version restored. Investigate before retrying (tm_logs)." : "Rollback NOT healthy — manual intervention needed (tm_logs, tm_health)."}`);
        } else if (r.ok) {
          sections.push(`## Done\nUpdate deployed and healthy.`);
        } else {
          sections.push(`## Result\nUnhealthy and rollback disabled/not possible — investigate (tm_logs).`);
        }
        return sections.join("\n\n");
      });
    },
  },
];
