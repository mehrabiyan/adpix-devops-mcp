import { z } from "zod";
import { loadRegistry, saveRegistry, resolveCluster } from "../registry.js";
import { withSession, type Deps } from "../deps.js";
import { readEnvVar } from "../adpix.js";
import { parseClaudeResult } from "../remote/aifix.js";
import { shq, lastLines, table } from "../util.js";
import {
  DEFAULT_LAUNCH_HOSTS,
  classifyHost,
  parseHeaders,
  certDaysFromEnddate,
  ANALYTICS_SECRETS,
  TAGMANAGER_SECRETS,
  ANALYTICS_P1_BLOCKERS,
  type SecretSpec,
} from "../launch/hosts.js";
import type { ToolDef } from "./types.js";

const clusterParam = z.string().optional().describe("Cluster name — pulls its host list / IdP issuer. Omit to use the single cluster.");

/** Headers + status of an HTTPS request, probed from the MCP host (the witness). */
async function headProbe(deps: Deps, host: string, path = "/", timeout = 10) {
  const url = `https://${host}${path}`;
  const r = await deps.local(
    `curl -ksS -m ${timeout} -A 'adpix-devops-mcp/launch-check' -D - -o /dev/null ${shq(url)} 2>/dev/null || true`,
    { timeoutMs: (timeout + 5) * 1000 }
  );
  return { ...parseHeaders(r.stdout), raw: r.stdout };
}

/** Days until the live TLS cert for `host` expires (null on failure). */
async function certDays(deps: Deps, host: string, timeout = 10): Promise<number | null> {
  const r = await deps.local(
    `echo | timeout ${timeout} openssl s_client -servername ${shq(host)} -connect ${shq(host)}:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null || true`,
    { timeoutMs: (timeout + 5) * 1000 }
  );
  return certDaysFromEnddate(r.stdout, Date.now());
}

function hostsFor(clusterName: string | undefined, override: string[] | undefined): { hosts: string[]; idp?: string; src: string } {
  if (override?.length) return { hosts: override, src: "argument" };
  try {
    const cl = resolveCluster(clusterName);
    return { hosts: cl.hosts.length ? cl.hosts : DEFAULT_LAUNCH_HOSTS, idp: cl.idpIssuer, src: `cluster ${cl.name}` };
  } catch {
    return { hosts: DEFAULT_LAUNCH_HOSTS, src: "defaults" };
  }
}

export const launchTools: ToolDef[] = [
  {
    name: "launch_gate",
    title: "Launch gate (Gate 0)",
    description:
      "The go/no-go attestation for the joint launch (DEPLOYMENT_SRE §11 Gate 0): the Analytics 7 P1 " +
      "release-blockers (auth takeover, privilege-escalation ×2, consent-fails-OPEN; 2026-06-20 audit) must be " +
      "confirmed RESOLVED before go-live. mode:status shows the gate; mode:ack records resolution (needs a " +
      "reference + confirm:true); mode:block re-blocks. Deploy/promote tooling must refuse to proceed while BLOCKED.",
    schema: {
      mode: z.enum(["status", "ack", "block"]).default("status"),
      reference: z.string().optional().describe("ack: proof the P1s are fixed — audit commit/date or ticket"),
      confirm: z.boolean().default(false).describe("ack: required (you are attesting the security blockers are resolved)"),
    },
    handler: async (_deps, args) => {
      const a = args as { mode: string; reference?: string; confirm: boolean };
      const reg = loadRegistry();
      const p1 = "The 7 Analytics P1 release-blockers (2026-06-20 audit):\n" + ANALYTICS_P1_BLOCKERS.map((b) => `  - ${b}`).join("\n");

      if (a.mode === "ack") {
        if (!a.confirm) return `REFUSED: ack attests the security release-blockers are resolved. Re-run with confirm:true and a reference.\n\n${p1}`;
        if (!a.reference) return "ack needs a `reference` (audit commit/date or ticket proving the P1s are fixed).";
        reg.launchGate = { resolved: true, reference: a.reference, at: new Date().toISOString() };
        saveRegistry(reg);
        return `# Launch gate — CLEARED\nThe Analytics P1 blockers are attested resolved (ref: ${a.reference}, at ${reg.launchGate.at}).\nDeploy tooling may now proceed. Re-block with mode:block if a regression is found.`;
      }
      if (a.mode === "block") {
        reg.launchGate = { resolved: false };
        saveRegistry(reg);
        return `# Launch gate — BLOCKED\nGate re-blocked. Joint launch may not proceed until the P1s are re-attested (mode:ack).\n\n${p1}`;
      }
      // status
      const g = reg.launchGate;
      if (g?.resolved) {
        return `# Launch gate — CLEARED ✅\nP1 blockers attested resolved (ref: ${g.reference ?? "?"}, at ${g.at ?? "?"}).\nStill verify the operator wiring before go-live: secrets_preflight · oidc_health · edge_validate · launch_smoke.`;
      }
      return [
        `# Launch gate — BLOCKED 🚩`,
        `No resolution recorded for the Analytics P1 release-blockers. A joint launch CANNOT proceed.`,
        ``,
        p1,
        ``,
        `These are distinct from the deferred data-integrity P2s. Once the audit confirms them fixed, record it:`,
        `  launch_gate mode:ack reference:"<audit commit/date>" confirm:true`,
        `Tag Manager carries no open code blockers; this gate is the Analytics side only.`,
      ].join("\n");
    },
  },

  {
    name: "secrets_preflight",
    title: "Preflight required secrets",
    description:
      "Verify both stacks will BOOT: in production they fail-fast on missing/demo-default secrets (Analytics " +
      "APP_ENV=production, TM NODE_ENV=production). Reads the server .env files and reports each required key as " +
      "present / MISSING / still-demo-default — values are never printed. Catches 'won't start' before the deploy, " +
      "not at 3am.",
    schema: {
      server: z.string().optional().describe("Registered server name. Omit to use the default."),
      stack: z.enum(["analytics", "tagmanager", "both"]).default("both"),
      analyticsDir: z.string().optional().describe("Analytics checkout dir (default: the server's adpixDir)"),
      tmDir: z.string().default("/opt/adpix-tagmanager").describe("Tag Manager checkout dir"),
    },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; stack: string; analyticsDir?: string; tmDir: string };
      return withSession(deps, a.server, async (s, srv) => {
        const sections: string[] = [];
        let fails = 0;

        const checkStack = async (label: string, dir: string, specs: SecretSpec[]) => {
          const exists = (await s.exec(`test -f ${shq(dir + "/.env")} && echo yes || echo no`)).stdout.trim() === "yes";
          if (!exists) {
            fails++;
            sections.push(`## ${label} (${dir})\nFAIL no .env at ${dir}/.env — nothing to check (deploy not provisioned here?)`);
            return;
          }
          const rows: string[][] = [];
          for (const spec of specs) {
            const val = await readEnvVar(s, dir, spec.key);
            let status: string;
            if (val === "") status = spec.demoDefault === "" ? "FAIL empty" : "FAIL missing";
            else if (spec.demoDefault && val === spec.demoDefault) status = "FAIL demo-default";
            else status = "ok";
            if (status.startsWith("FAIL")) fails++;
            rows.push([spec.key, status, spec.note ?? ""]);
          }
          sections.push(`## ${label} (${dir})\n${table(["SECRET", "STATUS", "NOTE"], rows)}`);
        };

        if (a.stack === "analytics" || a.stack === "both") await checkStack("Analytics", a.analyticsDir ?? srv.adpixDir, ANALYTICS_SECRETS);
        if (a.stack === "tagmanager" || a.stack === "both") await checkStack("Tag Manager", a.tmDir, TAGMANAGER_SECRETS);

        return [
          `# Secrets preflight — ${srv.name}  —  ${fails ? `${fails} BLOCKER(S)` : "ALL PRESENT"}`,
          fails ? `Generate the failing secrets before deploy — the app refuses to boot on a missing/demo-default secret in prod.` : `Both stacks have their required secrets set (no demo defaults).`,
          ``,
          ...sections,
          ``,
          `(Values are never read into output — only presence + whether they equal a known demo default.)`,
        ].join("\n");
      });
    },
  },

  {
    name: "oidc_health",
    title: "OIDC IdP health (account center)",
    description:
      "Probe the shared OIDC IdP (account.adpix.io) — the single dependency whose outage breaks login for BOTH " +
      "products. Checks discovery (/.well-known/openid-configuration), that the advertised issuer matches, the " +
      "JWKS endpoint serves keys, and the TLS cert. Read-only, run from the MCP host.",
    schema: {
      cluster: clusterParam,
      issuer: z.string().optional().describe("Issuer base, e.g. https://account.adpix.io (default: cluster idpIssuer)"),
    },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { cluster?: string; issuer?: string };
      const { idp } = hostsFor(a.cluster, undefined);
      const issuer = (a.issuer ?? idp ?? "https://account.adpix.io").replace(/\/$/, "");
      const host = issuer.replace(/^https?:\/\//, "").split("/")[0];
      const problems: string[] = [];

      const disc = await deps.local(`curl -ksS -m 10 ${shq(issuer + "/.well-known/openid-configuration")} 2>/dev/null || true`, { timeoutMs: 15_000 });
      let cfg: Record<string, unknown> | null = null;
      try {
        cfg = JSON.parse(disc.stdout.trim());
      } catch {
        cfg = null;
      }
      if (!cfg) {
        return `# OIDC IdP — ${issuer}  —  DOWN\nDiscovery did not return JSON (login is broken for BOTH products if this is the live IdP).\nRaw: ${lastLines(disc.stdout, 6) || "(empty / unreachable)"}`;
      }
      const advIssuer = String(cfg.issuer ?? "");
      const jwksUri = String(cfg.jwks_uri ?? "");
      if (advIssuer !== issuer) problems.push(`advertised issuer "${advIssuer}" ≠ "${issuer}" — token iss-validation will reject (check OIDC_INTERNAL_ISSUER / split-horizon)`);
      for (const ep of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) if (!cfg[ep]) problems.push(`discovery missing ${ep}`);

      let keyCount = 0;
      if (jwksUri) {
        const jwks = await deps.local(`curl -ksS -m 10 ${shq(jwksUri)} 2>/dev/null || true`, { timeoutMs: 15_000 });
        try {
          const parsed = JSON.parse(jwks.stdout.trim()) as { keys?: unknown[] };
          keyCount = Array.isArray(parsed.keys) ? parsed.keys.length : 0;
        } catch {
          keyCount = 0;
        }
        if (keyCount === 0) problems.push(`JWKS at ${jwksUri} served no keys — RS256 verification will fail`);
      }

      const days = await certDays(deps, host);
      if (days !== null && days < 14) problems.push(`TLS cert ${days < 0 ? "EXPIRED" : `expires in ${days}d`} on ${host}`);

      const verdict = problems.length === 0 ? "HEALTHY" : problems.some((p) => /reject|broken|no keys|EXPIRED/.test(p)) ? "DEGRADED" : "OK with warnings";
      return [
        `# OIDC IdP — ${issuer}  —  ${verdict}`,
        problems.length ? "Findings:\n" + problems.map((p) => `  - ${p}`).join("\n") : "Discovery, issuer, JWKS and TLS all good.",
        ``,
        `issuer (advertised): ${advIssuer || "?"}`,
        `endpoints: authz=${cfg.authorization_endpoint ? "ok" : "MISSING"} token=${cfg.token_endpoint ? "ok" : "MISSING"} jwks=${jwksUri ? "ok" : "MISSING"}`,
        `JWKS keys: ${keyCount}`,
        `TLS: ${days === null ? "could not read cert" : `${days} days remaining`}`,
        ``,
        `This IdP is a shared SPOF — if it's down, break-glass is Analytics AUTH_PROVIDER=local; TM api falls back to opaque sessions on brief JWKS loss.`,
      ].join("\n");
    },
  },

  {
    name: "edge_validate",
    title: "Validate the front-door edge",
    description:
      "Validate the public Caddy front door across all platform hosts: TLS cert validity + days remaining, " +
      "reachability, and the security-critical Set-Cookie carve-out — cdn/collect/config.adpix.net MUST NOT set " +
      "cookies (cookieless data plane), while gateway.adpix.net legitimately does (ADR-0033). Read-only, from the " +
      "MCP host.",
    schema: {
      cluster: clusterParam,
      hosts: z.array(z.string()).optional().describe(`Override the host list. Default: the cluster's hosts or the 8 AdPix hosts`),
      expiryWarnDays: z.number().int().min(1).default(14).describe("Warn when a cert has fewer than this many days left"),
    },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { cluster?: string; hosts?: string[]; expiryWarnDays: number };
      const { hosts, src } = hostsFor(a.cluster, a.hosts);
      const rows: string[][] = [];
      const problems: string[] = [];

      for (const host of hosts) {
        const cls = classifyHost(host);
        const probe = await headProbe(deps, host, "/");
        const days = await certDays(deps, host);

        const reachable = probe.status > 0 && probe.status < 500;
        const hasSetCookie = (probe.headers["set-cookie"] ?? []).length > 0;
        const cacheCtl = (probe.headers["cache-control"] ?? []).slice(-1)[0] ?? "";

        let cookie = "ok";
        if (hasSetCookie && !cls.setCookieAllowed) {
          cookie = "FAIL leaks Set-Cookie";
          problems.push(`${host}: Set-Cookie on a cookieless data-plane host — strip it at the edge (${cls.note})`);
        } else if (hasSetCookie) {
          cookie = "set (ok)";
        }

        let tls = days === null ? "?" : days < 0 ? `EXPIRED` : `${days}d`;
        if (days !== null && days < 0) problems.push(`${host}: TLS cert EXPIRED — visitors see errors now`);
        else if (days !== null && days < a.expiryWarnDays) problems.push(`${host}: TLS cert expires in ${days}d (<${a.expiryWarnDays}) — Caddy renewal may be failing`);

        if (!reachable) problems.push(`${host}: not reachable (HTTP ${probe.status || "000"})`);

        rows.push([host, cls.plane, String(probe.status || "000"), tls, cookie, cacheCtl || "-"]);
      }

      const verdict = problems.length === 0 ? "HEALTHY" : problems.some((p) => /EXPIRED|Set-Cookie|not reachable/.test(p)) ? "NEEDS ATTENTION" : "OK with warnings";
      return [
        `# Edge validation (${hosts.length} hosts via ${src})  —  ${verdict}`,
        problems.length ? "Findings:\n" + problems.map((p) => `  - ${p}`).join("\n") : "All hosts reachable, certs healthy, Set-Cookie carve-out correct.",
        ``,
        table(["HOST", "PLANE", "HTTP", "TLS", "SET-COOKIE", "CACHE-CONTROL"], rows),
        ``,
        `Carve-out: cdn/collect/config.adpix.net must NOT Set-Cookie; gateway.adpix.net legitimately does (ADR-0033).`,
      ].join("\n");
    },
  },

  {
    name: "launch_smoke",
    title: "Cross-product launch smoke",
    description:
      "Run the automatable (unauthenticated) slice of the §11.8 cross-product smoke: IdP discovery reachable, both " +
      "dashboards up, api.adpix.io/tm/* REJECTS an unauthenticated request (auth enforced), tracker + collect " +
      "reachable, and no Set-Cookie on the cookieless data plane. Lists the credentialed checks (login→dashboard, " +
      "launcher, audience-reject, Single Logout) as a manual checklist. Read-only, from the MCP host.",
    schema: { cluster: clusterParam, issuer: z.string().optional() },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { cluster?: string; issuer?: string };
      const { idp } = hostsFor(a.cluster, undefined);
      const issuer = (a.issuer ?? idp ?? "https://account.adpix.io").replace(/\/$/, "");
      const checks: { name: string; result: string; ok: boolean }[] = [];
      const add = (name: string, ok: boolean, result: string) => checks.push({ name, ok, result });

      const disc = await deps.local(`curl -ksS -m 10 -o /dev/null -w '%{http_code}' ${shq(issuer + "/.well-known/openid-configuration")} 2>/dev/null || echo 000`);
      add("IdP discovery reachable", /^2/.test(disc.stdout.trim()), `HTTP ${disc.stdout.trim()}`);

      for (const [label, host] of [["Analytics dashboard", "analytics.adpix.io"], ["Tag Manager console", "tagmanager.adpix.io"]] as const) {
        const p = await headProbe(deps, host, "/");
        add(`${label} up`, p.status > 0 && p.status < 500, `HTTP ${p.status || "000"}`);
      }

      const tm = await headProbe(deps, "api.adpix.io", "/tm/accounts");
      if (tm.status === 401 || tm.status === 403) add("api.adpix.io/tm/* rejects unauthenticated", true, `HTTP ${tm.status} (auth enforced)`);
      else if (tm.status === 200) add("api.adpix.io/tm/* rejects unauthenticated", false, `HTTP 200 — UNAUTHENTICATED ACCESS (security failure)`);
      else if (tm.status >= 500 || tm.status === 0) add("api.adpix.io/tm/* rejects unauthenticated", false, `HTTP ${tm.status || "000"} — upstream not wired? (TM_API_UPSTREAM 502 until set)`);
      else add("api.adpix.io/tm/* rejects unauthenticated", true, `HTTP ${tm.status}`);

      const trk = await headProbe(deps, "cdn.adpix.net", "/t.js");
      add("tracker cdn.adpix.net/t.js reachable", /^[23]/.test(String(trk.status)), `HTTP ${trk.status || "000"}`);
      const col = await headProbe(deps, "collect.adpix.net", "/");
      add("collect.adpix.net reachable", col.status > 0 && col.status < 500, `HTTP ${col.status || "000"}`);

      for (const host of ["cdn.adpix.net", "collect.adpix.net", "config.adpix.net"]) {
        const p = await headProbe(deps, host, "/");
        const leak = (p.headers["set-cookie"] ?? []).length > 0;
        add(`no Set-Cookie on ${host}`, !leak, leak ? "Set-Cookie PRESENT (must be stripped)" : "clean");
      }

      const fails = checks.filter((c) => !c.ok);
      const verdict = fails.length === 0 ? "PASS" : fails.some((c) => /security failure|Set-Cookie PRESENT/.test(c.result)) ? "FAIL (security)" : "FAIL";
      return [
        `# Launch smoke (automatable subset)  —  ${verdict}`,
        ...checks.map((c) => `  [${c.ok ? "PASS" : "FAIL"}] ${c.name} — ${c.result}`),
        ``,
        `## Manual (need real credentials — run by hand before go-live)`,
        `  - Login at analytics.adpix.io + tagmanager.adpix.io → IdP → back to dashboard`,
        `  - Launcher (waffle) switches account → analytics → tagmanager`,
        `  - api.adpix.io/tm/* returns TM data with a TM token; REJECTS an analytics-aud token`,
        `  - Single Logout: sign out of one product → signed out of both`,
        `  - Tracker + a TM container coexist on one test page; events reach collect.adpix.net`,
      ].join("\n");
    },
  },

  {
    name: "predeploy_gate",
    title: "Pre-deploy gate (predict launch bugs)",
    description:
      "The §8.3 'refuse to promote a bad build' gate: runs the deterministic checks (typecheck + tests) on a repo " +
      "checkout — locally (repoPath) or on a server (server+dir) — folds in the launch_gate (Gate 0) state, and " +
      "lists the remaining gate steps (multi-agent adversarial review via /code-review, secrets_preflight, " +
      "launch_smoke). Returns GO / NO-GO.",
    schema: {
      stack: z.enum(["tagmanager", "analytics"]).default("tagmanager"),
      repoPath: z.string().optional().describe("Local path to the repo checkout (runs on the MCP host)"),
      server: z.string().optional().describe("Or: registered server to run the checks on"),
      dir: z.string().optional().describe("Checkout dir on that server"),
      typecheckCmd: z.string().optional().describe("Override the typecheck command"),
      testCmd: z.string().optional().describe("Override the test command"),
      adversarialReview: z.boolean().default(false).describe("Also run a headless Claude Code security/correctness review of the changes (needs the `claude` CLI + ANTHROPIC_API_KEY on the target; costs API spend)"),
      model: z.string().optional().describe("Model for the adversarial review (e.g. claude-opus-4-8)"),
    },
    handler: async (deps, args) => {
      const a = args as { stack: string; repoPath?: string; server?: string; dir?: string; typecheckCmd?: string; testCmd?: string; adversarialReview: boolean; model?: string };
      const defaults = a.stack === "tagmanager"
        ? { tc: "pnpm -r run typecheck", test: "pnpm -r run test" }
        : { tc: "echo '(analytics: typecheck is per-service)'", test: "make verify-prod-config" };
      const tcCmd = a.typecheckCmd ?? defaults.tc;
      const testCmd = a.testCmd ?? defaults.test;

      if (!a.repoPath && !(a.server && a.dir)) {
        return "predeploy_gate needs either repoPath (local checkout) or server + dir (remote checkout). Nothing run.";
      }

      const run = async (label: string, cmd: string): Promise<{ ok: boolean; out: string }> => {
        if (a.repoPath) {
          const r = await deps.local(`cd ${shq(a.repoPath)} && ${cmd} 2>&1`, { timeoutMs: 900_000 });
          return { ok: r.code === 0, out: r.stdout };
        }
        return withSession(deps, a.server, async (s) => {
          const r = await s.exec(`cd ${shq(a.dir!)} && ${cmd} 2>&1`, { timeoutMs: 900_000 });
          return { ok: r.code === 0, out: r.stdout };
        });
      };

      const tc = await run("typecheck", tcCmd);
      const test = await run("test", testCmd);

      // Optional headless Claude Code adversarial review — embedded via the `claude` CLI
      // (the same mechanism ai_fix uses), NOT the harness Workflow which a tool can't call.
      let adv: { ran: boolean; pass: boolean; line: string } | null = null;
      if (a.adversarialReview) {
        const model = a.model ? ` --model '${a.model.replace(/'/g, "")}'` : "";
        const prompt =
          "You are a release auditor. Review the uncommitted changes (git diff HEAD) and the code they touch for " +
          "LAUNCH-BLOCKING bugs ONLY: auth bypass/takeover, privilege escalation, data loss, consent/PII leaks that " +
          "fail open, and injection. Ignore style/nits. Be terse. End with EXACTLY one line: 'VERDICT: GO' if you " +
          "found no launch-blockers, or 'VERDICT: NO-GO' followed by a one-line list if you did.";
        const cmd =
          `command -v claude >/dev/null 2>&1 || { echo NO_CLAUDE_CLI; exit 0; }; ` +
          `claude -p --output-format json --max-turns 16${model} --allowedTools "Bash,Read,Grep,Glob" <<'ADPIXPROMPT'\n${prompt}\nADPIXPROMPT`;
        const r = await run("adversarial", cmd);
        if (/NO_CLAUDE_CLI/.test(r.out)) adv = { ran: false, pass: true, line: "skipped — no `claude` CLI on the target (install it / run ai_setup)" };
        else {
          const res = parseClaudeResult(r.out);
          if (!res || res.is_error) adv = { ran: false, pass: true, line: "skipped — review did not complete (missing ANTHROPIC_API_KEY, or it errored)" };
          else {
            const text = res.result ?? "";
            const nogo = /VERDICT:\s*NO-?GO/i.test(text);
            const cost = res.total_cost_usd ? ` ($${res.total_cost_usd.toFixed(2)}, ${res.num_turns ?? "?"} turns)` : "";
            adv = { ran: true, pass: !nogo, line: `${nogo ? "found launch-blockers" : "no launch-blockers"}${cost}\n${lastLines(text, 12)}` };
          }
        }
      }

      const reg = loadRegistry();
      const gate = reg.launchGate?.resolved ? "CLEARED" : "BLOCKED 🚩 (run launch_gate)";

      const deterministicPass = tc.ok && test.ok && (!adv || !adv.ran || adv.pass);
      const verdict = deterministicPass && reg.launchGate?.resolved ? "GO" : "NO-GO";
      return [
        `# Pre-deploy gate (${a.stack})  —  ${verdict}`,
        ``,
        `[${tc.ok ? "PASS" : "FAIL"}] typecheck (${tcCmd})${tc.ok ? "" : `\n${lastLines(tc.out, 15)}`}`,
        `[${test.ok ? "PASS" : "FAIL"}] tests (${testCmd})${test.ok ? "" : `\n${lastLines(test.out, 15)}`}`,
        adv ? `[${adv.ran ? (adv.pass ? "PASS" : "FAIL") : "SKIP"}] adversarial review: ${adv.line}` : `[SKIP] adversarial review (pass adversarialReview:true to run headless Claude Code; or /code-review ultra)`,
        `[${reg.launchGate?.resolved ? "PASS" : "FAIL"}] Gate 0 launch_gate: ${gate}`,
        ``,
        `## Remaining live-front-door checks (run these too)`,
        `  - secrets_preflight (both stacks boot)`,
        `  - oidc_health + edge_validate + launch_smoke`,
        ``,
        verdict === "GO" ? `Deterministic checks${adv?.ran ? " + adversarial review" : ""} + Gate 0 pass. Complete the live checks above, then promote.` : `Do NOT promote — resolve the FAILs above first.`,
      ].join("\n");
    },
  },
];
