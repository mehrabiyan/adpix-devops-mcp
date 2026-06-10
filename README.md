# adpix-devops-mcp

An [MCP](https://modelcontextprotocol.io) server that acts as a **DevOps / SysAdmin / Site-Reliability engineer** for [AdPix Analytics](https://github.com/mehrabiyan/adpix). Connect it to Claude (Code / Desktop / any MCP client) and ask it to:

- **Install** AdPix on a fresh server — preflight checks, then AdPix's idempotent one-command deploy (Docker, secrets, build, migrations, automatic HTTPS via Caddy/Let's Encrypt)
- **Maintain** it — safe updates (backup → pull → redeploy → health-gate → **auto-rollback** on failure), restarts, logs, backups, restores
- **Monitor** security, uptime and loading speed — container + front-door health, system metrics, TTFB/TLS timing reports, certificate expiry, security audits
- **Keep it up 24/7** — installs an on-server **watchdog** (systemd timer) that checks every service each minute, auto-restarts anything unhealthy, records per-check uptime data, and fires webhook alerts on outage/recovery — protection that keeps running after you close your MCP client
- Reach servers over **SSH** as `root` or a passwordless-`sudo` user, with private keys that never leave your machine

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
| `adpix_install` | Preflight (OS/RAM/disk/ports 80+443) → clone → `scripts/deploy.sh` (Docker, `.env` secrets, build, migrate) → health gate. Domain ⇒ automatic HTTPS; no domain ⇒ HTTP on the server IP. First run ≈ 10–25 min |
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
| `watchdog_install` | Installs a systemd timer **on the server**: each interval it verifies every container + the front door (HTTP and HTTPS), auto-restarts unhealthy services, appends per-check records + incident JSONL, and POSTs `{"text": …}` webhook alerts (Slack/Discord/generic) on down/recovery |
| `watchdog_status` | Timer schedule, last check, recent incidents |
| `uptime_report` | Uptime % per day computed from the watchdog's per-check records, plus the incident history (what broke, what got restarted, when it recovered) |

Watchdog data lives on the server under `/var/log/adpix-watchdog/` (`checks-YYYYMM.log`, `incidents.jsonl`, `state.json`).

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

## Security model

- **Keys stay put.** The registry stores a *path* to your private key, never the key. Passwords/passphrases are env-only and never written to disk.
- **Secrets are redacted** from tool output (deploy logs, `.env`-style values, the generated admin password — it stays in `.env` on the server).
- **Guardrails, not a sandbox.** `run_command` refuses known-catastrophic patterns without `confirm:true`; destructive purpose-tools (`adpix_restore`, reboots) carry their own confirm flags; `harden_server` is dry-run by default. Your MCP client's human-approval prompt remains the primary control.
- **Non-root users** must have passwordless sudo (`NOPASSWD`) — commands are wrapped with `sudo -n`.
- Host keys are not pinned (typical for MCP SSH tooling) — point this at servers you trust on networks you trust.

## Development

```bash
npm install
npm test        # vitest: guard patterns, registry, parsers, watchdog script (incl. bash -n), tool flows on a mocked SSH session
npm run build
npm run dev     # run from source over stdio
```

Layout: `src/ssh.ts` (ssh2 wrapper: sudo, timeouts, keepalive) · `src/registry.ts` · `src/guard.ts` · `src/adpix.ts` (deploy/compose/health specifics) · `src/remote/watchdog.ts` (bash + systemd templates) · `src/tools/*` (one file per tool group; handlers take a `Deps` seam so tests run without a network).
