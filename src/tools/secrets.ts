import { z } from "zod";
import { withSession } from "../deps.js";
import { shq, lastLines } from "../util.js";
import { readEnvVar } from "../adpix.js";
import { stackComposeCmd, stackServices, stackDir, stackHealthCmd } from "./stack.js";
import type { ToolDef } from "./types.js";

const serverParam = z.string().optional().describe("Target server name. Omit to use the default.");

// Classify a .env key → how it must be rotated. `auto` classes the tool rotates itself; the rest need
// a coordinated/stateful path (CH recreate, MinIO, IdP signing key, external provider) — reported, not
// auto-broken in v1. `derived` URLs (DATABASE_URL/REDIS_URL) are rewritten WITH their datastore password.
type Klass = "postgres" | "redis" | "self" | "clickhouse" | "object-store" | "signing" | "external" | "derived" | "plain";
function classify(key: string): Klass {
  const k = key.toUpperCase();
  if (k === "POSTGRES_PASSWORD") return "postgres";
  if (k === "REDIS_PASSWORD") return "redis";
  if (k === "DATABASE_URL" || k === "REDIS_URL") return "derived";
  if (/CLICKHOUSE_PASSWORD/.test(k)) return "clickhouse";
  if (/MINIO_ROOT_PASSWORD|MINIO_ROOT_USER|_SECRET_KEY$|_ACCESS_KEY$|^S3_/.test(k)) return "object-store";
  if (/PRIVATE_KEY|_PEM$|SIGNING/.test(k)) return "signing";
  if (/^SMTP|^BREVO|OIDC_CLIENT_SECRET|^MAIL_/.test(k)) return "external";
  if (/PASSWORD|SECRET|_KEY$|API_KEY|_TOKEN$|NONCE|SALT/.test(k)) return "self";
  return "plain";
}
const AUTO = new Set<Klass>(["postgres", "redis", "self"]);
const MANUAL_HINT: Record<string, string> = {
  clickhouse: "set CLICKHOUSE_PASSWORD in .env + `ch_redeploy` (CH auth is config, not SQL — recreates the CH container; data volume persists)",
  "object-store": "rotate the MinIO root/service creds at MinIO, update the *_ACCESS_KEY/*_SECRET_KEY in .env, then restart the consumers",
  signing: "regenerate the IdP signing key (new `kid`) + redeploy auth, then force global re-auth so old tokens are rejected (IR 1.1)",
  external: "rotate at the provider (SMTP/Brevo) or the IdP (OIDC client secret must match both sides), then update .env",
};

// One self-contained remote script per rotation. The new secret is generated ON the target, applied,
// written to .env, and NEVER echoed (only ROTATED/marker) — so it never transits the MCP.
const GEN = `openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | od -An -tx1 | tr -d ' \\n'`;
const setEnv = (key: string) => `grep -v '^${key}=' "$E" > "$E.t" && printf '${key}=%s\\n' "$NP" >> "$E.t" && mv "$E.t" "$E"`;

export const secretsTools: ToolDef[] = [
  {
    name: "secret_rotate",
    title: "Rotate stack secrets (Postgres/Redis/app) — secret never leaves the target",
    description:
      "Rotate exfiltrated secrets (IR 3.5). Dry-run by default: inventories the stack .env, classifies each " +
      "secret (redacted — never prints values), and shows the plan. With confirm:true it rotates the selected " +
      "keys: POSTGRES_PASSWORD (ALTER ROLE + rewrite DATABASE_URL), REDIS_PASSWORD (CONFIG SET + REWRITE), and " +
      "self-sourced app secrets (*_SECRET / API keys) — backs up .env, restarts stateless consumers, verifies " +
      "health. Each new value is generated AND applied entirely on the server, so the MCP never sees it. " +
      "ClickHouse/MinIO/IdP-signing-key/OIDC-client/SMTP are reported as assisted (they need a stateful recreate " +
      "or provider-side change) with exact steps — not auto-rotated. Pick keys with keys:[…] or scope.",
    schema: {
      server: serverParam,
      stack: z.enum(["analytics", "tagmanager", "account"]).default("analytics").describe("Which product stack's .env to rotate"),
      dir: z.string().optional().describe("Checkout dir (default: the stack's standard dir)"),
      keys: z.array(z.string()).optional().describe("Explicit .env keys to rotate (e.g. ['POSTGRES_PASSWORD','SERVER_API_KEY'])"),
      scope: z.enum(["self", "datastore", "all"]).optional().describe("Bulk-select instead of keys: self=app secrets only · datastore=Postgres+Redis · all=every auto-rotatable key"),
      confirm: z.boolean().default(false).describe("Execute the rotation (otherwise dry-run plan only)"),
      timeoutSeconds: z.number().int().min(60).max(1800).default(600),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; stack: "analytics" | "tagmanager" | "account"; dir?: string; keys?: string[]; scope?: "self" | "datastore" | "all"; confirm: boolean; timeoutSeconds: number };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = stackDir(srv, a.stack, a.dir);
        const compose = stackComposeCmd(a.stack, dir);
        const E = `${dir}/.env`;
        // verify the .env exists, then read key|length (redacted) — never values
        const inv = await s.exec(
          `test -f ${shq(E)} || { echo __NOENV__; exit 0; }; ` +
          `while IFS='=' read -r k v; do case "$k" in ''|'#'*) continue;; esac; printf '%s|%s\\n' "$k" "\${#v}"; done < ${shq(E)}`,
          { timeoutMs: 20_000 }
        );
        if (inv.stdout.includes("__NOENV__")) return `No .env at ${E} — is ${a.stack} installed in ${dir}? (Nothing to rotate.)`;
        const rows = inv.stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [k, len] = l.split("|"); return { key: k, len: parseInt(len, 10) || 0, klass: classify(k) }; });
        const secrets = rows.filter((r) => r.klass !== "plain" && r.klass !== "derived");
        const present = new Set(rows.map((r) => r.key));
        const datastoreKeys = stackServices(a.stack).stateful; // which datastores this stack actually has

        // ---- DRY RUN: inventory + plan ----
        if (!a.confirm) {
          const line = (r: { key: string; len: number; klass: Klass }) => {
            const auto = AUTO.has(r.klass) && (r.klass === "self" || datastoreKeys.includes(r.klass));
            const tag = auto ? "AUTO" : "assisted";
            const note = auto ? `rotate in place${r.klass === "postgres" ? " (+DATABASE_URL)" : r.klass === "redis" ? " (+REDIS_URL)" : ""}` : (MANUAL_HINT[r.klass] || "manual");
            return `  ${r.key.padEnd(26)} ${String(r.len ? r.len + "ch" : "EMPTY").padEnd(7)} [${tag}] ${note}`;
          };
          const autoKeys = secrets.filter((r) => AUTO.has(r.klass) && (r.klass === "self" || datastoreKeys.includes(r.klass))).map((r) => r.key);
          return [
            `# Secret rotation plan — ${a.stack} @ ${srv.name}:${dir}`,
            `${secrets.length} secret-bearing keys (values redacted; rotation generates + applies them on the server — the MCP never sees them).`,
            ``,
            secrets.map(line).join("\n") || "  (none found)",
            ``,
            `Auto-rotatable now: ${autoKeys.length ? autoKeys.join(", ") : "none"}.`,
            `Execute: secret_rotate stack=${a.stack} ${autoKeys.length ? `keys=[${autoKeys.slice(0, 3).map((k) => `"${k}"`).join(",")}${autoKeys.length > 3 ? ",…" : ""}] ` : ""}confirm:true  (or scope=self | datastore | all).`,
            `Assisted keys need their own path — see the notes above and docs/incident-prevention.md.`,
          ].join("\n");
        }

        // ---- EXECUTE ----
        // resolve the target key set
        let want: string[] = [];
        if (a.keys?.length) want = a.keys.filter((k) => present.has(k));
        else if (a.scope === "self") want = secrets.filter((r) => r.klass === "self").map((r) => r.key);
        else if (a.scope === "datastore") want = secrets.filter((r) => (r.klass === "postgres" || r.klass === "redis") && datastoreKeys.includes(r.klass)).map((r) => r.key);
        else if (a.scope === "all") want = secrets.filter((r) => AUTO.has(r.klass) && (r.klass === "self" || datastoreKeys.includes(r.klass))).map((r) => r.key);
        else return `REFUSED: pick what to rotate — keys:["KEY",…] or scope:"self"|"datastore"|"all". Run without confirm first to see the plan.`;

        const rotated: string[] = []; const skipped: string[] = []; const failed: string[] = [];
        // back up .env once (timestamped, 600)
        const bak = await s.exec(`B=${shq(E)}.bak-$(date -u +%Y%m%d-%H%M%S); cp ${shq(E)} "$B" && chmod 600 "$B" && echo "$B"`, { timeoutMs: 15_000 });
        const backup = bak.stdout.trim().split("\n").pop() || `${E}.bak`;

        for (const key of want) {
          const klass = classify(key);
          if (!(AUTO.has(klass) && (klass === "self" || datastoreKeys.includes(klass)))) { skipped.push(`${key} (${klass}: ${MANUAL_HINT[klass] || "manual"})`); continue; }
          let script = "";
          if (klass === "postgres") {
            const user = (await readEnvVar(s, dir, "POSTGRES_USER")) || "sovereign";
            script =
              `set -e; E=${shq(E)}; NP=$(${GEN}); ` +
              `${compose} exec -T postgres psql -U ${shq(user)} -v ON_ERROR_STOP=1 -c "ALTER ROLE \\"${user}\\" WITH PASSWORD '$NP'" >/dev/null && ` +
              `${setEnv("POSTGRES_PASSWORD")} && ` +
              // rewrite the password segment of any postgres URL: ://user:PASS@  ->  ://user:NP@
              `sed -i -E "s#(://[^:/@]+:)[^@]*@#\\1$NP@#g" "$E"; chmod 600 "$E"; echo ROTATED`;
          } else if (klass === "redis") {
            script =
              `set -e; E=${shq(E)}; NP=$(${GEN}); ` +
              `${compose} exec -T redis redis-cli CONFIG SET requirepass "$NP" >/dev/null && ` +
              `${compose} exec -T redis redis-cli -a "$NP" CONFIG REWRITE >/dev/null 2>&1 || true; ` +
              `${setEnv("REDIS_PASSWORD")} && ` +
              `sed -i -E "s#(redis://[^:@]*:)[^@]*@#\\1$NP@#g" "$E" 2>/dev/null || true; chmod 600 "$E"; echo ROTATED`;
          } else { // self
            script = `set -e; E=${shq(E)}; NP=$(${GEN}); ${setEnv(key)} && chmod 600 "$E"; echo ROTATED`;
          }
          const r = await s.exec(script, { timeoutMs: 60_000 });
          if (/ROTATED/.test(r.stdout) && r.code === 0) rotated.push(key);
          else { failed.push(`${key} — ${lastLines(r.stdout + r.stderr, 2)}`); }
        }

        // restart stateless consumers so they pick up the new .env, then health-gate
        let restart = "skipped (nothing rotated)"; let health = "";
        if (rotated.length) {
          const stateless = stackServices(a.stack).stateless.join(" ");
          const up = await s.exec(`${compose} up -d --no-deps ${stateless} 2>&1`, { timeoutMs: a.timeoutSeconds * 1000 });
          restart = up.code === 0 ? "stateless services recreated" : `restart exit ${up.code}:\n${lastLines(up.stdout, 6)}`;
          const hg = await s.exec(stackHealthCmd(a.stack, 60, dir), { timeoutMs: 120_000 });
          health = lastLines(hg.stdout, 4);
        }

        const signingRotated = want.some((k) => classify(k) === "signing");
        return [
          `# Secret rotation — ${a.stack} @ ${srv.name}`,
          `.env backed up → ${backup} (keep until verified).`,
          rotated.length ? `Rotated (${rotated.length}): ${rotated.join(", ")}` : `Rotated: none`,
          skipped.length ? `Assisted / skipped (need a coordinated path):\n  - ${skipped.join("\n  - ")}` : ``,
          failed.length ? `FAILED:\n  - ${failed.join("\n  - ")}\n  → restore: cp ${backup} ${E} && restart` : ``,
          `Restart: ${restart}`,
          health ? `Health: ${health}` : ``,
          signingRotated ? `⚠ A signing key was selected — after redeploy, force global re-auth so old tokens are rejected (IR 1.1).` : ``,
          rotated.length ? `Verify: stack_doctor / security_audit. If a consumer can't connect, restore the backup and re-run.` : ``,
        ].filter(Boolean).join("\n");
      });
    },
  },
];
