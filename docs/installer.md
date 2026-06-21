# Installer — spec + implementation notes (advanced server + client setup)

Status: **IMPLEMENTED (M0–M6).** A visual interactive installer that stands up the hosted
MCP, onboards the whole fleet, and emits the DNS plan + client connect configs — both a
shell TUI and a hardened web wizard. Code: `src/install/*` (Node core), `src/wizard/*`
(web wizard), `scripts/adpix-setup.sh` + `scripts/wizard/ui.sh` (shell TUI). Tested in
`test/{knownhosts,install,install-generators,install-steps,install-lifecycle,wizard}.test.ts`.

Decisions locked (from review): **(1)** Node install core + a thin bash bootstrap (both
front-ends drive one TypeScript core, fully unit-testable). **(2)** Authorize the MCP key
as a *restricted* root key (`from="<cidr>",restrict`) and *prominently offer* a
least-privilege scoped-sudo user; auto-authorize on by default, per-target opt-out.
**(3)** Ship the shell TUI first; the web wizard (full security model) is v1.1.

## 0. The load-bearing idea
Do not build a forward-only script with UIs bolted on. Build a **declarative
install-state ledger + reconcile core** — a recorded desired-vs-actual record of every
resource the installer owns — and make the two front-ends and the generators thin
renderers/editors of it. This one primitive turns idempotency, resume, uninstall,
rollback, dry-run, "what-changed", and end-to-end verify into the same model. The
current `install-server.sh` "grep the file to see if I was here" approach is exactly why
those are otherwise ad-hoc or absent.

## 1. Architecture
```
front-ends:  shell TUI wizard (gum + ANSI fallback)   |   web wizard (v1.1, loopback + SSH-forward)
                     both fill ONE InstallAnswers + a SEPARATE Secrets bag
core:        install-state ledger + reconcile engine (detect -> plan -> apply -> verify -> journal)
                     wraps (never reinvents) scripts/install-server.sh
                     reuses registry shapes (server_add/cluster_define), src/ssh.ts, the github.ts key idiom
generators:  DNS plan  ·  client-connect  ·  end-to-end verify
```
The bash entrypoint stays pure for `curl … | sudo bash`; it builds + invokes the Node
core (`node dist/install/cli.js`). The shell TUI is gum over the Node core; the web
wizard is `src/wizard/server.ts` over the *same* core — so shell and web produce
byte-identical results.

## 2. Install-state ledger + reconcile (build FIRST)
- `/var/lib/adpix-devops-mcp/install-state.json` (mode 600). Names every owned resource —
  packages, service user, dirs, the MCP SSH identity, env keys, systemd units, sudoers,
  a **delimited Caddy managed-block** (`# >>> adpix BEGIN/END`, replace-in-place; today's
  grep-guard breaks when the domain changes), ufw rules, registry entries, **per-target
  authorized-key status**, and **host-key pins** — each `{desired, actual, lastApplied}`.
  **Never stores secrets.** Atomic writes (temp + rename).
- Engine: ordered `InstallStep { id, isDone(ctx), apply(ctx), verify(ctx) }`. Skip-if-done
  unless `--force`; hard-fail aborts; per-target soft-fail continues; journal *before*
  declaring success → exact resume. A partial run (5 servers, 2 authorized, abort)
  re-runs to completion without redoing finished work.
- Free consequences: `--dry-run` (print the full resource diff, mutate nothing),
  `--rollback` (keep prior commit + prior `dist`; atomic `current -> release` flip-back),
  `--uninstall` / `--purge`, and a machine-readable "what changed" JSON.

## 3. Input model
- **`InstallAnswers`** (loggable, secret-free): `mcp{domain?,port=8930,bindHost,tokenMode,
  repoUrl?,branch?,apiKeyMode}` · `fleet[]{name,host,port=22,username='root',role,
  adpixDir='/opt/adpix',webhookUrl?,authorizeKey=true,bootstrapAuth}` ·
  `cluster?{name,vip?,idpIssuer='https://account.adpix.io',hosts=DEFAULT_LAUNCH_HOSTS}` ·
  `launchGate?` · `emit{clients[],dnsPlan}` · `resume`.
- **`Secrets` bag** (separate; never journaled, never in `servers.json`, never argv):
  `{mcpAuthToken?, anthropicApiKey?, perTarget:{name:{password?|pastedKey?|passphrase?}}}`.
  A typed wrapper whose `toString/toJSON/util.inspect` redact to `***`. Enters via
  stdin/env/form-body only.
- Registry discipline preserved: stores **key paths, never bytes**; passwords env-only;
  merge-not-clobber on re-run (never drops hand-added servers/clusters/`launchGate`).

## 4. Core steps (each idempotent: isDone -> apply -> verify, journaled)
1. **host-install** — isDone: `/healthz`==ok + token present; else exec `install-server.sh`
   (unchanged, idempotent, token-preserving) with answers→env. Reuses its phases 1–9.
2. **identity** — read the MCP `id_ed25519.pub` (phase 2 generated it).
3. **gather→registry** — upsert `servers{}`/`clusters{}`/`launchGate` in the exact
   `server_add`/`cluster_define` shapes (`privateKeyPath` = the MCP identity path).
4. **verify-SSH** — per target: connect via the MCP key, `server_add`-style probe; soft-fail.
5. **authorize-key** — per target with `authorizeKey:true`: open a **bootstrap** session
   with the operator's *own* credential (NOT the MCP key), append the MCP pubkey
   idempotently **with restrictions**, then **verify by reconnecting with the MCP key only**.
6. **emit** — DNS plan + client configs + end-to-end verify.

## 5. Shell TUI wizard (v1) — `scripts/wizard/`
gum-driven with a pure-ANSI fallback; `NO_COLOR`/non-TTY/`--answers-file` paths so it is
never *required* (CI / `curl|bash`). Screens: **S1** preflight checklist (root? Ubuntu?
ports 80/443? egress?) → **S2** MCP host (Domain+HTTPS vs HTTP; API key) → **S3** fleet
loop (add-server card + live SSH test) → **S4** HA cluster (multi-select witness/nodes +
VIP) → **S5** DNS plan table → **S6** review (every secret masked to a fingerprint) →
**S7** install with a live progress tree → **S8** final cards (connect URL + masked token,
DNS plan, per-target authorized ✓).

## 6. Web wizard (v1.1) — `sudo adpix-mcp-setup`
Binds **127.0.0.1 only**, prints `ssh -N -L 8931:127.0.0.1:8931 root@<server>` + a
tokenized URL; admin reaches it through the forward. Six pages mirror the TUI with live
validation (SSH test, `dig`, port reachability) and auto-shutdown.

### 6.1 Security hard requirements (non-negotiable — from the adversarial review)
1. **Loopback-only bind**; refuse non-loopback unless BOTH `--wizard-tls` and explicit
   `--bind`; verify the *resolved* socket is loopback at listen time.
2. **Token in the URL `#fragment`, never `?t=`** (query leaks to history/`Referer`/logs);
   client JS moves it to a request header + `history.replaceState` scrub.
3. Token = CSPRNG ≥256-bit, **single-use** (burn on exchange), constant-time compare,
   in-memory only, fresh per launch, no static fallback.
4. **Header-token on every state-changing request; no cookies.** Require
   `Content-Type: application/json`; reject simple content types.
5. **Strict `Host` allowlist** (anti-DNS-rebind) — accept only `127.0.0.1:8931`/
   `localhost:8931`, reject all else.
6. **`Origin`/`Sec-Fetch` same-origin enforce**; reject cross-site / `no-cors` mutations.
7. Headers: `CSP default-src 'self'; frame-ancestors 'none'`, `X-Frame-Options DENY`,
   `Referrer-Policy no-referrer`, `Cache-Control no-store`, `nosniff`.
8. **Dual lifetime kill** (short idle + absolute-max, non-disableable) + auto-shutdown on
   finish; **zeroize the Secrets bag** on exit. Not a journaled service; `umask 077`;
   core dumps off (`RLIMIT_CORE=0`, `PR_SET_DUMPABLE=0`).
9. **Pasted bootstrap keys are transient** — `0600` in operator-owned tmpfs, used once,
   deleted/zeroized; never readable by `adpixmcp`, never stored as `privateKeyPath`.
10. **Authorized-key restriction:** append with `from="<mcp-host-cidr>",restrict`
    (+ `command=` where feasible); offer the least-priv scoped-sudo user; atomic,
    match-full-key, preserve existing entries, `0600` backup.
11. **Host-key verification (fixes a real gap, see §10):** bootstrap TOFU-captures the
    target host key, **shows the fingerprint for admin confirm**, pins it, and the
    verify-reconnect requires the pin (mismatch aborts).
12. **Verify reconnect uses the MCP key only** (`IdentitiesOnly`, agent+password disabled);
    no fallback to the operator session (else a failed authorize reports success).
13. **Client configs carry the fleet-root Bearer** → `0600`, delivered as a `no-store`
    download (not DOM), warn + support rotation.
14. **Fail-closed everywhere** — any missing token / bad Host / Origin / host-key mismatch
    / expired session / failed verify ⇒ refuse + abort, never silently degrade.

## 7. Generators
- **DNS plan** (`src/install/dns.ts` + an MCP `dns_plan` tool): `classifyHost()` →
  control-plane `*.adpix.io` A/AAAA → the **VIP**; data-plane `*.adpix.net` → CDN origin
  (proxied); `mcp.<domain>` → this host. Output: a record table
  (NAME/TYPE/VALUE/TTL/PROXIED/ZONE), a copy-paste **BIND snippet**, provider notes
  (Cloudflare/Route53/ArvanCloud), and a **`dig` verify loop** (re-check until they
  resolve — Caddy needs them for ACME). Plan-only (no provider API token).
- **Client connect** (`src/install/connect.ts` + a `connect_configs` tool): the
  `claude mcp add --transport http` one-liner · Desktop `claude_desktop_config.json` block
  · generic MCP JSON · an SSH-tunnel variant for HTTP/loopback mode · token reveal-once.

## 8. End-to-end verification (the install gate — not just `curl /healthz`)
Automated: external reachability through Caddy/TLS (cert issued, SNI) · a **real MCP
handshake** (`initialize` + `tools/list` with the Bearer through the *public* URL) · SSH
to each target with the generated identity · DNS resolution of the 9 hosts · VIP failover
smoke. "A client actually connects" is a probe, not a printed command.

## 9. Scope tiers
- **v1:** ledger + reconcile core · shell TUI · DNS + connect generators · end-to-end
  verify · uninstall/`--revoke`/`--rollback`/`--dry-run` · the `ssh.ts` host-key fix.
- **v1.1:** web wizard (full §6 security model).
- **later:** multi-cluster · registry import/adopt · IPv6/AAAA + dual-stack bind ·
  air-gapped/offline bundle (mirror NodeSource/npm/Caddy, DNS-01/internal-CA TLS) ·
  non-Ubuntu targets · i18n · provider DNS auto-apply · `MCP_AUTH_TOKEN` rotation command
  (re-emits configs) · `flock` concurrency guard.

## 10. Prerequisite bug to fix first (M0)
`src/ssh.ts::connect()` passes **no `hostVerifier`** to ssh2 — the MCP performs **zero
host-key verification** on every target connection today (worse than TOFU; MITM-able).
M0 adds a real `hostVerifier` with a pinned `known_hosts` (TOFU + confirm + pin), used by
both the existing tools and the installer's bootstrap/verify steps.

## 11. File layout
```
src/install/{answers.ts, core.ts, journal.ts, dns.ts, connect.ts, verify.ts, cli.ts}
src/install/steps/{01-host-install,02-identity,03-gather-registry,04-verify-ssh,05-authorize-key,06-emit}.ts
src/tools/{dns_plan.ts, connect_configs.ts}        # also surfaced as MCP tools
scripts/wizard/{adpix-setup.sh, lib/ui.sh}          # shell TUI (gum + ANSI)
src/wizard/{server.ts, api.ts, pages/*}             # web wizard (v1.1)
test/install.test.ts                                 # ledger + steps + generators (Deps seam)
docs/installer.md                                    # this file
```

## 12. Milestones (each ships standalone value)
- **M0** — `ssh.ts` host-key verification + tests.
- **M1** — ledger + reconcile + `InstallAnswers`/`Secrets` model (pure, fully tested).
- **M2** — the 6 core steps wrapping `install-server.sh` + registry + verify + authorize.
- **M3** — DNS + connect generators + end-to-end verify.
- **M4** — shell TUI wizard.
- **M5** — uninstall / `--revoke` / `--rollback` / `--dry-run`.
- **M6** (v1.1) — web wizard with the §6 security model.

## 13. Remaining open decisions
- gum apt-repo at wizard time vs pure-ANSI-only (proposed: gum default + ANSI fallback).
- Where operator-facing client configs persist: `/etc/adpix-devops-mcp/connect/` (root,
  matches the env file) vs an admin-chosen path (web download).
- Whether the service obtains `ADPIX_SSH_PASSPHRASE` at runtime (systemd `LoadCredential`)
  or the service identity is mandated passphraseless (simpler; proposed).
- DNS plan stays plan-only vs a future `mode:apply` via a provider API token.
