# Tool review — 5 capability areas (security, network, performance, auto-ops, deception)

Holistic review of the 97 MCP tools against the target capabilities, with the current coverage, what
Phase 1 added, and the Phase 2 roadmap. Companion to `docs/incident-prevention.md` (the IR-2026-06-26
finding→tool map).

## 1. Industry-grade security (prevent attacks)

| Have | Tool |
|---|---|
| Posture audit (SSH/firewall/ports/patches/container-root+wget) | `security_audit` |
| Baseline hardening (ufw, fail2ban, key-only SSH, auto-updates) | `harden_server` |
| OS patching + reboot gate | `patch_system` |
| Compromise hunt (miners/droppers/bad egress) | `threat_scan` |
| Contain a hit (snapshot + stop + block) | `quarantine` |
| Secret rotation (PG/Redis/app, value never leaves target) | `secret_rotate` |
| DB hardening | `pg_harden`, `ch_harden` |
| **NEW — default-deny container egress + allow-list** | **`egress_lockdown`** (closes IR 3.4 — the `wget` payload path) |
| TLS management | `cert_install`, `tls_status` |

**Phase 2 gaps:** container image / dependency vuln scan (trivy/grype + SBOM), CIS-benchmark scan,
app-edge WAF + rate-limit (the RCE came in over 443), file-integrity/auditd, SSH key rotation + MFA.

## 2. Advanced network

| Have | Tool |
|---|---|
| Connectivity probe (air-gap aware) | `net_probe` |
| Egress tunnel through the MCP host | `net_bridge` |
| DNS plan / VIP / HA networking | `dns_plan`, `ha_standup` |
| **NEW — deep diagnostics (route, MTU, DNS timing, latency, surface, path trace)** | **`net_diag`** |

**Phase 2 gaps:** WireGuard mesh for cross-node private links (the tagmanager relay is manual today),
microsegmentation policy, DNSSEC/CAA, geo/rate firewall rules, iperf throughput.

## 3. Performance / DB + app optimization

| Have | Tool |
|---|---|
| Postgres tune + index/vacuum | `pg_tune`, `pg_optimize` |
| ClickHouse tune + merges + TTL cost lever | `ch_tune`, `ch_optimize`, `ch_retention` |
| Loading-speed report | `performance_report` |
| Ingest scaling + capacity plan | `scale_ingest`, `capacity_plan` |
| Metrics | `metrics_query`, `system_metrics` |

**Phase 2 gaps:** continuous autotune loop, Redis/Varnish tuning, pgbouncer, load-test/benchmark harness,
index-from-real-query-patterns, CDN cache fingerprinting (the stale-tag-JS problem).

## 4. Auto-monitor + auto-resolve

| Have | Tool |
|---|---|
| On-box watchdog — restarts docker/containers, webhook alerts, escalation | `watchdog_install` |
| Health + observability stack | `health_check`, `obs_deploy`, `obs_status` |
| AI self-heal | `ai_setup`, `ai_fix` |
| Scheduled jobs | `schedule_job` |

**Phase 2 gaps (highest-value):** the watchdog is blind to CPU-abuse/miners/disk-full/OOM — wire
`threat_scan` into it and auto-`quarantine` on a confirmed miner; anomaly baseline; auto-renew on cert
expiry; SLO/error-budget; alert on log patterns (the ingest→CH 403 was silent).

## 5. Attack-detect + deception honeypot — **NEW this phase**

| Have | Tool |
|---|---|
| One-shot compromise hunt | `threat_scan` |
| SSH brute-force ban | fail2ban (via `harden_server`) |
| **NEW — isolated deception honeypot (trap + tarpit + report + block)** | **`honeypot`** |

### honeypot — how it satisfies "lead nowhere / no escalation"
A hardened decoy container occupies attacker-expected ports (telnet/ssh-alt/mysql/postgres/redis/mongo/
elastic/http-admin) — but only ports found FREE, never a real service's. It serves fake banners, tarpits
(3s drip) to waste the attacker's time, and logs every source IP + payload. Reporting is MCP-pull
(`action=report`, `block:true` firewalls the caught IPs).

Containment (why it can't lead anywhere or escalate):
- **`internal: true` network** → no egress, no route to real services or the internet.
- runs as **`nobody`**, **`read_only`** rootfs, **`cap_drop: ALL`**, **`no-new-privileges`**, mem 128m / pids 64.
- **no secrets, no env** — nothing to steal, nothing to pivot with.
- only binds free ports — never hijacks a real service. After `harden_server` moves real services to
  loopback/high ports, the honeypot occupies the old attack surface, so every touch is a confirmed intruder.

**Phase 2 gaps:** canary tokens / decoy credential files that alert on use, auto-feed honeypot IOCs into
`egress_lockdown` + fail2ban, attacker fingerprinting/intel export.

## Phase 2 priority order
1. Watchdog → auto-detect CPU/miner/disk + auto-`quarantine` (closes the monitor→respond loop).
2. Image/dependency vuln scan (would catch the app-level RCE class before deploy).
3. App-edge WAF + rate-limit.
4. Continuous autotune + pgbouncer + CDN fingerprinting.
5. WireGuard mesh + microsegmentation.
