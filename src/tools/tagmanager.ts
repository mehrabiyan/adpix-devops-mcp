import { z } from "zod";
import { withSession } from "../deps.js";
import type { Deps } from "../deps.js";
import type { Session } from "../ssh.js";
import { uploadFile } from "../adpix.js";
import { shq, redactSecrets, lastLines, parseComposePs, table } from "../util.js";
import { ensureSharedDeployKey, sharedKeyInstructions, toSshUrl, gitSshEnv, coreSshCommand, diagnoseDeployKey, parseGithubRemote } from "../github.js";
import { pushCertForFqdn } from "./certs.js";
import type { ToolDef } from "./types.js";

const serverParam = z.string().optional().describe("Registered server name. Omit to use the default server.");
const dirParam = z.string().default("/opt/adpix-tagmanager").describe("Tag Manager checkout dir on the server");

const TM_REPO_URL = "https://github.com/mehrabiyan/AdpixTagManager.git";

/**
 * Optional control-DB-as-a-container override (dbContainer:true). The TM repo's compose ships NO
 * Postgres (it expects an external/managed DB); this layers a dedicated Postgres in the same compose
 * project so the api reaches it as `postgres:5432`. The api auto-migrates the schema on connect
 * (packages/db applyMigrations). Password comes from TM_DB_PASSWORD in deploy/.env.
 */
const TM_DB_OVERRIDE_YAML =
  `services:\n` +
  `  postgres:\n` +
  `    image: postgres:17-alpine\n` +
  `    restart: unless-stopped\n` +
  `    environment:\n` +
  `      POSTGRES_USER: adpix_tm\n` +
  `      POSTGRES_PASSWORD: \${TM_DB_PASSWORD:?set TM_DB_PASSWORD in deploy/.env}\n` +
  `      POSTGRES_DB: adpix_tm\n` +
  `    volumes:\n` +
  `      - tmdbdata:/var/lib/postgresql/data\n` +
  `    healthcheck:\n` +
  `      test: ["CMD-SHELL", "pg_isready -U adpix_tm"]\n` +
  `      interval: 5s\n` +
  `      timeout: 3s\n` +
  `      retries: 20\n` +
  `  api:\n` +
  `    depends_on:\n` +
  `      postgres:\n` +
  `        condition: service_healthy\n` +
  `volumes:\n` +
  `  tmdbdata: {}\n`;

/** Account/IdP (apps/auth) as a self-contained container. Mirrors deploy/Dockerfile.api; uses embedded
 *  PGlite (DB_DIR volume) so it needs no external DB, and auto-migrates on boot. Project: adpix-account. */
const TM_AUTH_DOCKERFILE =
  `FROM node:22-alpine\n` +
  `RUN corepack enable\n` +
  `WORKDIR /app\n` +
  `COPY . .\n` +
  `RUN pnpm install --prod=false\n` +
  `EXPOSE 9696\n` +
  `CMD ["node", "--experimental-strip-types", "apps/auth/src/server.ts"]\n`;

// The console is a Next.js SPA: NEXT_PUBLIC_* are inlined at BUILD time, so they come in as build args
// (the repo ships no Dockerfile for it — we ship one, like Dockerfile.auth, until CD owns it).
const TM_CONSOLE_DOCKERFILE =
  `FROM node:22-alpine\n` +
  `RUN corepack enable\n` +
  `WORKDIR /app\n` +
  `COPY . .\n` +
  ["NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_AUTH_ISSUER", "NEXT_PUBLIC_OIDC_CLIENT_ID", "NEXT_PUBLIC_ACCOUNT_URL", "NEXT_PUBLIC_ANALYTICS_URL", "NEXT_PUBLIC_TAGMANAGER_URL"].map((a) => `ARG ${a}\n`).join("") +
  `ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_AUTH_ISSUER=$NEXT_PUBLIC_AUTH_ISSUER NEXT_PUBLIC_OIDC_CLIENT_ID=$NEXT_PUBLIC_OIDC_CLIENT_ID NEXT_PUBLIC_ACCOUNT_URL=$NEXT_PUBLIC_ACCOUNT_URL NEXT_PUBLIC_ANALYTICS_URL=$NEXT_PUBLIC_ANALYTICS_URL NEXT_PUBLIC_TAGMANAGER_URL=$NEXT_PUBLIC_TAGMANAGER_URL NEXT_TELEMETRY_DISABLED=1\n` +
  `RUN pnpm install --prod=false\n` +
  `RUN pnpm --filter @adpix/console build\n` +
  `EXPOSE 3000\n` +
  `WORKDIR /app/apps/console\n` +
  `CMD ["pnpm", "start"]\n`;

// Console compose (project adpix-console). With `bundleCaddy` it also fronts <domain> on :80/:443
// (auto Let's Encrypt) and path-strips /api/* to the host-published TM api (8686) via the host gateway.
function consoleComposeYaml(opts: { dir: string; bundleCaddy: boolean; tlsCertDir?: string }): string {
  const args = [
    `        NEXT_PUBLIC_API_URL: \${NEXT_PUBLIC_API_URL:?set in deploy/.env.console}`,
    `        NEXT_PUBLIC_AUTH_ISSUER: \${NEXT_PUBLIC_AUTH_ISSUER:?set in deploy/.env.console}`,
    `        NEXT_PUBLIC_OIDC_CLIENT_ID: \${NEXT_PUBLIC_OIDC_CLIENT_ID:-tm-console}`,
    `        NEXT_PUBLIC_ACCOUNT_URL: \${NEXT_PUBLIC_ACCOUNT_URL:-}`,
    `        NEXT_PUBLIC_ANALYTICS_URL: \${NEXT_PUBLIC_ANALYTICS_URL:-}`,
    `        NEXT_PUBLIC_TAGMANAGER_URL: \${NEXT_PUBLIC_TAGMANAGER_URL:-}`,
  ].join("\n");
  const caddy = opts.bundleCaddy
    ? `  caddy:\n` +
      `    image: caddy:2-alpine\n` +
      `    restart: unless-stopped\n` +
      `    depends_on:\n      - console\n` +
      `    ports:\n      - "80:80"\n      - "443:443"\n` +
      `    extra_hosts:\n      - "host.docker.internal:host-gateway"\n` +
      `    volumes:\n` +
      `      - ${opts.dir}/deploy/Caddyfile.console:/etc/caddy/Caddyfile:ro\n` +
      (opts.tlsCertDir ? `      - ${opts.tlsCertDir}:${opts.tlsCertDir}:ro\n` : "") +
      `      - caddy_console_data:/data\n` +
      `      - caddy_console_config:/config\n`
    : "";
  const vols = opts.bundleCaddy ? `volumes:\n  caddy_console_data: {}\n  caddy_console_config: {}\n` : "";
  return (
    `services:\n` +
    `  console:\n` +
    `    build:\n` +
    `      context: ..\n` +
    `      dockerfile: deploy/Dockerfile.console\n` +
    `      args:\n${args}\n` +
    `    restart: unless-stopped\n` +
    `    ports:\n      - "\${CONSOLE_PORT:-3000}:3000"\n` +
    caddy +
    vols
  );
}
// The auth server REFUSES to boot in production without a stable RSA signing key (keystore.ts), so we
// generate one and embed it as a YAML literal block (env-files can't hold multi-line PEM). mode 600.
// When `domain` is set we also add a Caddy front door (auto Let's Encrypt + auto-renew) on :80/:443
// reverse-proxying to auth:9696 — so https://<domain> serves a real cert without manual TLS wiring.
function authComposeYaml(pem: string, opts: { domain?: string; dir?: string; tlsCertDir?: string } = {}): string {
  const body = pem.trim().split(/\r?\n/).map((l) => "        " + l).join("\n");
  const caddyfile = `${opts.dir ?? "/opt/adpix-tagmanager"}/deploy/Caddyfile.account`;
  const tlsMount = opts.tlsCertDir ? `      - ${opts.tlsCertDir}:${opts.tlsCertDir}:ro\n` : "";
  const caddy = opts.domain
    ? `  caddy:\n` +
      `    image: caddy:2-alpine\n` +
      `    restart: unless-stopped\n` +
      `    depends_on:\n      - auth\n` +
      `    ports:\n      - "80:80"\n      - "443:443"\n` +
      `    volumes:\n` +
      `      - ${caddyfile}:/etc/caddy/Caddyfile:ro\n` +
      tlsMount +
      `      - caddy_data:/data\n` +
      `      - caddy_config:/config\n`
    : "";
  const caddyVols = opts.domain ? `  caddy_data: {}\n  caddy_config: {}\n` : "";
  return (
    `services:\n` +
    `  auth:\n` +
    `    build:\n` +
    `      context: ..\n` +
    `      dockerfile: deploy/Dockerfile.auth\n` +
    `    restart: unless-stopped\n` +
    `    environment:\n` +
    `      AUTH_PORT: "9696"\n` +
    `      AUTH_ISSUER: \${AUTH_ISSUER:?set AUTH_ISSUER in deploy/.env.account}\n` +
    `      DB_DIR: /data\n` +
    `      NODE_ENV: production\n` +
    `      TRUST_PROXY: "1"\n` +
    // Redirect origins for the pre-registered OIDC clients (tm-console, analytics-console). Without
    // these the IdP falls back to localhost/defaults → "Invalid redirect_uri" for real deployments.
    `      CONSOLE_ORIGIN: \${CONSOLE_ORIGIN:-}\n` +
    `      ANALYTICS_ORIGIN: \${ANALYTICS_ORIGIN:-}\n` +
    `      ANALYTICS_API_ORIGIN: \${ANALYTICS_API_ORIGIN:-}\n` +
    `      BOOTSTRAP_ADMIN_EMAIL: \${BOOTSTRAP_ADMIN_EMAIL:-}\n` +
    `      BOOTSTRAP_ADMIN_PASSWORD: \${BOOTSTRAP_ADMIN_PASSWORD:-}\n` +
    `      OIDC_PRIVATE_KEY_PEM: |\n${body}\n` +
    `    ports:\n` +
    `      - "\${AUTH_PORT:-9696}:9696"\n` +
    `    volumes:\n` +
    `      - authdata:/data\n` +
    `    healthcheck:\n` +
    `      test: ["CMD-SHELL", "wget -q -O- http://localhost:9696/healthz >/dev/null 2>&1 || exit 1"]\n` +
    `      interval: 5s\n` +
    `      timeout: 3s\n` +
    `      retries: 24\n` +
    caddy +
    `volumes:\n` +
    `  authdata: {}\n` +
    caddyVols
  );
}

/**
 * Clone (or fast-forward) the AdpixTagManager repo, using the ONE shared MCP deploy key — the
 * same checkout serves the delivery core (tm_install) AND the Account/IdP (account_install).
 * Pushes a "## Checkout" section on success; returns null, or a halt message to return verbatim.
 */
async function checkoutTmRepo(deps: Deps, s: Session, dir: string, repoUrl: string, branch: string, srvName: string, sections: string[], toolName: string): Promise<string | null> {
  await s.exec("command -v git >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git ca-certificates)", { timeoutMs: 300_000 });
  // Branch-agnostic: clone the repo's DEFAULT branch, then check out the requested branch only if it
  // exists (the AdpixTagManager default isn't "main", so `-b main` would fail with "Remote branch not found").
  // On the update path, re-point origin + (re)apply the key config first — an existing checkout can
  // carry a stale remote/sshCommand from an earlier (pre-key) clone that would otherwise fail auth.
  const cloneCmd = (url: string, kEnv: string, postCfg: string) =>
    `if [ -d ${shq(dir + "/.git")} ]; then cd ${shq(dir)} && git remote set-url origin ${shq(url)} 2>/dev/null; true${postCfg} && ${kEnv}git fetch origin && (git checkout ${shq(branch)} 2>/dev/null || true) && ${kEnv}git pull --ff-only; ` +
    `else mkdir -p $(dirname ${shq(dir)}) && ${kEnv}git clone ${shq(url)} ${shq(dir)}${postCfg} && cd ${shq(dir)} && (git checkout ${shq(branch)} 2>/dev/null || true); fi`;
  const useKey = /^(git@|ssh:\/\/)/.test(repoUrl);
  let cloneUrl = repoUrl, keyEnv = "", postCfg = "";
  const halt = `\n\n(Nothing installed yet — add the key above to the repo's Deploy keys ONCE, then re-run ${toolName}. Every future server reuses it.)`;
  const applyKey = async (): Promise<boolean> => {
    const k = await ensureSharedDeployKey(deps, s, toSshUrl(repoUrl) ?? repoUrl, "adpix_tm");
    if (!k.authorized) { sections.push(`## Repo is private — add ONE deploy key (reused for every server)\n${sharedKeyInstructions(k)}`); return false; }
    cloneUrl = k.sshUrl; keyEnv = gitSshEnv(k.prodKeyPath); postCfg = ` && git -C ${shq(dir)} config core.sshCommand ${shq(coreSshCommand(k.prodKeyPath))}`;
    sections.push(`## Repo access\nShared read-only deploy key (managed on the MCP) authorized for ${k.owner}/${k.repo}; distributed to ${srvName} and cloning over SSH.`);
    return true;
  };
  if (useKey && !(await applyKey())) return sections.join("\n\n") + halt;
  let clone = await s.exec(cloneCmd(cloneUrl, keyEnv, postCfg), { timeoutMs: 300_000 });
  if (clone.code !== 0 && !useKey) {
    const authish = /could not read Username|Authentication failed|terminal prompts disabled|repository not found|Permission denied|fatal: Could not read/i.test(clone.stderr + clone.stdout);
    if (authish) { if (!(await applyKey())) return sections.join("\n\n") + halt; clone = await s.exec(cloneCmd(cloneUrl, keyEnv, postCfg), { timeoutMs: 300_000 }); }
  }
  // Key authorized but the existing checkout still can't fetch (broken git state): re-clone fresh,
  // preserving the generated deploy secrets (.env, .env.account, the OIDC signing key).
  if (clone.code !== 0 && keyEnv) {
    const had = await s.exec(`test -d ${shq(dir + "/.git")} && echo yes || echo no`);
    if (/yes/.test(had.stdout)) {
      await s.exec(`mkdir -p /tmp/tm-reclone && cp ${shq(dir + "/deploy/.env")} ${shq(dir + "/deploy/.env.account")} ${shq(dir + "/deploy/account/oidc_key.pem")} /tmp/tm-reclone/ 2>/dev/null; rm -rf ${shq(dir)}`, { timeoutMs: 60_000 });
      clone = await s.exec(cloneCmd(cloneUrl, keyEnv, postCfg), { timeoutMs: 300_000 });
      await s.exec(`if [ "$(ls -A /tmp/tm-reclone 2>/dev/null)" ]; then mkdir -p ${shq(dir + "/deploy/account")} && cp /tmp/tm-reclone/.env ${shq(dir + "/deploy/")} 2>/dev/null; cp /tmp/tm-reclone/.env.account ${shq(dir + "/deploy/")} 2>/dev/null; cp /tmp/tm-reclone/oidc_key.pem ${shq(dir + "/deploy/account/")} 2>/dev/null; fi; rm -rf /tmp/tm-reclone; true`, { timeoutMs: 30_000 });
      if (clone.code === 0) sections.push("## Repo reset\nThe existing checkout couldn't authenticate (stale git state); re-cloned fresh with the deploy key. Generated secrets were preserved.");
    }
  }
  if (clone.code !== 0) {
    let diag = "";
    if (keyEnv && /Permission denied|Could not read/i.test(clone.stderr + clone.stdout)) {
      const gh = parseGithubRemote(repoUrl);
      try { diag = "\n\n" + await diagnoseDeployKey(s, keyEnv, gh ? `${gh.owner}/${gh.repo}` : ""); } catch { /* best-effort */ }
    }
    return (sections.length ? sections.join("\n\n") + "\n\n" : "") + `## Checkout FAILED (exit ${clone.code})\n${lastLines(clone.stderr || clone.stdout, 30)}${diag}`;
  }
  sections.push(`## Checkout\n${cloneUrl} @ ${branch} → ${dir}`);
  return null;
}
const TM_PROJECT = "adpix-tm";

/** The Tag Manager delivery core (deploy/docker-compose.yml). api+edge+varnish are the serving services. */
const TM_SERVICES = ["redis", "minio", "api", "edge", "varnish", "purge-bridge"] as const;

/** compose secrets the deploy/docker-compose.yml requires (`:?` — compose fails fast without them). */
const TM_REQUIRED = ["DATABASE_URL", "AUTH_ISSUER", "S3_ACCESS_KEY", "S3_SECRET_KEY", "PURGE_TOKEN"] as const;

/** Production compose invocation for the TM delivery core, run from the checkout dir. */
export function tmCompose(dir: string): string {
  return `cd ${shq(dir)} && docker compose -p ${TM_PROJECT} -f deploy/docker-compose.yml --env-file deploy/.env`;
}

/** Single remote loop that waits for the api (8686, host-published) and edge to be healthy. The edge
 *  (8585) is intentionally NOT host-published — it sits behind varnish — so a host-direct curl is a
 *  false negative; we accept a host probe if it answers, else confirm the edge CONTAINER is running. */
export function tmHealthGate(timeoutSec = 150): string {
  const tries = Math.max(1, Math.floor(timeoutSec / 5));
  return (
    `a=000; e=down; for i in $(seq 1 ${tries}); do ` +
    `a=$(curl -fsS -o /dev/null -m 5 -w '%{http_code}' http://localhost:8686/healthz 2>/dev/null || echo 000); ` +
    `ec=$(curl -fsS -o /dev/null -m 5 -w '%{http_code}' http://localhost:8585/healthz 2>/dev/null || echo 000); ` +
    `case "$ec" in 2*) e=up ;; *) docker inspect -f '{{.State.Running}}' ${TM_PROJECT}-edge-1 2>/dev/null | grep -qi true && e=up || e=down ;; esac; ` +
    `if [ "$a" = 200 ] && [ "$e" = up ]; then echo "healthy after ~$((i*5))s (api 200, edge up behind varnish)"; exit 0; fi; sleep 5; done; ` +
    `echo "NOT healthy after ${timeoutSec}s (api=$a edge=$e)"; exit 1`
  );
}

/** PoP compose: the delivery core + a PoP override (redis replicates the core, edge points at the central object store). */
export function tmPopCompose(dir: string): string {
  return `cd ${shq(dir)} && docker compose -p ${TM_PROJECT} -f deploy/docker-compose.yml -f deploy/docker-compose.pop.yml --env-file deploy/.env`;
}

/** Wait for a PoP's edge (8585 /healthz) + varnish (8080) to answer. Varnish 404 at / is fine — it's up. */
function popHealthGate(timeoutSec = 120): string {
  const tries = Math.max(1, Math.floor(timeoutSec / 5));
  return (
    `e=000; v=000; for i in $(seq 1 ${tries}); do ` +
    `e=$(curl -fsS -o /dev/null -m 5 -w '%{http_code}' http://localhost:8585/healthz 2>/dev/null || echo 000); ` +
    `v=$(curl -sS -o /dev/null -m 5 -w '%{http_code}' http://localhost:8080/ 2>/dev/null || echo 000); ` +
    `if [ "$e" = 200 ] && [ "$v" != 000 ]; then echo "healthy after ~$((i*5))s (edge=$e varnish=$v)"; exit 0; fi; sleep 5; done; ` +
    `echo "NOT healthy (edge=$e varnish=$v)"; exit 1`
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
      databaseUrl: z.string().optional().describe("Postgres URL for the authoring/control DB (required on first install, unless dbContainer:true)"),
      dbContainer: z.boolean().default(false).describe("Provision the control DB as a Postgres container ON THIS server (auto-generates DATABASE_URL). The TM api auto-migrates the schema on connect. No external managed DB needed."),
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
        databaseUrl?: string; dbContainer: boolean; authIssuer?: string; s3AccessKey?: string; s3SecretKey?: string; purgeToken?: string;
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

        const halt = await checkoutTmRepo(deps, s, dir, a.repoUrl, a.branch, srv.name, sections, "tm_install");
        if (halt) return halt;

        // Optional: provision the control DB as a Postgres container ON THIS server (no external DB).
        let dbPw = "", composeFiles = `-f deploy/docker-compose.yml`;
        if (a.dbContainer) {
          // reuse a previously-generated password (idempotent), else mint one
          dbPw = (await s.exec(`grep -h '^TM_DB_PASSWORD=' ${shq(dir + "/deploy/.env")} 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\\n'`)).stdout.trim();
          if (!dbPw) dbPw = (await s.exec(`openssl rand -hex 24 2>/dev/null || head -c18 /dev/urandom | od -An -tx1 | tr -d ' \\n'`)).stdout.trim();
          await uploadFile(s, `${dir}/deploy/docker-compose.db.yml`, TM_DB_OVERRIDE_YAML, "644");
          composeFiles = `-f deploy/docker-compose.yml -f deploy/docker-compose.db.yml`;
          a.databaseUrl = `postgres://adpix_tm:${dbPw}@postgres:5432/adpix_tm`;
          sections.push(`## Control DB\nProvisioning a Postgres container on ${srv.name} (service "postgres", volume tmdbdata). The TM api migrates the schema on first connect — no external DB needed.`);
        }
        const TMC = `cd ${shq(dir)} && docker compose -p ${TM_PROJECT} ${composeFiles} --env-file deploy/.env`;

        // The object store is the BUNDLED MinIO container (S3_ENDPOINT=http://minio:9000) — NOT
        // ClickHouse (that's Analytics). S3_ACCESS_KEY/S3_SECRET_KEY are MinIO's root credentials and
        // PURGE_TOKEN is shared with Varnish, all SELF-DEFINED — so auto-generate any not supplied
        // (reusing existing .env on re-install). Only AUTH_ISSUER is external; DATABASE_URL is needed
        // unless dbContainer provided it.
        const envExists = (await s.exec(`test -f ${shq(dir + "/deploy/.env")} && echo yes || echo no`)).stdout.trim() === "yes";
        const reuseOrGen = async (provided: string | undefined, envKey: string): Promise<string> => {
          if (provided) return provided;
          const ex = (await s.exec(`grep -h '^${envKey}=' ${shq(dir + "/deploy/.env")} 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\\n'`)).stdout.trim();
          if (ex) return ex;
          return (await s.exec(`openssl rand -hex 24 2>/dev/null || head -c18 /dev/urandom | od -An -tx1 | tr -d ' \\n'`)).stdout.trim();
        };
        const missing: string[] = [];
        if (!a.authIssuer) missing.push("authIssuer (the external OIDC account center)");
        if (!a.dbContainer && !a.databaseUrl) missing.push("databaseUrl (or set dbContainer:true to run Postgres here)");
        if (missing.length) {
          if (!envExists) return sections.join("\n\n") + `\n\n## Secrets — action needed\nProvide: ${missing.join("; ")}. (The MinIO object-store creds + the purge token auto-generate — only the OIDC issuer is external.) Nothing was deployed.`;
          sections.push(`## Secrets\nReusing existing deploy/.env (${missing.map((m) => m.split(" ")[0]).join(", ")} not re-supplied).`);
        } else {
          a.s3AccessKey = await reuseOrGen(a.s3AccessKey, "S3_ACCESS_KEY");
          a.s3SecretKey = await reuseOrGen(a.s3SecretKey, "S3_SECRET_KEY");
          a.purgeToken = await reuseOrGen(a.purgeToken, "PURGE_TOKEN");
          const envBody =
            `DATABASE_URL=${a.databaseUrl}\n` +
            (a.dbContainer ? `TM_DB_PASSWORD=${dbPw}\n` : "") +
            `AUTH_ISSUER=${a.authIssuer}\n` +
            `S3_ENDPOINT=http://minio:9000\n` +
            `S3_ACCESS_KEY=${a.s3AccessKey}\n` +
            `S3_SECRET_KEY=${a.s3SecretKey}\n` +
            `PURGE_TOKEN=${a.purgeToken}\n` +
            `S3_BUCKET=${a.s3Bucket}\n`;
          await uploadFile(s, `${dir}/deploy/.env`, envBody, "600");
          sections.push(`## Secrets\nWrote deploy/.env (mode 600). Object store = bundled MinIO container (auto-generated root creds)${a.dbContainer ? "; control DB = local Postgres container" : ""}. Values kept off this transcript.`);
        }

        const build = await s.exec(`${TMC} build 2>&1`, { timeoutMs: a.timeoutSeconds * 1000 });
        if (build.code !== 0) return sections.join("\n\n") + `\n\n## build FAILED (exit ${build.code})\n${redactSecrets(lastLines(build.stdout, 40))}`;
        const up = await s.exec(`${TMC} up -d 2>&1`, { timeoutMs: 600_000 });
        sections.push(`## compose up (exit ${up.code})\n${redactSecrets(lastLines(up.stdout, 25))}`);
        if (up.code !== 0) return sections.join("\n\n") + `\n\nBring-up FAILED — see above (tm_logs to dig in).`;

        const gate = await s.exec(tmHealthGate(150), { timeoutMs: 180_000 });
        sections.push(`## Health gate\n${gate.stdout.trim()}`);
        sections.push(
          `## Done\nDelivery core up: api :8686 · edge :8585 · varnish :8080 (PoP cache). ` +
            `Front it with TLS (deploy/nginx.conf) for cdn.adpix.net and route /a/* + /c/* to it. ` +
            `The Account/IdP (apps/auth) deploys separately with account_install (or the Setup wizard).`
        );
        return sections.join("\n\n");
      });
    },
  },

  {
    name: "account_install",
    title: "Install AdPix Account / IdP",
    description:
      "Deploy the AdPix Account center (the OIDC identity provider, apps/auth from the Tag Manager repo) as a " +
      "self-contained container on a server: clone (shared deploy key), write a Dockerfile + compose for apps/auth, " +
      "build, and bring it up on :9696 with an EMBEDDED database (PGlite — no external DB needed), bootstrapping the " +
      "first admin and health-gating /healthz. Its issuer URL is what Tag Manager + Analytics use as AUTH_ISSUER.",
    schema: {
      server: serverParam,
      dir: dirParam,
      repoUrl: z.string().default(TM_REPO_URL),
      branch: z.string().default("main"),
      domain: z.string().optional().describe("Public domain for the account center (HTTPS). Omit → http on the server IP:port."),
      adminEmail: z.string().optional().describe("Bootstrap platform-admin email (default admin@<domain or host>)"),
      consoleOrigin: z.string().optional().describe("Tag Manager console origin, e.g. https://tag.adpix.io — so the IdP registers tm-console's redirect URIs (else Invalid redirect_uri)"),
      analyticsOrigin: z.string().optional().describe("Analytics console origin, e.g. https://app.adpix.io — registers analytics-console's redirect URIs"),
      analyticsApiOrigin: z.string().optional().describe("Analytics BFF/api origin (often same as analyticsOrigin) — registers the api callback redirect"),
      port: z.number().int().min(1).max(65535).default(9696),
      timeoutSeconds: z.number().int().min(60).max(7200).default(2400),
    },
    annotations: { idempotentHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; dir: string; repoUrl: string; branch: string; domain?: string; adminEmail?: string; consoleOrigin?: string; analyticsOrigin?: string; analyticsApiOrigin?: string; port: number; timeoutSeconds: number };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = a.dir;
        const sections: string[] = [];
        const docker = await s.exec("command -v docker >/dev/null && docker compose version >/dev/null 2>&1 && echo ok || echo no");
        if (docker.stdout.trim() !== "ok") return `Docker (with the compose plugin) isn't available on ${srv.name}. Install Docker first (adpix_install sets it up), then re-run account_install.`;

        const halt = await checkoutTmRepo(deps, s, dir, a.repoUrl, a.branch, srv.name, sections, "account_install");
        if (halt) return halt;

        // self-contained IdP: embedded PGlite (DB_DIR volume), stable bootstrap admin, issuer URL.
        const issuer = a.domain ? `https://${a.domain}` : `http://${srv.host}:${a.port}`;
        const adminEmail = a.adminEmail || `admin@${a.domain || srv.host}`;
        const reuse = async (envKey: string) => (await s.exec(`grep -h '^${envKey}=' ${shq(dir + "/deploy/.env.account")} 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\\n'`)).stdout.trim();
        let adminPw = await reuse("BOOTSTRAP_ADMIN_PASSWORD");
        if (!adminPw) adminPw = (await s.exec(`openssl rand -hex 18 2>/dev/null || head -c14 /dev/urandom | od -An -tx1 | tr -d ' \\n'`)).stdout.trim();

        // Stable RSA signing key — the auth server refuses to boot in production without it (and
        // ephemeral keys would invalidate every token on restart). Generate once, reuse thereafter.
        const keyPath = `${dir}/deploy/account/oidc_key.pem`;
        let pem = (await s.exec(`cat ${shq(keyPath)} 2>/dev/null`)).stdout;
        if (!/BEGIN/.test(pem)) {
          await s.exec(`mkdir -p ${shq(dir + "/deploy/account")} && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ${shq(keyPath)} 2>/dev/null && chmod 600 ${shq(keyPath)}`, { timeoutMs: 60_000 });
          pem = (await s.exec(`cat ${shq(keyPath)}`)).stdout;
        }
        if (!/BEGIN/.test(pem)) return sections.join("\n\n") + `\n\nCould not generate the OIDC signing key (openssl missing?). Install openssl on ${srv.name} and re-run.`;

        // If the Certificate Manager has a cert covering this FQDN (incl. a *.adpix.io wildcard), push it
        // and serve it from Caddy (manual TLS) instead of Let's Encrypt — the air-gap / internal-CA path.
        const cert = a.domain ? await pushCertForFqdn(s, a.domain) : null;
        await uploadFile(s, `${dir}/deploy/Dockerfile.auth`, TM_AUTH_DOCKERFILE, "644");
        await uploadFile(s, `${dir}/deploy/docker-compose.auth.yml`, authComposeYaml(pem, { domain: a.domain, dir, tlsCertDir: cert?.dir }), "600");
        const origins = [
          a.consoleOrigin ? `CONSOLE_ORIGIN=${a.consoleOrigin}` : "",
          a.analyticsOrigin ? `ANALYTICS_ORIGIN=${a.analyticsOrigin}` : "",
          a.analyticsApiOrigin ? `ANALYTICS_API_ORIGIN=${a.analyticsApiOrigin}` : "",
        ].filter(Boolean).join("\n");
        await uploadFile(s, `${dir}/deploy/.env.account`, `AUTH_ISSUER=${issuer}\nAUTH_PORT=${a.port}\n${origins ? origins + "\n" : ""}BOOTSTRAP_ADMIN_EMAIL=${adminEmail}\nBOOTSTRAP_ADMIN_PASSWORD=${adminPw}\n`, "600");
        // With a domain, front the IdP with Caddy. A stored cert covering the FQDN → manual TLS (air-gap /
        // internal CA); otherwise automatic Let's Encrypt (HTTP-01/TLS-ALPN) + renew.
        if (a.domain) {
          const tlsLine = cert ? `\ttls ${cert.dir}/fullchain.pem ${cert.dir}/key.pem\n` : "";
          await uploadFile(s, `${dir}/deploy/Caddyfile.account`, `${a.domain} {\n${tlsLine}\treverse_proxy auth:9696\n}\n`, "644");
          // Open the host firewall (ufw, if active) for the ACME challenge + HTTPS. A cloud firewall
          // (Hetzner/AWS SG) is separate and must be opened in the provider console.
          await s.exec(`command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi active && { ufw allow 80/tcp; ufw allow 443/tcp; } || true`, { timeoutMs: 30_000 });
        }
        sections.push(`## Config\nIssuer ${issuer} · admin ${adminEmail} · embedded PGlite (volume authdata) · stable signing key${a.domain ? (cert ? ` · Caddy TLS via your uploaded cert "${cert.via}" (${cert.sans.join(", ")})` : ` · Caddy TLS front door (Let's Encrypt, auto-renew) for ${a.domain}`) : ""}. Wire this issuer as AUTH_ISSUER in Tag Manager + Analytics.`);

        const AC = `cd ${shq(dir)} && docker compose -p adpix-account -f deploy/docker-compose.auth.yml --env-file deploy/.env.account`;
        const build = await s.exec(`${AC} build 2>&1`, { timeoutMs: a.timeoutSeconds * 1000 });
        if (build.code !== 0) return sections.join("\n\n") + `\n\n## build FAILED (exit ${build.code})\n${redactSecrets(lastLines(build.stdout, 40))}`;
        const up = await s.exec(`${AC} up -d 2>&1`, { timeoutMs: 600_000 });
        sections.push(`## compose up (exit ${up.code})\n${redactSecrets(lastLines(up.stdout, 20))}`);
        if (up.code !== 0) return sections.join("\n\n") + `\n\nBring-up FAILED — see above.`;

        const gate = await s.exec(
          `code=000; for i in $(seq 1 30); do code=$(curl -fsS -o /dev/null -m 5 -w '%{http_code}' http://localhost:${a.port}/healthz 2>/dev/null || echo 000); case "$code" in 2*) echo "healthy after ~$((i*5))s"; exit 0;; esac; sleep 5; done; echo "NOT healthy after 150s (last $code)"; exit 1`,
          { timeoutMs: 180_000 }
        );
        sections.push(`## Health gate\n${gate.stdout.trim()}`);
        if (gate.code !== 0) {
          const logs = await s.exec(`${AC} logs --no-color --tail 60 auth 2>&1`, { timeoutMs: 30_000 });
          return sections.join("\n\n") + `\n\n## Account NOT healthy — auth container logs (last 60)\n${redactSecrets(lastLines(logs.stdout || logs.stderr, 60))}\n\nFix the cause and re-run account_install (idempotent).`;
        }
        if (a.domain) {
          // Caddy provisions the Let's Encrypt cert on first use; confirm :443 now serves the domain.
          // --resolve pins the domain to the local Caddy so we test THIS box's cert, not DNS routing.
          const tls = await s.exec(
            `for i in $(seq 1 12); do code=$(curl -fsS -o /dev/null -m 8 --resolve ${shq(a.domain + ":443:127.0.0.1")} -w '%{http_code}' https://${a.domain}/healthz 2>/dev/null || echo 000); case "$code" in 2*|3*) echo "ready (HTTPS $code)"; exit 0;; esac; sleep 5; done; echo "not ready yet (last $code)"`,
            { timeoutMs: 90_000 }
          );
          const ok = /ready \(HTTPS/.test(tls.stdout);
          sections.push(
            `## HTTPS (Caddy + Let's Encrypt)\n${tls.stdout.trim()} on :443 for ${a.domain} (auto-renewed).` +
              (ok ? "" : `\n⚠ Cert not provisioned yet. Let's Encrypt validates over :80 from the internet — open **80 AND 443** at your CLOUD firewall (Hetzner/AWS security group), not just the host. Caddy retries automatically; re-check with: curl -I https://${a.domain}/healthz`)
          );
        }
        sections.push(
          `## Done\nAccount/IdP up at ${issuer} (/.well-known/openid-configuration). ` +
            `Admin: ${adminEmail} — password in ${dir}/deploy/.env.account (kept off this transcript). ` +
            `${a.domain ? `Caddy serves ${a.domain} on :443 (Let's Encrypt). Direct: http://${srv.host}:${a.port}. ` : `Open port ${a.port} in the firewall (no domain set → HTTP only). `}` +
            `Set AUTH_ISSUER=${issuer} when installing Tag Manager.`
        );
        return sections.join("\n\n");
      });
    },
  },

  {
    name: "console_install",
    title: "Install the Tag Manager console (UI)",
    description:
      "Build + run the Tag Manager management UI (apps/console, Next.js) on :3000. NEXT_PUBLIC_* (api url, " +
      "issuer, client id, product urls) are inlined at BUILD time — changing them later needs a rebuild, not a " +
      "restart. With a domain it also fronts <domain> with Caddy (auto Let's Encrypt) and path-strips /api/* to " +
      "the host-published TM api (8686) — UNLESS another front door already holds :80/:443, in which case it runs " +
      "console-only and prints the site block to add to your existing Caddy. Ships its own Dockerfile.console.",
    schema: {
      server: serverParam,
      dir: dirParam,
      repoUrl: z.string().default(TM_REPO_URL),
      branch: z.string().default("main"),
      domain: z.string().optional().describe("Public domain for the console UI, e.g. tag.adpix.io (HTTPS). Omit → http on the server IP:port."),
      authIssuer: z.string().describe("The IdP issuer, e.g. https://auth.adpix.io (NEXT_PUBLIC_AUTH_ISSUER + ACCOUNT_URL)"),
      apiUrl: z.string().optional().describe("Public TM api base for the SPA (NEXT_PUBLIC_API_URL). Default: domain ? https://<domain>/api : http://<host>:8686"),
      analyticsUrl: z.string().optional().describe("Analytics dashboard URL (NEXT_PUBLIC_ANALYTICS_URL), e.g. https://app.adpix.io"),
      oidcClientId: z.string().default("tm-console").describe("The console's OIDC client id (must match the IdP's registered client)"),
      port: z.number().int().min(1).max(65535).default(3000),
      timeoutSeconds: z.number().int().min(60).max(7200).default(3600),
    },
    annotations: { idempotentHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; dir: string; repoUrl: string; branch: string; domain?: string; authIssuer: string; apiUrl?: string; analyticsUrl?: string; oidcClientId: string; port: number; timeoutSeconds: number };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = a.dir;
        const sections: string[] = [];
        const docker = await s.exec("command -v docker >/dev/null && docker compose version >/dev/null 2>&1 && echo ok || echo no");
        if (docker.stdout.trim() !== "ok") return `Docker (with the compose plugin) isn't available on ${srv.name}. Install Docker first, then re-run console_install.`;

        const halt = await checkoutTmRepo(deps, s, dir, a.repoUrl, a.branch, srv.name, sections, "console_install");
        if (halt) return halt;

        const apiUrl = a.apiUrl || (a.domain ? `https://${a.domain}/api` : `http://${srv.host}:8686`);
        const tagUrl = a.domain ? `https://${a.domain}` : `http://${srv.host}:${a.port}`;
        // One reverse proxy owns :80/:443 — if something already holds them (the IdP/Analytics Caddy),
        // don't bundle a second (port clash); run console-only + print the route to add.
        const held = a.domain ? /:443\s/.test((await s.exec(`ss -ltn 2>/dev/null | grep ':443 ' || true`)).stdout) : false;
        const bundleCaddy = !!a.domain && !held;

        // A stored cert covering this FQDN → manual TLS in the bundled Caddy; else auto Let's Encrypt.
        const cert = bundleCaddy && a.domain ? await pushCertForFqdn(s, a.domain) : null;
        await uploadFile(s, `${dir}/deploy/Dockerfile.console`, TM_CONSOLE_DOCKERFILE, "644");
        await uploadFile(s, `${dir}/deploy/docker-compose.console.yml`, consoleComposeYaml({ dir, bundleCaddy, tlsCertDir: cert?.dir }), "644");
        await uploadFile(
          s,
          `${dir}/deploy/.env.console`,
          `NEXT_PUBLIC_API_URL=${apiUrl}\nNEXT_PUBLIC_AUTH_ISSUER=${a.authIssuer}\nNEXT_PUBLIC_OIDC_CLIENT_ID=${a.oidcClientId}\nNEXT_PUBLIC_ACCOUNT_URL=${a.authIssuer}\nNEXT_PUBLIC_ANALYTICS_URL=${a.analyticsUrl || ""}\nNEXT_PUBLIC_TAGMANAGER_URL=${tagUrl}\nCONSOLE_PORT=${a.port}\n`,
          "600"
        );
        if (bundleCaddy) {
          const tlsLine = cert ? `\ttls ${cert.dir}/fullchain.pem ${cert.dir}/key.pem\n` : "";
          await uploadFile(s, `${dir}/deploy/Caddyfile.console`, `${a.domain} {\n\tencode gzip\n${tlsLine}\thandle_path /api/* {\n\t\treverse_proxy host.docker.internal:8686\n\t}\n\thandle {\n\t\treverse_proxy console:3000\n\t}\n}\n`, "644");
          await s.exec(`command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi active && { ufw allow 80/tcp; ufw allow 443/tcp; } || true`, { timeoutMs: 30_000 });
        }
        sections.push(`## Config\nConsole UI ${tagUrl} · api ${apiUrl} · issuer ${a.authIssuer} · client ${a.oidcClientId}${bundleCaddy ? " · bundled Caddy (Let's Encrypt) + /api path-strip" : a.domain ? " · :443 already in use → console-only (add the route below to your front door)" : ""}. NEXT_PUBLIC_* are baked at build time — a URL change needs a rebuild.`);

        const CC = `cd ${shq(dir)} && docker compose -p adpix-console -f deploy/docker-compose.console.yml --env-file deploy/.env.console`;
        const build = await s.exec(`${CC} build 2>&1`, { timeoutMs: a.timeoutSeconds * 1000 });
        if (build.code !== 0) return sections.join("\n\n") + `\n\n## build FAILED (exit ${build.code})\n${redactSecrets(lastLines(build.stdout, 40))}`;
        const up = await s.exec(`${CC} up -d 2>&1`, { timeoutMs: 600_000 });
        sections.push(`## compose up (exit ${up.code})\n${redactSecrets(lastLines(up.stdout, 15))}`);
        if (up.code !== 0) return sections.join("\n\n") + `\n\nBring-up FAILED — see above.`;

        const gate = await s.exec(
          `code=000; for i in $(seq 1 40); do code=$(curl -fsS -o /dev/null -m 5 -w '%{http_code}' http://localhost:${a.port}/ 2>/dev/null || echo 000); case "$code" in 2*|3*) echo "healthy after ~$((i*5))s (HTTP $code)"; exit 0;; esac; sleep 5; done; echo "NOT healthy after 200s (last $code)"; exit 1`,
          { timeoutMs: 240_000 }
        );
        sections.push(`## Health gate\n${gate.stdout.trim()}`);
        if (gate.code !== 0) {
          const logs = await s.exec(`${CC} logs --no-color --tail 50 console 2>&1`, { timeoutMs: 30_000 });
          return sections.join("\n\n") + `\n\n## Console NOT healthy — container logs (last 50)\n${redactSecrets(lastLines(logs.stdout || logs.stderr, 50))}`;
        }
        if (a.domain && !bundleCaddy) {
          sections.push(`## Add this to your existing front door (it already owns :443)\n\`\`\`\n${a.domain} {\n\tencode gzip\n\thandle_path /api/* { reverse_proxy 172.17.0.1:8686 }\n\thandle { reverse_proxy 172.17.0.1:${a.port} }\n}\n\`\`\`\nThen reload it. (console + api are host-published; reach them via the docker bridge gateway.)`);
        }
        sections.push(`## Done\nTag Manager console at ${tagUrl}. OIDC client \`${a.oidcClientId}\` — its redirect URIs must be registered on the IdP (account_install consoleOrigin=${tagUrl}).`);
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

        // api (8686) + varnish (8080) are host-published; the edge (8585) is NOT — it sits behind
        // varnish — so a host-direct probe there is a false negative. For edge, accept the host probe
        // if it answers, else fall back to "is the edge container running". Varnish 404 at / is fine.
        const probe = await s.exec(
          `for p in 8686:/healthz 8585:/healthz 8080:/; do ` +
            `port=\${p%%:*}; path=\${p#*:}; ` +
            `code=$(curl -fsS -o /dev/null -m 5 -w '%{http_code}' http://localhost:$port$path 2>/dev/null || echo 000); ` +
            `if [ "$port" = 8585 ] && ! echo "$code" | grep -q '^[23]'; then docker inspect -f '{{.State.Running}}' ${TM_PROJECT}-edge-1 2>/dev/null | grep -qi true && code=running; fi; ` +
            `echo "$port $code"; done`,
          { timeoutMs: 60_000 }
        );
        const probeRows = probe.stdout.trim().split("\n").map((l) => {
          const [port = "?", code = "000"] = l.trim().split(/\s+/);
          const svc = port === "8686" ? "api" : port === "8585" ? "edge" : "varnish";
          const ok = /^[23]/.test(code) || code === "running" || (port === "8080" && code === "404");
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

  {
    name: "pop_add",
    title: "Add a delivery PoP",
    description:
      "Provision a delivery Point-of-Presence (DEPLOYMENT_SRE §8.1): the edge + varnish + purge-bridge + a Redis " +
      "REPLICA of the core's pointer KV — so the PoP serves immutable artifacts from the central object store and " +
      "rolls forward on publish via replicated purge pub/sub. Clones the repo, writes deploy/.env + a PoP compose " +
      "override (redis replicaof the core, edge → central object store), brings the four services up, verifies the " +
      "Redis replication link is up, health-gates edge+varnish, and prints the DNS/CDN behavior to add. The object " +
      "store stays central; no api/minio runs on a PoP.",
    schema: {
      server: serverParam,
      dir: dirParam,
      coreRedisHost: z.string().describe("Host/IP of the core (origin) Redis to replicate pointers + purge from"),
      objectStore: z.string().describe("Central object-store endpoint the edge reads artifacts from, e.g. https://cdn-origin.adpix.net or http://10.0.0.2:9000"),
      s3AccessKey: z.string().describe("Object-store access key (read the private artifacts bucket)"),
      s3SecretKey: z.string().describe("Object-store secret key"),
      purgeToken: z.string().describe("PURGE token shared with varnish.vcl"),
      s3Bucket: z.string().default("adpix-tags"),
      repoUrl: z.string().default(TM_REPO_URL),
      branch: z.string().default("main"),
      timeoutSeconds: z.number().int().min(60).max(7200).default(1800),
    },
    annotations: { idempotentHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as {
        server?: string; dir: string; coreRedisHost: string; objectStore: string;
        s3AccessKey: string; s3SecretKey: string; purgeToken: string; s3Bucket: string;
        repoUrl: string; branch: string; timeoutSeconds: number;
      };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = a.dir;
        const sections: string[] = [];

        const docker = await s.exec("command -v docker >/dev/null && docker compose version >/dev/null 2>&1 && echo ok || echo no");
        if (docker.stdout.trim() !== "ok") return `Docker (with the compose plugin) isn't available on ${srv.name}. Install Docker first, then re-run pop_add.`;
        await s.exec("command -v git >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git ca-certificates)", { timeoutMs: 300_000 });

        const clone = await s.exec(
          `if [ -d ${shq(dir + "/.git")} ]; then cd ${shq(dir)} && git fetch origin ${shq(a.branch)} && git checkout ${shq(a.branch)} && git pull --ff-only origin ${shq(a.branch)}; ` +
            `else mkdir -p $(dirname ${shq(dir)}) && git clone -b ${shq(a.branch)} ${shq(a.repoUrl)} ${shq(dir)}; fi`,
          { timeoutMs: 300_000 }
        );
        if (clone.code !== 0) return `## Checkout FAILED (exit ${clone.code})\n${lastLines(clone.stderr || clone.stdout, 25)}`;

        // .env: api-only keys (DATABASE_URL/AUTH_ISSUER) get placeholders — the api/minio services aren't started
        // on a PoP, but compose still parses their `:?`-required vars, so they must be present.
        const envBody =
          `DATABASE_URL=postgres://pop-unused\nAUTH_ISSUER=https://pop-unused\n` +
          `S3_ACCESS_KEY=${a.s3AccessKey}\nS3_SECRET_KEY=${a.s3SecretKey}\nS3_BUCKET=${a.s3Bucket}\nPURGE_TOKEN=${a.purgeToken}\n`;
        await uploadFile(s, `${dir}/deploy/.env`, envBody, "600");

        const popOverride =
          `services:\n` +
          `  redis:\n` +
          `    command: ["redis-server","--save","","--maxmemory-policy","noeviction","--replicaof","${a.coreRedisHost}","6379"]\n` +
          `  edge:\n` +
          `    environment:\n` +
          `      S3_ENDPOINT: "${a.objectStore}"\n`;
        await uploadFile(s, `${dir}/deploy/docker-compose.pop.yml`, popOverride, "644");
        sections.push(`## PoP config\nWrote deploy/.env (mode 600) + deploy/docker-compose.pop.yml (redis replicaof ${a.coreRedisHost}, edge → ${a.objectStore}). Secrets kept off this transcript.`);

        const up = await s.exec(`${tmPopCompose(dir)} up -d redis edge varnish purge-bridge 2>&1`, { timeoutMs: a.timeoutSeconds * 1000 });
        sections.push(`## Bring-up (exit ${up.code})\n${redactSecrets(lastLines(up.stdout, 20))}`);
        if (up.code !== 0) return sections.join("\n\n") + `\n\nPoP bring-up FAILED — see above (tm_logs).`;

        // verify the redis replication link to the core is up
        const repl = await s.exec(`${tmPopCompose(dir)} exec -T redis redis-cli info replication 2>/dev/null | tr -d '\\r'`, { timeoutMs: 30_000 });
        const role = (repl.stdout.match(/role:(\w+)/) || [])[1] ?? "?";
        const link = (repl.stdout.match(/master_link_status:(\w+)/) || [])[1] ?? "?";
        const replOk = role === "slave" && link === "up";
        sections.push(`## Redis replication\nrole=${role} master_link_status=${link} → ${replOk ? "replicating the core's pointers + purge ✅" : "NOT linked — check coreRedisHost reachability + the core redis bind/protected-mode"}`);

        const gate = await s.exec(popHealthGate(120), { timeoutMs: 150_000 });
        sections.push(`## Health gate\n${gate.stdout.trim()}`);
        sections.push(
          `## DNS / CDN — add these to cut traffic in\n` +
            `  1. Point a regional CDN behavior (or the PoP's hostname) at this host: edge :8585 behind varnish :8080 (front with TLS — deploy/nginx.conf).\n` +
            `  2. Cache rules: /a/* immutable (max-age=31536000), /c/* + config 60s + stale-while-revalidate. Strip Set-Cookie (cookieless delivery).\n` +
            `  3. Only route real traffic here AFTER edge /healthz is 200 and a synthetic /c/<id>/<env>.js + /a/<id>/<hash>.js fetch succeed through varnish.\n` +
            `  4. The PoP cold-fills from the central object store on first miss and never mutates truth — it is purely additive.`
        );
        return sections.join("\n\n");
      });
    },
  },
];
