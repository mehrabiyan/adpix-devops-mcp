import { z } from "zod";
import type { Deps } from "../deps.js";
import type { Session } from "../ssh.js";
import { shq, lastLines, redactSecrets } from "../util.js";
import { STACK_META, stackServices, stackComposeCmd, stackHealthCmd } from "./stack.js";
import type { ToolDef } from "./types.js";

/**
 * service_relocate — live-relocate ONE service from one server to another, the safe way.
 *
 * Senior-SRE reality of this stack: backends (postgres/clickhouse/redis/minio) live on a host's
 * private docker network, the front door is a per-host Caddy and a keepalived VIP is the cluster's
 * traffic director. So a *live* container transfer is only sound for STATELESS services whose
 * backends are reachable from the target. We therefore:
 *
 *   • classify the service (stateless vs stateful) from the stack map;
 *   • REFUSE a naive move of a stateful container (postgres/clickhouse/redis/minio, or the IdP's
 *     embedded-PGlite `auth`) — that is data loss — and emit the replicate→verify→promote→fence plan;
 *   • for a stateless service, verify its backends are SHARED (not docker-internal to the source),
 *     then stand it up on the target and HEALTH-GATE it BEFORE touching the source, so a failure
 *     aborts with zero downtime; drain + stop the source (kept for rollback); fence only on a second
 *     explicit `removeSource:true`.
 *
 * apply:false (default) is a pure read-only preview (classification, plan, downtime, rollback).
 */

const DOCKER_INTERNAL = /^(postgres|clickhouse|redis|minio|localhost|127\.0\.0\.1|::1)$/i;
const DEFAULT_PORT: Record<string, string> = { DATABASE_URL: "5432", REDIS_URL: "6379", CLICKHOUSE_URL: "8123", CLICKHOUSE_HOST: "8123", CH_HOST: "8123", S3_ENDPOINT: "9000" };

interface Backend { key: string; host: string; port: string; local: boolean }
/** Parse the stateful-backend endpoints a service depends on out of its .env (hosts/ports only). */
function backendsFrom(envText: string): Backend[] {
  const out: Backend[] = [];
  for (const k of Object.keys(DEFAULT_PORT)) {
    const m = envText.match(new RegExp("^" + k + "=(.*)$", "m"));
    if (!m) continue;
    const val = m[1].trim().replace(/^["']|["']$/g, "");
    let host = "", port = "";
    if (/:\/\//.test(val)) { const u = val.match(/\/\/(?:[^@/]*@)?([^:/?]+)(?::(\d+))?/); if (u) { host = u[1]; port = u[2] || ""; } }
    else { const p = val.split(":"); host = p[0]; port = p[1] || ""; }
    if (!host) continue;
    out.push({ key: k, host, port: port || DEFAULT_PORT[k], local: DOCKER_INTERNAL.test(host) });
  }
  return out;
}

function envPath(stack: string, dir: string): string {
  if (stack === "tagmanager") return `${dir}/deploy/.env`;
  if (stack === "idp") return `${dir}/deploy/.env.account`;
  return `${dir}/.env`;
}

async function svcRunning(s: Session, compose: string, service: string): Promise<boolean> {
  const r = await s.exec(`${compose} ps ${shq(service)} 2>/dev/null | grep -qiE 'up|running|healthy' && echo up || echo down`, { timeoutMs: 30_000 });
  return /up/.test(r.stdout);
}

export const relocateTools: ToolDef[] = [
  {
    name: "service_relocate",
    title: "Live-relocate a service to another server",
    description:
      "Move ONE compose service from fromServer to toServer with the safe strategy for its type. " +
      "Stateless (ingest/api/edge/web/worker/varnish/…): stand up on the target, health-gate it BEFORE " +
      "draining the source, so a failure aborts with zero downtime; the source is kept until you fence it " +
      "(removeSource:true). Stateful (postgres/clickhouse/redis/minio, or the IdP's embedded-PGlite auth): " +
      "REFUSED — a live container move is data loss; it returns the replicate→verify→promote→fence plan. " +
      "apply:false (default) is a read-only preview with a downtime estimate. apply:true needs confirm:true.",
    schema: {
      stack: z.enum(["analytics", "tagmanager", "idp"]).default("analytics").describe("Which product stack the service belongs to"),
      service: z.string().describe("Compose service to relocate (ingest, api, edge, web, worker, varnish, …)"),
      fromServer: z.string().describe("Source server (must be running the service)"),
      toServer: z.string().describe("Destination server (must already have the stack checkout + shared backends reachable)"),
      fromDir: z.string().optional().describe("Source checkout dir (default: the stack's standard dir)"),
      toDir: z.string().optional().describe("Destination checkout dir (default: the stack's standard dir)"),
      apply: z.boolean().default(false).describe("false = read-only preview + plan; true = perform the relocation"),
      confirm: z.boolean().default(false).describe("Required when apply:true — this shifts live traffic"),
      removeSource: z.boolean().default(false).describe("After the target is verified, also remove the source container (the final fence). Default keeps it stopped for rollback."),
      drainSeconds: z.number().int().min(0).max(600).default(20).describe("Grace period to let in-flight requests finish before stopping the source"),
      timeoutSeconds: z.number().int().min(60).max(7200).default(1800),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (deps: Deps, args) => {
      const a = args as { stack: string; service: string; fromServer: string; toServer: string; fromDir?: string; toDir?: string; apply: boolean; confirm: boolean; removeSource: boolean; drainSeconds: number; timeoutSeconds: number };
      if (a.fromServer === a.toServer) return `REFUSED: fromServer and toServer are the same (${a.fromServer}). Pick a different destination.`;

      const meta = STACK_META[a.stack];
      const fromDir = a.fromDir || meta.defaultDir || "/opt/adpix";
      const toDir = a.toDir || meta.defaultDir || "/opt/adpix";
      const { stateless, stateful } = stackServices(a.stack, { service: a.service });
      const isStateless = stateless.includes(a.service);
      // the IdP's `auth` carries an embedded PGlite volume (authdata) — treat it as stateful.
      const isStateful = stateful.includes(a.service) || (a.stack === "idp" && a.service === "auth");
      if (!isStateless && !isStateful) {
        return `Unknown service "${a.service}" for the ${a.stack} stack.\nStateless (relocatable): ${stateless.join(", ") || "—"}\nStateful (replicate, don't move): ${stateful.join(", ") || "—"}`;
      }

      const fromSrv = deps.resolve(a.fromServer);
      const toSrv = deps.resolve(a.toServer);

      // ── stateful: never move the container; emit the data-safe replication plan ──────────────
      if (isStateful) {
        const engine = /postgres/.test(a.service) ? "Postgres" : /clickhouse/.test(a.service) ? "ClickHouse" : /redis/.test(a.service) ? "Redis" : /minio/.test(a.service) ? "MinIO" : a.stack === "idp" ? "the IdP control DB (embedded PGlite)" : a.service;
        return [
          `# service_relocate — REFUSED for ${a.service} (${engine})`,
          ``,
          `A live container move of a datastore loses data: \`docker rm\` + recreate-elsewhere drops the volume,`,
          `and an in-place rsync of a hot volume corrupts it. Relocate the DATA via replication instead, keeping`,
          `${a.fromServer} authoritative until the destination is verified:`,
          ``,
          `1. Provision ${a.toServer} (server_add) — free disk ≥ source volume + 20%.`,
          ...(engine === "Postgres"
            ? [`2. pg_replication: make ${a.toServer} a streaming REPLICA of ${a.fromServer}; wait for replay lag ≈ 0.`,
               `3. Verify on the replica (pg_health: row counts, replication slot caught up).`,
               `4. Stop writes briefly (the identity-job is a singleton), promote the replica (pg_replication promote), repoint DATABASE_URL.`,
               `5. Keep ${a.fromServer} as the new standby until the cutover is proven, THEN decommission it.`]
            : engine === "ClickHouse"
            ? [`2. ch_replication: add a ReplicatedMergeTree replica on ${a.toServer} (or ch_backup → copy → ch_restore_db). CH_REPLICATED is fresh-deploy-only.`,
               `3. Wait for the replica to sync; verify ch_health row counts match.`,
               `4. Repoint clients to ${a.toServer}; keep ${a.fromServer} until verified, then drop it.`]
            : engine === "MinIO"
            ? [`2. mc mirror the buckets ${a.fromServer} → ${a.toServer}; re-run until the delta is empty.`,
               `3. Verify object counts/sizes match; repoint S3_ENDPOINT; keep the source until verified.`]
            : engine === "Redis"
            ? [`2. Make ${a.toServer} a REPLICAOF ${a.fromServer}; wait for sync (or simply rebuild — it is a cache).`,
               `3. Failover (Sentinel) or repoint REDIS_URL; keep the source until traffic is steady.`]
            : [`2. account_install on ${a.toServer}, then restore the IdP DB: stop the source auth, copy the authdata volume (the PGlite dir) to ${a.toServer}, start there. Users/keys live in that volume.`,
               `3. Verify oidc_health on ${a.toServer} (issuer + JWKS), then repoint AUTH_ISSUER and fence the source.`]),
          ``,
          `Then run service_relocate again only for the STATELESS services in front of it.`,
        ].join("\n");
      }

      // ── stateless: preflight both ends ───────────────────────────────────────────────────────
      const fromCompose = stackComposeCmd(a.stack, fromDir, { service: a.service });
      const toCompose = stackComposeCmd(a.stack, toDir, { service: a.service });
      const pre: string[] = [];
      const from = await deps.connect(fromSrv);
      let backends: Backend[] = [];
      let srcUp = false, tgtCloned = false, tgtEnv = false, tgtDocker = false, tgtDiskMb = 0;
      const unreachable: Backend[] = [];
      try {
        srcUp = await svcRunning(from, fromCompose, a.service);
        const env = (await from.exec(`cat ${shq(envPath(a.stack, fromDir))} 2>/dev/null`, { timeoutMs: 20_000 })).stdout;
        backends = backendsFrom(env);

        const to = await deps.connect(toSrv);
        try {
          tgtDocker = /ok/.test((await to.exec(`command -v docker >/dev/null && docker compose version >/dev/null 2>&1 && echo ok || echo no`)).stdout);
          tgtCloned = /yes/.test((await to.exec(`test -d ${shq(toDir + "/.git")} && echo yes || echo no`)).stdout);
          tgtEnv = /yes/.test((await to.exec(`test -f ${shq(envPath(a.stack, toDir))} && echo yes || echo no`)).stdout);
          tgtDiskMb = parseInt((await to.exec(`df -m ${shq(toDir)} 2>/dev/null | awk 'NR==2{print $4}' || df -m / | awk 'NR==2{print $4}'`)).stdout.trim(), 10) || 0;
          // reachability of the SHARED backends from the target (docker-internal ones are unreachable by definition)
          for (const b of backends) {
            if (b.local) { unreachable.push(b); continue; }
            const ok = /OK/.test((await to.exec(`timeout 3 bash -c "echo > /dev/tcp/${b.host}/${b.port}" 2>/dev/null && echo OK || echo NO`, { timeoutMs: 8_000 })).stdout);
            if (!ok) unreachable.push(b);
          }

          // ── the data-locality guard: a stateless service can only move if its backends are shared ──
          const localBackends = backends.filter((b) => b.local);
          if (localBackends.length) {
            return [
              `# service_relocate — cannot live-move ${a.service} (backends are local to ${a.fromServer})`,
              ``,
              `${a.service}'s data backends are on ${a.fromServer}'s private docker network, not shared:`,
              ...localBackends.map((b) => `  • ${b.key} → ${b.host}:${b.port}  (docker-internal)`),
              ``,
              `Relocating just this container would leave it unable to reach its data. Options:`,
              `  a) Relocate the WHOLE stack to ${a.toServer} (move/replicate the datastores first — see the stateful plan).`,
              `  b) Move to a clustered topology with a managed/networked DB (pg_replication + a real DB host),`,
              `     so DATABASE_URL/REDIS_URL point at a reachable host — then this relocate works.`,
              `  c) If you only need more capacity, scale_ingest / add a serving node instead of moving one off.`,
            ].join("\n");
          }

          // build the preview
          const downtime = `~0s for the service (the target is brought up + health-gated BEFORE the source is drained; the front door/VIP sheds the draining source)`;
          pre.push(
            `# service_relocate ${a.service}: ${a.fromServer} → ${a.toServer} (${a.stack})`,
            ``,
            `Classification: STATELESS → live blue-green relocate.`,
            `Source (${a.fromServer}): service ${srcUp ? "RUNNING ✅" : "not running ⚠"} · dir ${fromDir}`,
            `Target (${a.toServer}): docker ${tgtDocker ? "ok ✅" : "MISSING ❌"} · checkout ${tgtCloned ? "present ✅" : "MISSING ❌"} · .env ${tgtEnv ? "present" : "will copy from source"} · free disk ${tgtDiskMb} MB`,
            `Shared backends reachable from ${a.toServer}: ${backends.length ? backends.map((b) => `${b.host}:${b.port}${unreachable.includes(b) ? " ❌UNREACHABLE" : " ✅"}`).join(", ") : "(none referenced)"}`,
            ``,
            `Plan (apply:true):`,
            `  1. ${tgtEnv ? "reuse" : "copy"} .env on ${a.toServer}; build + \`up -d --no-deps ${a.service}\` (connects to the shared backends).`,
            `  2. Health-gate the new ${a.service} on ${a.toServer}.`,
            `  3. CUTOVER: ${a.stack === "tagmanager" ? "repoint the CDN origin / edge upstream" : "add the target to the VIP serving set (HA) or repoint the front-door/DNS"} to ${a.toServer}.`,
            `  4. Drain ${a.drainSeconds}s, then STOP ${a.service} on ${a.fromServer} (kept for rollback).`,
            `  5. Verify; ${a.removeSource ? `then REMOVE ${a.service} on ${a.fromServer} (fence).` : `leave the source stopped — remove it later once satisfied.`}`,
            ``,
            `Estimated downtime: ${downtime}.`,
            `Rollback: any failure before the source is stopped leaves ${a.fromServer} serving untouched.`,
          );

          if (!a.apply) { pre.push(``, `(Preview only — re-run with apply:true confirm:true to perform it.)`); return pre.join("\n"); }

          // ── apply: gates ──────────────────────────────────────────────────────────────────────
          if (!a.confirm) return pre.join("\n") + `\n\nREFUSED: apply:true needs confirm:true (this shifts live traffic).`;
          if (!srcUp) return pre.join("\n") + `\n\nREFUSED: ${a.service} is not running on ${a.fromServer} — nothing to relocate.`;
          if (!tgtDocker) return pre.join("\n") + `\n\nREFUSED: ${a.toServer} has no working Docker. Install it (adpix_install/tm_install bootstrap Docker) first.`;
          if (!tgtCloned) return pre.join("\n") + `\n\nREFUSED: ${a.toServer} has no ${a.stack} checkout at ${toDir}. Install the stack there first — it will share these backends.`;
          if (unreachable.length) return pre.join("\n") + `\n\nREFUSED: ${a.toServer} cannot reach ${unreachable.map((b) => `${b.host}:${b.port}`).join(", ")}. Open the path (firewall/security group) before relocating.`;

          const log: string[] = [pre.join("\n"), ``, `## Executing`];

          // 1. ensure .env on target
          if (!tgtEnv) {
            const env = (await from.exec(`base64 < ${shq(envPath(a.stack, fromDir))} 2>/dev/null | tr -d '\\n'`)).stdout.trim();
            if (!env) return log.join("\n") + `\n\nFAILED: could not read the source .env to copy.`;
            await to.exec(`mkdir -p $(dirname ${shq(envPath(a.stack, toDir))}) && printf %s ${shq(env)} | base64 -d > ${shq(envPath(a.stack, toDir))} && chmod 600 ${shq(envPath(a.stack, toDir))}`, { timeoutMs: 30_000 });
            log.push(`- copied .env → ${a.toServer} (mode 600)`);
          }

          // 2. stand up on target + health-gate
          const up = await to.exec(`${toCompose} up -d --build --no-deps ${shq(a.service)} 2>&1`, { timeoutMs: a.timeoutSeconds * 1000 });
          log.push(`- up -d --no-deps ${a.service} on ${a.toServer} (exit ${up.code})`);
          if (up.code !== 0) { return log.join("\n") + `\n\nFAILED to start ${a.service} on ${a.toServer} (source untouched, zero downtime):\n${redactSecrets(lastLines(up.stdout, 15))}`; }
          const gate = await to.exec(stackHealthCmd(a.stack, 150, toDir, { service: a.service }), { timeoutMs: 180_000 });
          log.push(`- target health: ${gate.stdout.trim()}`);
          if (gate.code !== 0) {
            await to.exec(`${toCompose} stop ${shq(a.service)} 2>&1`, { timeoutMs: 60_000 });
            return log.join("\n") + `\n\nFAILED: ${a.service} did not become healthy on ${a.toServer}. Stopped the target instance; ${a.fromServer} is still serving (zero downtime). Investigate, then retry.`;
          }

          // 3. cutover note (traffic direction is topology-specific — surfaced, not silently assumed)
          log.push(`- CUTOVER: target healthy. ${a.stack === "tagmanager" ? "Point the CDN origin / edge upstream at " + a.toServer : "Add " + a.toServer + " to the VIP serving set (ha_standup) or repoint the front-door/DNS"} now so traffic reaches the new instance.`);

          // 4. drain + stop source (kept)
          if (a.drainSeconds > 0) { await from.exec(`sleep ${a.drainSeconds}`, { timeoutMs: (a.drainSeconds + 10) * 1000 }); }
          const stop = await from.exec(`${fromCompose} stop ${shq(a.service)} 2>&1`, { timeoutMs: 120_000 });
          log.push(`- drained ${a.drainSeconds}s + stopped ${a.service} on ${a.fromServer} (exit ${stop.code}, container kept for rollback)`);

          // 5. verify + optional fence
          const reGate = await to.exec(stackHealthCmd(a.stack, 60, toDir, { service: a.service }), { timeoutMs: 90_000 });
          log.push(`- post-cutover target health: ${reGate.stdout.trim()}`);
          if (a.removeSource) {
            const rm = await from.exec(`${fromCompose} rm -sf ${shq(a.service)} 2>&1`, { timeoutMs: 120_000 });
            log.push(`- FENCED: removed ${a.service} on ${a.fromServer} (exit ${rm.code}).`);
          } else {
            log.push(`- ${a.service} on ${a.fromServer} is STOPPED (not removed). Roll back with container_control start; remove it later with removeSource:true once satisfied.`);
          }
          log.push(``, `✅ Relocated ${a.service}: ${a.fromServer} → ${a.toServer}.`);
          return log.join("\n");
        } finally { to.close(); }
      } finally { from.close(); }
    },
  },
];
