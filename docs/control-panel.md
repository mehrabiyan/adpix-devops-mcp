# AdPix Control Panel — design spec

Status: **Phases 1–3 IMPLEMENTED.** Backend job engine + panel server + the "AdPix Cloud" SPA
(Phase 1), the security spine (Phase 2: login + TOTP, RBAC, re-auth nonces, hash-chained
audit, kill-switch), and the Phase-3 ops tools are built (`src/panel/*`, `src/tools/ops.ts`,
`npm start -- --panel`). 76 tools, 396 tests. Remaining: the internet exposure transport
(OIDC/WebAuthn + mTLS — see §4) and the bespoke per-screen UI layouts (the generic tool-grid
already makes every tool usable). A self-service web control panel (cPanel / DigitalOcean-
style) over the MCP tools — manage the fleet, containers, backups, databases, deploys, HA,
DNS and clients from a UI, no CLI.

## Phase 2 — security spine (shipped)
- `auth.ts` — scrypt passwords + RFC-6238 TOTP (verified against the RFC vector). `admins.ts` (panel-admins.json, mode 600), `sessions.ts` (opaque server-side, idle 15m + absolute 8h, revocable, CSRF token per session).
- `access.ts` — dual auth: bootstrap TOKEN on loopback **until the first admin exists**, then per-admin SESSION cookie (HttpOnly, SameSite=Strict, `Secure` behind TLS) + double-submit CSRF + Origin checks; Host allowlist.
- `rbac.ts` — default-deny; viewer=read-only, operator=+ordinary mutating, owner=all; an OWNER_ONLY set (run_command, topology, security, restores, ops tools); tenant scopes gate the target.
- `nonce.ts` — per-action re-auth: destructive jobs require a single-use, TTL-bound nonce minted from `/api/preview` (anti-replay + anti-confused-deputy), replacing the bare `confirm:true`.
- `audit.ts` — append-only, hash-chained audit of every action (verifyChain detects tampering); off-host ship hook. `/api/admin/*` (owner-only): users, sessions, audit, kill-switch (break-glass: disables destructive ops + revokes all sessions).
- SPA: login + first-run setup (shows the TOTP secret once), account/logout, and an admin Settings screen (users/roles, sessions, audit viewer + chain badge, kill-switch).

## Phase 3 — ops tools (shipped, `src/tools/ops.ts`)
- `container_control` — per-service start/stop/restart/status (the gap beyond adpix_restart; stop/restart are confirm-gated, warn-on-interruption).
- `metrics_query` — PromQL read-through to the witness Prometheus (powers metric cards).
- `schedule_job` — recurring maintenance via systemd timers (whitelisted tasks: backup, patch-check; survives panel restarts).
- `server_resize` / `data_move` — **advisory** plans (vertical resize + volume migration are provider-specific / data-loss-risky, so they inspect + lay out the safe backup-first sequence rather than acting).

## Phase 1 — what shipped
- `src/panel/store.ts` — job ledger (`$ADPIX_DEVOPS_HOME/jobs.json`, atomic, mode 600, secret-redacted args).
- `src/panel/observed-deps.ts` — Deps decorator → redacted live logs + cooperative cancel for ALL tools, zero per-tool edits.
- `src/panel/engine.ts` — bounded worker pool, per-target mutex, idempotency keys, boot reconciliation (in-flight → interrupted), SSE event bus.
- `src/panel/catalog.ts` — catalog derived from `allTools` (groups + JSON-Schema params via zod-to-json-schema).
- `src/panel/server.ts` — node:http server reusing the wizard guard (Host allowlist, token header, Origin/Sec-Fetch, JSON-only); routes: `/api/catalog`, `POST /api/tools/:name` (read-only sync), `POST /api/jobs` (async + confirm-gate), `GET /api/jobs[/:id][/cancel|/stream(SSE)]`; serves the SPA.
- `src/panel/public/*` — the "AdPix Cloud" SPA (design tokens from the AdPix Design System): app shell + nav groups, dark/light, EN/FA + RTL, the live jobs/activity drawer with SSE log streaming, and a typed-confirm modal for destructive ops. Dashboard + Servers + Jobs are bespoke; every other nav section renders its group's tools as action cards with generic arg forms.
- Run: `node dist/index.js --panel [--port 8931]` → prints a `#token=…` URL; reach it via `ssh -L 8931:127.0.0.1:8931 <server>`. Loopback-only (binds 127.0.0.1).
- Tests: `test/panel.test.ts` (store, engine, catalog, live server + guard + jobs).

## 0. Feasibility — ~80% of the backend already exists
The 72 tools ARE the operations (the "verbs"). The panel is **auth + a job engine + an SPA**
over the same `ToolDef` registry `buildServer()` already loops over — not new ops logic. The
hard, genuinely-new parts are: an **async job engine** (tools are synchronous; real ops take
minutes), and the **internet-facing security** (a permanent root-over-the-fleet surface).

Security verdict from the review: **CONDITIONAL GO** — an always-on, internet-facing panel
with fleet-root power is a *fundamentally* higher risk than the one-shot loopback wizard.
Build it loopback-first; only expose it with the full hardening set (§4).

## 1. Architecture (4 layers)
```
SPA (React+Vite+shadcn, ~13 screens)
   │  /panel/api/*  (JSON, SSE)
panel API + JOB ENGINE  (src/panel/*)  ── decorates realDeps to stream live logs
   │  calls tool.handler(deps,args) UNCHANGED
allTools (72)  +  Deps seam  +  registry/ledger   ← all reused, unforked
```

### 1a. Panel API + job engine (`src/panel/*`) — the key new primitive
- **Two surfaces from `allTools`:** read-only tools (`readOnlyHint`) run **inline** (status/health/metrics); everything mutating/slow becomes an **async JOB**.
- `POST /api/jobs {tool,args,confirm,idempotencyKey}` → validates against the tool's **own Zod schema** (same shape `buildServer` registers) → enqueues → `202 + jobId`. Worker calls `tool.handler(realDeps,args)` exactly as `src/index.ts` does (same success/`ERROR (name)` wrapping).
- **Live progress for ALL 72 tools with zero per-tool edits:** an **observed-Deps decorator** wraps `realDeps` so every `exec`/`local` emits a redacted log line (via `redactSecrets`) to the job's ring buffer + SSE before delegating. All SSH traffic already funnels through the `Deps` seam, so this captures 100%.
- **Job store** = clone of `src/install/journal.ts` (atomic tmp+rename, mode 600, `$ADPIX_DEVOPS_HOME/jobs.json`): `{id,tool,args(redacted),status,key,startedAt,result,error,logTail[]}`. Never persists secret arg values.
- **Concurrency:** bounded pool + **per-target mutex** (`server|cluster:stack`) so two deploys to one host serialize; independent targets run in parallel. **Cancel** at exec boundaries via AbortSignal. **Idempotency keys** dedupe double-clicks. **Boot reconciliation:** in-flight jobs → `interrupted` (resumable, like the install ledger).
- Components: `panel/server.ts` (routes), `panel/engine.ts` (worker pool), `panel/store.ts` (job ledger), `panel/observed-deps.ts` (the decorator), `panel/sse.ts` (log stream). New `--panel` flag in `index.ts`.

### 1b. SPA (~13 screens)
Dashboard · Servers/Fleet · Server→Containers (start/stop/restart/logs) · Backups (list/create/restore/schedule) · Databases (PG+CH health/tune/optimize/retention/replication) · Deploys (update/rollback/blue-green/CI-CD) · High availability (topology + quorum + `ha_standup`) · DNS & connect · Monitoring · Jobs (live SSE + cancel) · Audit · Security · Settings. React+Vite+shadcn; the JobsDrawer + LogViewer + a typed-confirm DestructiveModal are the reusable spine.

### 1c. Auth + RBAC + audit + tenancy
OIDC to `account.adpix.io` (the discovery/JWKS/TLS half already exists in `oidc_health`) **+ WebAuthn MFA**, or local-admin+TOTP break-glass. Server-side sessions. RBAC default-deny mapping all 72 tools to roles (owner/operator/viewer) using the `readOnlyHint`/`destructiveHint` annotations as the floor; grants scoped to specific server/cluster names + tenants (an AdPix admin sees only their containers/backups). Hash-chained, append-only **audit** of every action shipped off-host.

## 2. Reuse map (panel feature → existing tool)
| Panel | Tool(s) |
|---|---|
| Dashboard | health_check · system_metrics · cluster_status · tls_status · watchdog_status |
| Servers / add node | server_add/list/remove · cluster_define · ha_standup |
| Containers | adpix_status/restart/logs · tm_status/restart/logs |
| Backups / restore | adpix_backup/restore · pg_backup/restore_db · ch_backup/restore_db |
| Deploys | adpix_update (auto-rollback) · bluegreen_deploy · cicd_* |
| Databases | pg_health/tune/optimize/harden/replication/redeploy · ch_* |
| HA | ha_standup · ha_quorum · pg_replication |
| DNS / clients | dns_plan · connect_configs |
| Security | security_audit · harden_server · patch_system · launch_gate |

## 3. Missing backend tools (build as needed)
Per-container **start/stop** (only restart exists today) · vertical **resize** · volume **move/migrate** · **metrics_query** (PromQL read-through — Prometheus already on the witness; `obs_status` only counts targets) · a **scheduler** (recurring backups/patching) · structured (JSON) tool output for charts (tools return text today).

## 4. Security — CONDITIONAL GO, the non-negotiables
A permanent internet-facing panel = fleet-root behind a browser. Required before any non-loopback exposure:
- **AuthN:** per-admin OIDC + **phishing-resistant MFA (WebAuthn/passkeys)**; no shared/static token; remove the empty-token allow path for non-loopback; per-account+IP backoff lockout.
- **Session:** opaque server-side, `__Host-` cookie HttpOnly+Secure+SameSite=Strict; never in URL/localStorage; regenerate on privilege change; idle 15m + absolute 8h; revocable.
- **RBAC server-side, default-deny on every request** (never trust the SPA to hide actions); authorize `resolveServer/resolveCluster` against the caller's grants; `run_command`/topology/security/AI tools owner-only.
- **Per-action re-auth for destructive ops:** replace the `confirm:true` boolean with a server-issued, single-use, short-TTL **action nonce** bound to (session, tool, target, args-hash), minted from the preview the operator just saw; **step-up MFA**; type-to-confirm the target name; anti-replay.
- **Audit immutability:** append-only, hash-chained, shipped to an off-host WORM sink the panel can't delete.
- **Secret isolation:** the panel holds NO keys/passwords; registry stays paths + env; DTOs whitelist non-secret fields; `redactSecrets` on ALL browser-bound output.
- **Network:** Tier-0, **not anonymously internet-facing** — mTLS client certs or WireGuard/Tailscale + IP allowlist; strict Host allowlist; HSTS-preload; egress-restricted to fleet SSH + Anthropic only; panel API and fleet-control MCP as separate least-priv processes over loopback.
- **Blast-radius:** maker-checker (two-person) for the top ops (topology change, node removal, pg_restore, security downgrade, key changes); a **kill-switch** to disable destructive tools + revoke all sessions; anomaly alerts.
- **Job engine:** `run_command`/arbitrary-exec are NEVER schedulable; destructive jobs default-deny + maker-checker; jobs run under the creator's RBAC re-validated at run time; strict CSP/Trusted-Types; pinned-lockfile SPA supply chain.

## 5. Recommended build path (loopback-first)
**Phase 1 — the panel, safe by construction (loopback + SSH tunnel, like the wizard):**
job engine (`src/panel/*`) + the observed-Deps live-log decorator + a single-admin session + the SPA MVP: Dashboard, Fleet/Containers (restart+logs), Backups (create/restore w/ typed-confirm), Deploys (update/rollback), DB (tune/retention dry-run→apply), DNS, Jobs (live SSE), Audit. **Zero or one new backend tool.** Reached via `ssh -L`, so the dangerous exposure is deferred.

**Phase 2 — internet-facing hardening:** OIDC + WebAuthn MFA, server-side RBAC + grants + tenancy, hash-chained off-host audit, per-action nonces + step-up, mTLS/WireGuard exposure, maker-checker, kill-switch.

**Phase 3 — the missing tools + polish:** per-container start/stop, resize, data-move, `metrics_query` + dashboard charts, the scheduler, notifications, multi-cluster/tenant.

## 6. Open decisions
- Dispatch: a thin `/panel/api/<tool>` calling `handler()` directly (simpler) vs speaking MCP to itself.
- Result format: add structured JSON output to tools vs parse the text in the UI (brittle).
- Panel process: same systemd as the MCP (one port) vs a separate service behind the same Caddy (recommended — decouples restarts + isolates blast radius).
- Metrics: on-server PromQL read-through (recommended) vs iframe Grafana (conflicts with `frame-ancestors 'none'`).
