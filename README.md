# adpix-devops-mcp

An [MCP](https://modelcontextprotocol.io) server that acts as a **DevOps / SysAdmin / Site-Reliability engineer** for [AdPix Analytics](https://github.com/mehrabiyan/adpix). Connect it to Claude (Code / Desktop / any MCP client) and ask it to:

- **Install** AdPix on a fresh server — preflight checks, then AdPix's idempotent one-command deploy (Docker, secrets, build, migrations, automatic HTTPS via Caddy/Let's Encrypt). Three products: **Analytics**, **Tag Manager**, and the **Account/IdP** (a self-contained OIDC provider — embedded DB, auto Let's Encrypt front door)
- **Deploy the whole stack guided** — a 9-step **setup wizard** + a web **control panel** (AdPix Cloud) drive servers → GitHub keys → settings → preflight → deploy → verify → greenlight, over an SSH tunnel
- **Relocate live** — `service_relocate` moves a running service to another server: stateless blue-green (health-gate the target before draining the source, zero-downtime), stateful via replication (never a data-losing container move)
- **Maintain** it — safe updates (backup → pull → redeploy → health-gate → **auto-rollback** on failure), restarts, logs, backups, restores
- **Continuously deploy** the latest GitHub version — a pull-based CI/CD timer on the server ships every new commit through the same backup → deploy → health-gate → rollback pipeline, with webhook alerts and a deploy history
- **Monitor** security, uptime and loading speed — container + front-door health, system metrics, TTFB/TLS timing reports, certificate expiry, security audits
- **Keep it up 24/7** — installs an on-server **watchdog** (systemd timer) that checks every service each minute, auto-restarts anything unhealthy, records per-check uptime data, and fires webhook alerts on outage/recovery — protection that keeps running after you close your MCP client
- **Self-heal with AI** — when an outage survives auto-restarts (or you ask), headless **Claude Code** runs on the server under hard guardrails to diagnose and fix it; the hosted MCP service can even repair *itself* via a systemd OnFailure hook
- Reach servers over **SSH** as `root` or a passwordless-`sudo` user, with private keys that never leave the MCP host
- Run **locally over stdio** or **hosted on its own Ubuntu server** (HTTP transport + Bearer token, HTTPS via Caddy — one-line installer included)

## Quick start

Requires Node 18+ locally, and a target server running Ubuntu/Debian (2 GB RAM minimum, 4 GB recommended) that you can reach over SSH with a key.

**Claude Code**

```bash
claude mcp add adpix-devops -- npx -y github:mehrabiyan/adpix-devops-mcp
```

**Claude Desktop / other MCP clients** (`claude_desktop_config.json` or equivalent):

```json
{
  "mcpServers": {
    "adpix-devops": {
      "command": "npx",
      "args": ["-y", "github:mehrabiyan/adpix-devops-mcp"]
    }
  }
}
```

From a clone instead: `npm install && npm run build`, then point the client at `node /path/to/adpix-devops-mcp/dist/index.js`.

Then just talk to it:

> *"Add my server 203.0.113.7 (root, key ~/.ssh/id_ed25519) as `prod`, install AdPix on it with the domain analytics.example.com, harden the box, and set up the watchdog with alerts to my Slack webhook."*

…which walks through `server_add` → `adpix_install` → `harden_server` → `watchdog_install`.

> Connecting a client (Claude Code / Desktop / Cursor / hosted HTTP)? See the **[MCP client setup guide](docs/mcp-client-setup.md)**.

## Tools

**Servers**

| Tool | What it does |
| --- | --- |
| `server_add` | Register a server (verifies SSH, reports OS/Docker/AdPix state). Registry: `~/.adpix-devops/servers.json`, mode 600 |
| `server_list` / `server_remove` | Manage the registry |
| `run_command` | Raw shell escape hatch. Catastrophic patterns (`rm -rf /`, `mkfs`, `docker volume rm`, `DROP TABLE`, reboot…) are refused unless `confirm:true` |

**Install & lifecycle**

| Tool | What it does |
| --- | --- |
| `adpix_install` | Preflight (OS/RAM/disk/ports 80+443) → clone → `scripts/deploy.sh` (Docker, `.env` secrets, build, migrate) → health gate. Domain ⇒ automatic HTTPS; no domain ⇒ HTTP on the server IP. First run ≈ 10–25 min. **Private repo:** `deployKey:true` generates a read-only SSH deploy key on the server and prints the one line to add to GitHub |
| `adpix_update` | Backup → `git pull` → redeploy → health gate; **rolls back to the previous commit** if the stack doesn't come back healthy |
| `adpix_status` | Containers, deployed version, URL, Docker disk, watchdog state |
| `adpix_restart` | One service or the whole stack, then re-check health |
| `adpix_logs` | Tail/filter service logs (secrets redacted) |
| `adpix_backup` / `adpix_restore` | Postgres dump + ClickHouse export with manifest; restore requires `confirm:true` |

**Monitoring & speed**

| Tool | What it does |
| --- | --- |
| `health_check` | Container states + HTTP probes of the front door (ingest health, API, dashboard, tracker) through the real TLS path → HEALTHY / DEGRADED / DOWN |
| `system_metrics` | Load vs cores, memory, disk, per-container CPU/RAM, top processes — with hot-spot warnings |
| `performance_report` | Per-URL DNS / TLS / TTFB / total / transfer size over several runs, with fast/ok/slow verdicts |
| `tls_status` | Certificate issuer + days remaining; flags a failing Caddy renewal (<14 days left) |

**Security**

| Tool | What it does |
| --- | --- |
| `security_audit` | Read-only posture check: SSH config, firewall, publicly exposed ports (catches a dev stack leaking Postgres/ClickHouse), fail2ban, auto-updates, pending security patches, docker-published ports, `.env` perms, 24 h brute-force volume |
| `harden_server` | Applies the baseline: ufw (SSH/80/443 only — SSH allowed *before* enable), fail2ban sshd jail, unattended security upgrades, key-only SSH. **Dry-run by default**; refuses to disable password auth if your session used one |
| `patch_system` | apt updates (or security-only); reboots only with `autoReboot` **and** `confirm` |

**Uptime (24/7)**

| Tool | What it does |
| --- | --- |
| `watchdog_install` | Installs a systemd timer **on the server**: each interval it verifies every container + the front door (HTTP and HTTPS), auto-restarts unhealthy services, appends per-check records + incident JSONL, and POSTs `{"text": …}` webhook alerts (Slack/Discord/generic) on down/recovery. With `aiEscalate:true` it hands outages that survive restarts to Claude Code |
| `watchdog_status` | Timer schedule, last check, recent incidents |
| `uptime_report` | Uptime % per day computed from the watchdog's per-check records, plus the incident history (what broke, what got restarted, when it recovered) |

Watchdog data lives on the server under `/var/log/adpix-watchdog/` (`checks-YYYYMM.log`, `incidents.jsonl`, `state.json`).

**Continuous deployment (CI/CD)**

| Tool | What it does |
| --- | --- |
| `cicd_enable` | Pull-based CD on the server: a systemd timer polls GitHub (default every 5 min); when the tracked branch moves it runs **backup → reset to origin → deploy → health gate → automatic rollback**, alerts the webhook, and appends to a deploy history. Private repos get a dedicated **read-only deploy key** (the tool prints the exact GitHub setup). No SSH keys ever live in GitHub |
| `cicd_status` | Timer schedule, last pass result, commits behind origin, recent deploy/rollback history |
| `cicd_run_now` | Trigger a deploy pass immediately and wait for the outcome |
| `cicd_disable` | Stop auto-deploys (history kept; re-enable any time) |

Deploy history lives at `/var/log/adpix-autodeploy/deploys.jsonl`, full build logs next to it. Anything that lands on the tracked branch ships to production — protect the branch and let AdPix's CI gate merges. (AdPix also ships a push-based GitHub Actions workflow, `.github/workflows/deploy-vm.yml`, if you prefer GitHub-driven deploys.)

**AI self-healing (Claude Code)**

| Tool | What it does |
| --- | --- |
| `ai_setup` | Installs the Claude Code CLI on the server, stores the Anthropic API key in a root-only env file (`/etc/adpix-ai/env`, mode 600), and installs the escalation fixer (lockfile + 30-min cooldown so a flapping outage can't burn API spend) |
| `ai_fix` | Points headless Claude Code at a problem **on the server**: it gets the gathered evidence (containers, incidents, deploy history, resources, logs) plus hard guardrails — never delete volumes/databases/backups, never touch secrets, never push, least-invasive fix first, stop and report when unsure. `mode:"diagnose"` investigates without changing anything. Returns the report, turn count and cost; transcripts stay in `/var/log/adpix-ai/` |

Three escalation layers once `ai_setup` has run:
1. **On demand** — you (or Claude in chat) call `ai_fix`.
2. **Watchdog escalation** — `watchdog_install` with `aiEscalate:true`: when an outage survives auto-restarts for N consecutive checks (default 5), the watchdog launches the fixer once per outage and announces it on the webhook.
3. **MCP self-repair** (hosted mode) — if the MCP service itself crash-loops, systemd's `OnFailure` hook runs Claude Code against the MCP's own install dir (journal, recent git changes, rebuild, restart, verify `/healthz`) with a 60-min cooldown.

**Postgres DBA**

Full lifecycle management of the AdPix Postgres (the transactional truth). Acts on the live DB over SSH via `compose exec postgres psql` (local-trust socket, no password — the way `backup.sh` works), applying config with `ALTER SYSTEM` + reload. Pairs with the **`postgres-dba`** agent in the `adpix` repo. Co-location aware: on a single VM, Postgres gets a memory *budget* (~25%), never the whole host — ClickHouse needs the rest.

| Tool | What it does |
| --- | --- |
| `pg_health` | Read-only snapshot: version, size, connections vs max, cache hit ratio, blocked/idle-in-tx sessions, long queries, autovacuum freshness + dead-tuple bloat, txid-wraparound age, replication role/lag — with a verdict |
| `pg_tune` | pgtune-style recommendations from a memory budget + cores + disk type, diffed against live values; applies via `ALTER SYSTEM` + reload (dry-run by default; flags restart-needed settings) |
| `pg_optimize` | Unused/invalid indexes, seq-scan-heavy tables, dead-tuple bloat, top queries (`pg_stat_statements`); `apply:true` runs an online `VACUUM (ANALYZE)`. Index drops/REINDEX are advised, never auto-run |
| `pg_harden` | Security audit + fix (scram-sha-256, SSL posture, host-port exposure, superusers, passwordless roles, public-schema CREATE, logging, idle-tx timeout). Dry-run by default |
| `pg_backup` | On-demand **verified** logical backup: `pg_dump -Fc` + globals + `pg_restore --list` check, under `backups/pg-<ts>/` |
| `pg_restore_db` | Restore from a `pg_dump` (destructive, `confirm:true`); health-gates afterward |
| `pg_replication` | Streaming replication / HA: `status` · `prepare-primary` (wal_level/senders/slot/role/pg_hba) · `replica-steps` (the exact `pg_basebackup` commands) · `promote` (failover, `confirm:true`) |
| `pg_redeploy` | `reload` (zero-downtime) · `restart` · `recreate` · `upgrade-plan` (major-version dump-&-restore plan); backs up first + health-gates |

**ClickHouse DBA**

Full lifecycle management of the AdPix ClickHouse (the *analytical* truth — the opposite profile to Postgres: heavy, memory-hungry OLAP, and the disk/cost bottleneck at scale). Acts on the live DB over SSH via `compose exec clickhouse clickhouse-client`; the `default` user's password is read from the container's own `$CLICKHOUSE_PASSWORD` env so it **never crosses the wire** (ADR-0039). Knows AdPix's frozen `events_local` sort key, the `ReplacingMergeTree` dedup model, and the per-table retention TTLs. Pairs with the **`clickhouse-dba`** agent in the `adpix` repo. Co-location aware: on a single VM, ClickHouse gets the *lion's share* of RAM (~60%), Postgres ~25%.

| Tool | What it does |
| --- | --- |
| `ch_health` | Read-only snapshot: version, on-disk size, active parts + per-partition part pressure (merge backlog), largest tables with rows + compression ratio, in-flight merges + pending mutations, `ReplicatedMergeTree` status (read-only replicas, replication delay, queue), memory vs the server cap, long queries, recent errors — with a verdict |
| `ch_tune` | Analytical-workload recommendations from a memory budget + cores + disk; the headline is an **absolute `max_server_memory_usage` cap** (not the default ratio of total host RAM, which would starve Postgres). Diffs `system.server_settings`/`system.settings`; `apply:true` writes `config.d` + `users.d` drop-ins. Dry-run by default |
| `ch_optimize` | Part pressure (merge backlog), `ReplacingMergeTree` dedup debt, low compression ratios, top queries (`system.query_log`); `apply:true` runs `OPTIMIZE … FINAL` on **small** high-part tables only (size-capped so it never rewrites `events_local`) — and **only after a free-disk + in-flight-merge safety preflight** so it can't fill the disk or pile onto a busy merge pool on a live box. Big-table + projection work is advised |
| `ch_harden` | Read-only security posture: `default`-user password (prod must set `CLICKHOUSE_PASSWORD`), host-port exposure (CH stays internal-only), passwordless users, access-management grants, query logging, DoS-guard concurrency cap. Reports the out-of-band fixes (`.env`/compose/`ch_tune`) |
| `ch_backup` | On-demand **verified** Native export of the durable tables (`events_local`, `raw_events_jsonl` = the analytical rebuild source, `distinct_id_overrides`) + schema + a row-count MANIFEST, under `backups/ch-<ts>/`. Mirrors `scripts/backup.sh`; flags zero-byte exports |
| `ch_restore_db` | Restore tables from a `ch-<ts>` Native backup **safely**: load into a staging table → verify it came back non-empty → **atomic `EXCHANGE TABLES`** swap (live data is never destroyed before the restore is proven good; pre-restore data kept in `<table>__prev` for rollback). Refuses to swap on an empty/0-row backup; `confirm:true`; health-gates afterward |
| `ch_replication` | ReplicatedMergeTree + embedded Keeper (ADR-0042): `status` (read-only/delay/queue + Keeper reachability) · `enable-plan` (the fresh-deploy conversion path — `events_local` only converts on a clean replicated deploy) · `add-replica-steps` · `sync` (`SYSTEM SYNC REPLICA`, `confirm:true`) |
| `ch_retention` | The **disk cost lever**: `status` (partitions by month + size + current TTL) · `set-ttl` (`MODIFY TTL` to N months/days — **previews how many rows / % it would permanently delete before applying**, refuses to apply if it can't measure the impact, `confirm:true`) · `drop-partition` (**previews the partition's rows/size + verifies it exists** first, `confirm:true`). Knows each table's time column; `events_local` row shape stays frozen (TTL is metadata-only, ADR-0010) |
| `ch_redeploy` | `reload` (`SYSTEM RELOAD CONFIG`, zero-downtime) · `restart` · `recreate` (same `chdata` volume) · `upgrade-plan` (rolling image bump — CH's data dir is forward-compatible, no dump-&-restore). Snapshots schema first + waits for `/ping` + health-gates |

**Scaling & capacity consultation**

Advanced infrastructure advice grounded in AdPix's *real* seams (the Kafka transport with its Postgres-outbox backstop, the frozen tenant-leading ClickHouse sort key, ADR-0012's Flink swap), not generic cloud lore. Pairs with the **`infra-consultant`** agent in the `adpix` repo, which uses these tools and delegates execution to the planner/clickhouse-dba/go-reviewer.

| Tool | What it does |
| --- | --- |
| `capacity_plan` | Size a target scale (defaults to the 100k-sites projection): events/sec, ClickHouse shards + disk TB, ingest/worker replicas, Kafka partitions, Postgres, recommended stage + cost band — and the retention cost lever. Pure model, runs from any client (no server needed) |
| `scale_assessment` | Inspect the **live** system over SSH (current events/sec from ClickHouse, volume, on-disk size, host resources), report which of the 5 stages you're at, headroom to the next tripwire, and the single non-disruptive next step |
| `consult_topic` | Deep playbooks: `roadmap`, `ha-topology`, `kubernetes`, `docker`, `clickhouse-cluster`, `postgres-ha`, `kafka`, `zero-downtime-migration`, `cost-optimization`, `identity-job-ha`, `campaign-readiness` |

The model is honest about uncertainty (documented, overridable constants — planning estimates, not a benchmark) and opinionated about *not over-building*: with 0 customers you belong at Stage 0, and the whole point is that reaching 100k–200k sites is a sequence of cheap, reversible steps that never touch a frozen surface or interrupt a campaign.

**HA cluster topology**

Models the multi-VM launch topology (the `DEPLOYMENT_SRE` 3-VM shape: 1 witness — observability + quorum 3rd-vote + this MCP, never serves — plus the active-active HA serving nodes behind a floating VIP, fronting the public host list). Stored alongside the server registry; lets the launch tools target roles and probe the right hosts.

| Tool | What it does |
| --- | --- |
| `cluster_define` | Define/update a cluster: witness + node server names (from `server_add`), VIP, the public host list (defaults to the 8 AdPix hosts), the OIDC issuer |
| `cluster_list` | List clusters with their witness/node roles, VIP and host count |
| `cluster_status` | SSH-probe every member, roll up reachability + role + what each runs; flags a witness that's serving user traffic (it shouldn't) or a node that's down; probes the VIP |
| `bluegreen_deploy` | Zero-interruption rolling deploy across the serving nodes (§8.2): one node at a time — redeploy → health-gate → next; **stops + leaves the rest on the old version** if a node fails its gate (the VIP/LB sheds the draining one). `stack: adpix|tagmanager`, `confirm:true` |
| `ha_quorum` | The witness-anchored stateful-tier quorum (§4): `status` probes every member's Postgres role / Redis role+link+Sentinel / ClickHouse replica state → quorum verdict (catches split-brain, missing primary, read-only replicas); `plan` prints the Patroni/Sentinel/Keeper standup; `keeper-config` generates the 3-node ClickHouse Keeper `replication.xml` with the witness as the tie-break vote. Read-only / config-generating |
| `ha_standup` | **Lays down the HA quorum** on the cluster: `keepalived` (the floating VIP + failover + single entry — node-a MASTER, node-b BACKUP, unicast VRRP, VIP released if the local Caddy dies) and `sentinel` (Redis Sentinel on all 3, witness = 3rd vote, quorum 2). `plan` (default) is the full walkthrough. Apply modes need `confirm:true`. Postgres replication is `pg_replication`; the CH Keeper XML is `ha_quorum keeper-config` (Patroni auto-failover stays manual) |

**Launch readiness (the "is this safe to ship?" surface)**

The coordinated-launch control plane (`DEPLOYMENT_SRE` §8/§11). Verifies the joint Tag-Manager + Analytics go-live without needing either app's source — the probes run from the MCP host against the live front door.

| Tool | What it does |
| --- | --- |
| `launch_gate` | **Gate 0** go/no-go: the Analytics 7 P1 release-blockers must be attested resolved before go-live. `status` / `ack` (needs a reference + `confirm:true`) / `block`. Deploy tooling refuses to promote while BLOCKED |
| `secrets_preflight` | Verify both stacks will BOOT — they fail-fast on missing/demo-default secrets in prod. Reports each required key present / MISSING / demo-default; **values are never printed** |
| `oidc_health` | Probe the shared IdP (account.adpix.io) — the SPOF whose outage breaks login for both products: discovery, advertised-issuer match (catches split-horizon misconfig), JWKS keys, TLS |
| `edge_validate` | The 8-host front door: TLS validity + days remaining, reachability, and the security-critical **Set-Cookie carve-out** (cdn/collect/config must not set cookies; gateway.adpix.net legitimately does — ADR-0033) |
| `launch_smoke` | The automatable slice of the §11.8 cross-product smoke: IdP + both dashboards up, `api.adpix.io/tm/*` **rejects** an unauthenticated request, tracker/collect reachable, no Set-Cookie on the data plane — plus the credentialed checks as a manual checklist |
| `predeploy_gate` | The §8.3 refuse-a-bad-build gate: runs typecheck + tests on a checkout (local or remote), folds in `launch_gate`, and — with `adversarialReview:true` — runs an **embedded headless Claude Code** security/correctness review of the changes (the same `claude` CLI `ai_fix` uses; a `VERDICT: NO-GO` blocks) → GO / NO-GO |

**Tag Manager (delivery core)**

Lifecycle management of the AdPix Tag Manager delivery core (`deploy/docker-compose.yml`: redis + minio + `api`:8686 + `edge`:8585 + varnish + purge-bridge — also the per-PoP unit). The required secrets (`DATABASE_URL`, `AUTH_ISSUER`, `S3_*`, `PURGE_TOKEN`) go to `deploy/.env` (mode 600, never echoed). `apps/auth` (the IdP) deploys separately — check it with `oidc_health`.

| Tool | What it does |
| --- | --- |
| `tm_install` | Clone → write `deploy/.env` secrets → build images → `up -d` → health-gate api+edge `/healthz`. Requires the secrets on first install |
| `tm_status` | Container states + deployed git version |
| `tm_health` | Container states + HTTP probes of api:8686, edge:8585, varnish:8080 → HEALTHY/DEGRADED/DOWN |
| `tm_logs` | Tail the delivery core's logs (secrets redacted) |
| `tm_restart` | Restart one service or the whole core, then re-check health |
| `tm_update` | git pull → rebuild → `up -d` → health-gate, with **auto-rollback** to the previous commit (no data backup needed — artifacts are recomputable, control DB is external) |
| `pop_add` | Provision a delivery PoP (§8.1): edge + varnish + purge-bridge + a Redis **replica** of the core (pointer + purge replication); edge reads artifacts from the central object store. Verifies the replication link, health-gates, prints the DNS/CDN behavior to add. Additive + safe — cold-fills from the object store, never mutates truth |

**Account / IdP (OIDC identity provider)**

| Tool | What it does |
| --- | --- |
| `account_install` | Deploy the Account center (`apps/auth` from the Tag Manager repo) as a **self-contained** container on `:9696` with an **embedded PGlite DB** (no external DB), a stable RSA signing key (generated + reused — so it boots under `NODE_ENV=production` and tokens survive restarts), and a bootstrap admin. With a **domain** it adds a **Caddy front door** (automatic Let's Encrypt on :80/:443, auto-renew) and probes `https://<domain>`. Its issuer URL is what Tag Manager + Analytics use as `AUTH_ISSUER` |
| `oidc_health` | Probe the IdP — discovery, issuer match, JWKS, TLS (see Cross-product) |

**Relocation**

| Tool | What it does |
| --- | --- |
| `service_relocate` | Live-move ONE service to another server with the safe strategy for its type. **Stateless** (ingest/api/edge/web/…): stand up on the target + **health-gate it before draining the source** (zero-downtime abort on failure), source kept until you fence it. **Stateful** (postgres/clickhouse/redis/minio, or the IdP's embedded DB): **refused** — returns the replicate→verify→promote→fence plan instead. Refuses a stateless move whose backends are docker-internal to the source. `apply:false` is a read-only preview with a downtime estimate |

**Observability**

| Tool | What it does |
| --- | --- |
| `obs_deploy` | Bring up the Analytics observability stack (Prometheus + Alertmanager + Grafana — ships in compose under the `extras` profile). Per `DEPLOYMENT_SRE` §4, run it on the **witness**, off the serving nodes |
| `obs_status` | Component states + Prometheus readiness and **how many scrape targets are up vs down** (the real "are we observing everything" signal) + Alertmanager/Grafana health |

**Hosted-mode maintenance**

| Tool | What it does |
| --- | --- |
| `mcp_self_update` | The hosted MCP updates **itself**: pulls its own repo, rebuilds, and restarts the service 2 s after replying. Refuses on local modifications (e.g. unreviewed AI self-heal patches) |

## Private GitHub repos

Both repos can be private. Two separate auth hops are involved, and the MCP handles both via **read-only SSH deploy keys** (no tokens, no SSH keys handed to GitHub):

1. **MCP host → your AdPix server** — the MCP authenticates with its own SSH key (you authorize its public key on each server; the installer prints it).
2. **A server → GitHub, to clone a private repo** — each box that clones needs its *own* GitHub credential. The MCP's key gets it onto the server; it does **not** authenticate the server to GitHub.

**Installing AdPix from a private repo** — pass `deployKey:true`:

> *"Install AdPix on prod with domain analytics.example.com, deployKey true."*

`adpix_install` generates a read-only key on the server and, on first run, prints one line to paste into **GitHub → the `adpix` repo → Settings → Deploy keys** (leave write access off). Re-run the same call and it clones over SSH and proceeds. The key is reused by `cicd_enable`, so continuous deploy needs no re-auth. (A `git@github.com:…` `repoUrl` turns this on automatically; if you forget the flag on a private repo, the auth error tells you to add it.)

**Installing the MCP server itself from a private repo** — this repo is public, so the `curl … | bash` one-liners above just work. If you ever take it private, the bootstrap can't read a private raw URL: get the code onto the host first, then run the installer (it sets up its own read-only deploy key so re-runs and `mcp_self_update` keep working):

```bash
# clone with any credential you already have (a fine-grained PAT here), then hand the
# installer the SSH URL — it creates a read-only deploy key and scrubs the token:
sudo git clone https://<PAT>@github.com/mehrabiyan/adpix-devops-mcp.git /opt/adpix-devops-mcp
sudo REPO_URL=git@github.com:mehrabiyan/adpix-devops-mcp.git \
  MCP_DOMAIN=mcp.example.com ANTHROPIC_API_KEY=sk-... \
  /opt/adpix-devops-mcp/scripts/install-server.sh
# first run prints a deploy key to add to GitHub → re-run; done.
```

Deploy keys are per-repo and per-host, so AdPix and the MCP repo each get their own — which is automatic since they live on different machines.

## Guided installation (wizard)

For a full server **+** fleet **+** client setup in one go, use the installer wizard instead of the bare `install-server.sh`. It installs the hosted MCP, onboards every AdPix server into the registry, verifies SSH, authorizes the MCP's key on each target (source-pinned `from="…",restrict`), and **emits the DNS plan + ready-to-paste client configs** — all idempotent and resumable (an install-state ledger; re-run to converge, never clobbers hand-added entries). See [docs/installer.md](docs/installer.md).

**Shell TUI** (visual, interactive — gum if present, plain prompts otherwise):

```bash
sudo ./scripts/adpix-setup.sh          # gather fleet + domains, install, print DNS + connect
sudo ./scripts/adpix-setup.sh --dry-run
```

**Web wizard** (browser, loopback-only — reached through an SSH tunnel, never a public port):

```bash
sudo node /opt/adpix-devops-mcp/dist/index.js --wizard
# prints:  ssh -N -L 8931:127.0.0.1:8931 root@<server>   →   open http://127.0.0.1:8931/#t=<token>
```

The web wizard is hardened per the security review: loopback bind (refuses non-loopback without TLS), a single-use 256-bit token carried in the URL **fragment** (never logged), a strict `Host` allowlist (anti-DNS-rebind), header-token CSRF protection (no cookies), `Origin`/`Sec-Fetch` checks, JSON-only mutations, a full security-header set, and idle + max-lifetime auto-shutdown. SSH bootstrap keys/passwords are one-shot (never persisted); the registry stores key **paths**, never bytes.

**Non-interactive / CI** (the same core both wizards drive):

```bash
node dist/install/cli.js --answers-file answers.json   # converge
node dist/install/cli.js --dry-run                     # show the plan, change nothing
node dist/install/cli.js --uninstall [--purge]         # reverse it
node dist/install/cli.js --revoke                      # strip the MCP key from every target
node dist/install/cli.js --rollback                    # previous commit + rebuild + restart
```

Host-key verification: the MCP now TOFU-pins each target's SSH host key (`~/.adpix-devops/known_hosts.json`) and aborts on a changed key — set `ADPIX_SSH_STRICT_HOSTKEY=1` to refuse any unpinned host.

## Web control panel (AdPix Cloud)

A self-service control panel (cPanel / DigitalOcean-style) over the MCP tools — manage the fleet, containers, backups, databases, deploys, HA, DNS and clients from a UI, no CLI. **Phases 1–3 are built** (job engine + SPA; login + TOTP + RBAC + re-auth nonces + hash-chained audit + kill-switch; the container_control / metrics_query / schedule_job / resize+data-move tools). See [docs/control-panel.md](docs/control-panel.md). Remaining: the internet exposure transport (OIDC/WebAuthn + mTLS) and bespoke per-screen UI polish.

First run is **token mode** (loopback, no login) until you create the first admin; after that it's per-admin **login (password + TOTP)** with server-side sessions. Destructive ops need a typed-confirm that mints a single-use re-auth nonce. Owners get a Settings admin panel (users/roles, sessions, audit + chain verification, kill-switch).

```bash
node dist/index.js --panel [--port 8931]
# prints:  http://127.0.0.1:8931/#token=<token>   +   ssh -L 8931:127.0.0.1:8931 <server>
```

Read-only tools run inline; mutating/slow tools become async **jobs** with live SSE log streaming, a per-target mutex, idempotency keys, cancel, and resume-after-restart (a job ledger cloned from the install-state journal). Live progress is captured for **all** tools with zero per-tool changes via a `Deps` decorator that streams redacted `exec`/`local` output. Destructive ops require a typed-confirm modal → `confirm:true`. Loopback-only, reusing the wizard guard (Host allowlist, header-token CSRF, Origin/Sec-Fetch, JSON-only) — **not** for public exposure until Phase 2.

## Hosting the MCP server on its own Ubuntu server

Instead of running locally over stdio, host it as an HTTPS service.

**This deployment (dev.adpix.io)** — on the MCP host (`167.233.101.248`), as root:

```bash
ANTHROPIC_API_KEY=sk-... \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/mehrabiyan/adpix-devops-mcp/main/scripts/install-dev-adpix.sh)"
```

`scripts/install-dev-adpix.sh` is pinned to this deployment: it checks it's running on the right box, checks the `dev.adpix.io` A-record points at `167.233.101.248`, runs the generic installer with those settings, and then verifies `https://dev.adpix.io/healthz` end to end before printing the ready-to-paste connect command. DNS prerequisite: `dev.adpix.io  A  167.233.101.248` (Caddy retries issuance automatically if you add it later); ports 80 + 443 open.

**Any other deployment** — same thing, parameterized:

```bash
MCP_DOMAIN=mcp.example.com ANTHROPIC_API_KEY=sk-... \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/mehrabiyan/adpix-devops-mcp/main/scripts/install-server.sh)"
```

For a **private** `adpix-devops-mcp` repo this exact one-liner won't fetch the script — see [Private GitHub repos](#private-github-repos) above for the clone-then-install flow.

The idempotent installer sets up: Node 22 (if needed), a system user, the build, a root-only env file with a **generated Bearer token** (preserved across re-runs), a hardened systemd service (`Restart=always` + AI `OnFailure` self-heal hook), an **SSH identity** for reaching your AdPix servers (it prints the public key to authorize on each target), optional **read-only deploy key** for a private repo (`REPO_URL=git@github.com:…`), Caddy with automatic Let's Encrypt TLS for `MCP_DOMAIN`, and ufw rules. It finishes by printing the exact connect command:

```bash
claude mcp add --transport http adpix-devops https://mcp.example.com/mcp \
  --header "Authorization: Bearer <token>"
```

Without `MCP_DOMAIN` it serves plain HTTP on port 8930 (token-protected — only use on a trusted network, or keep `MCP_HTTP_HOST=127.0.0.1` and connect through an SSH tunnel). Update later by re-running the installer or calling the `mcp_self_update` tool. The server **refuses to start** on a non-loopback address without `MCP_AUTH_TOKEN`.

### Connecting OAuth-only clients (web chatbots)

Header-capable clients (Claude Code/Desktop) use `Authorization: Bearer <MCP_AUTH_TOKEN>`. Clients that **require OAuth** — many web chatbot "custom connector" flows — need the built-in OAuth 2.1 authorization server. Enable it with `ENABLE_OAUTH=1` on the installer (or set `MCP_OAUTH_ENABLED=true` + `MCP_PUBLIC_URL=https://your-domain` in the env file and restart):

- Implements RFC 8414/9728 discovery, RFC 7591 **dynamic client registration**, and authorization-code + **PKCE (S256)** — so a compliant client just needs the base URL `https://your-domain/mcp` and self-registers; no Client ID to paste. For a manual form: Authorization Endpoint `https://your-domain/authorize`, Token Endpoint `https://your-domain/token`, Token Auth Method `none (PKCE)`.
- **Human-gated:** every authorization shows a consent screen that requires your `MCP_AUTH_TOKEN` to approve, and there you pick the granted scope: **`mcp:read`** (read-only tools only — health/status/consult/capacity) or **`mcp:full`** (every tool, incl. root `run_command`, deploys, secret rotation). Default is read-only, so an external chatbot gets least privilege unless you explicitly grant more.
- The static `MCP_AUTH_TOKEN` keeps working for header clients (full scope) alongside OAuth.

Requires `MCP_PUBLIC_URL` (for absolute endpoints) and `MCP_AUTH_TOKEN` (the consent secret); the server refuses to enable OAuth without both.

## Configuration

Servers normally come from the registry (`server_add`). For a single-server setup you can skip it and set env vars in the MCP client config instead:

| Env var | Meaning | Default |
| --- | --- | --- |
| `ADPIX_SSH_HOST` | Server hostname/IP | — |
| `ADPIX_SSH_USER` | SSH user (root or passwordless sudo) | `root` |
| `ADPIX_SSH_PORT` | SSH port | `22` |
| `ADPIX_SSH_KEY` | Private key path | agent, then `~/.ssh/id_ed25519`/`id_rsa` |
| `ADPIX_DIR` | AdPix checkout dir on the server | `/opt/adpix` |
| `ADPIX_WEBHOOK_URL` | Watchdog alert webhook | — |
| `ADPIX_SSH_PASSPHRASE` | Key passphrase (if any) | — |
| `ADPIX_SSH_PASSWORD` | Password auth fallback (keys are strongly preferred) | — |
| `ADPIX_DEVOPS_HOME` | Registry location | `~/.adpix-devops` |
| `ANTHROPIC_API_KEY` | Used by `ai_setup`/`ai_fix` when no key is given/stored | — |
| `MCP_TRANSPORT` | `http` switches to hosted mode (same as `--http`) | stdio |
| `MCP_HTTP_HOST` / `MCP_HTTP_PORT` | Hosted-mode bind address | `127.0.0.1` / `8930` |
| `MCP_AUTH_TOKEN` | Bearer token for `/mcp` + OAuth consent secret (required off-loopback) | — |
| `MCP_OAUTH_ENABLED` | Enable the OAuth 2.1 authorization server (for OAuth-only clients) | `false` |
| `MCP_PUBLIC_URL` | Public base URL for OAuth endpoints, e.g. `https://dev.adpix.io` (required with OAuth) | — |

## Security model

- **Keys stay put.** The registry stores a *path* to your private key, never the key. Passwords/passphrases are env-only and never written to disk.
- **Secrets are redacted** from tool output (deploy logs, `.env`-style values, the generated admin password — it stays in `.env` on the server).
- **Guardrails, not a sandbox.** `run_command` refuses known-catastrophic patterns without `confirm:true`; destructive purpose-tools (`adpix_restore`, reboots) carry their own confirm flags; `harden_server` is dry-run by default. Your MCP client's human-approval prompt remains the primary control.
- **AI runs are bounded.** Every Claude Code run is turn-limited, lock-filed, cooled down (30 min between automatic fixes, 60 min for MCP self-heal), prompt-forbidden from touching data/secrets/git-push, and fully transcripted on the server. Use an API key with a spend limit.
- **Hosted mode**: Bearer token compared in constant time, TLS via Caddy, and a hard refusal to bind beyond loopback without a token.
- **Non-root users** must have passwordless sudo (`NOPASSWD`) — commands are wrapped with `sudo -n`.
- Host keys are not pinned (typical for MCP SSH tooling) — point this at servers you trust on networks you trust.

## Development

```bash
npm install
npm test        # vitest — 612 tests, no network
npm run build
npm run dev     # run from source over stdio
```

**Testing** (vitest, all hermetic — the `Deps` seam swaps in a fake SSH/registry/local layer, so nothing touches a network):

- **Unit** (per-handler): every one of the **86 tools** has a direct `tool("…").handler(fakeDeps, args)` test that drives its logic against mocked command output (regexes match the real shell/SQL strings). Destructive paths assert their guards (refuse-without-confirm, impact previews, verify-before-swap, disk/merge preflights, downtime warnings).
- **Integration** (`test/integration.test.ts`): drives the **real MCP server** end to end — a SDK `Client` talks to `buildServer(fakeDeps)` over an in-memory transport. Asserts the `tools/list` contract (all tools, well-formed JSON Schemas, preserved annotations), JSON-Schema **input validation** (bad-typed args are rejected), the call dispatch, and the handler-throw → `isError` mapping. An **exhaustive every-tool smoke** calls all 86 tools through the protocol with minimal valid args and asserts each returns content (no schema rejection, no crash).
- **Transport** (`test/http.test.ts`): the hosted HTTP mode — `/healthz`, Bearer auth (constant-time), 404s, and a real `initialize` + `tools/list` round-trip.
- Plus the pure layers: guard patterns, registry round-trip + permissions, parsers, the watchdog/autodeploy/AI-fixer bash templates (incl. `bash -n`).

`buildServer(deps?)` takes the dependency seam so the protocol layer is testable; `main()` defaults it to the real implementation.

Layout: `src/ssh.ts` (ssh2 wrapper: sudo, timeouts, keepalive) · `src/registry.ts` (servers + HA clusters + launch gate) · `src/guard.ts` · `src/http.ts` (Streamable HTTP + Bearer auth) · `src/adpix.ts` (deploy/compose/health specifics) · `src/remote/*` (bash + systemd templates: watchdog, autodeploy, AI fixer — all `bash -n`-tested) · `src/tools/*` (one file per tool group; handlers take a `Deps` seam so tests run without a network) · `scripts/` (Ubuntu installer + MCP self-heal hook).
