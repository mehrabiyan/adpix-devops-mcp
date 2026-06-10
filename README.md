# adpix-devops-mcp

An [MCP](https://modelcontextprotocol.io) server that acts as a **DevOps / SysAdmin / Site-Reliability engineer** for [AdPix Analytics](https://github.com/mehrabiyan/adpix). Connect it to Claude (Code / Desktop / any MCP client) and ask it to:

- **Install** AdPix on a fresh server — preflight checks, then AdPix's idempotent one-command deploy (Docker, secrets, build, migrations, automatic HTTPS via Caddy/Let's Encrypt)
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

**Installing the MCP server itself from its private repo** — the `curl … | bash` bootstrap can't read a private raw URL, so get the code on the host first, then run the installer (it sets up its own read-only deploy key so re-runs and `mcp_self_update` keep working):

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

## Hosting the MCP server on its own Ubuntu server

Instead of running locally over stdio, host it as an HTTPS service:

```bash
# on the MCP host (fresh Ubuntu/Debian), as root:
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
| `MCP_AUTH_TOKEN` | Bearer token for `/mcp` (required off-loopback) | — |

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
npm test        # vitest: guard patterns, registry, parsers, watchdog script (incl. bash -n), tool flows on a mocked SSH session
npm run build
npm run dev     # run from source over stdio
```

Layout: `src/ssh.ts` (ssh2 wrapper: sudo, timeouts, keepalive) · `src/registry.ts` · `src/guard.ts` · `src/http.ts` (Streamable HTTP + Bearer auth) · `src/adpix.ts` (deploy/compose/health specifics) · `src/remote/*` (bash + systemd templates: watchdog, autodeploy, AI fixer — all `bash -n`-tested) · `src/tools/*` (one file per tool group; handlers take a `Deps` seam so tests run without a network) · `scripts/` (Ubuntu installer + MCP self-heal hook).
