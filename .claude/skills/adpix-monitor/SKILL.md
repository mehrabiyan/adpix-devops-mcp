---
name: adpix-monitor
description: Monitoring, alerting, and auto-resolve for a high-traffic AdPix node (SRE on-call). Use to stand up health/uptime checks on a node, respond to an alert or outage, or wire 24/7 self-healing. Covers health_check + stack_doctor, the on-box watchdog (watchdog_install/watchdog_status/uptime_report — restarts containers + webhook alerts + AI escalation), obs_deploy/obs_status + metrics_query (Prometheus/Grafana on the witness), tls_status cert-expiry, scheduled threat_scan + honeypot for attack detection, and ai_setup/ai_fix auto-resolve. Outage triage: health_check → stack_doctor → the tier tool (pg/ch/kafka/tm/oidc_health) → logs.
---

# AdPix monitoring, alerting & auto-resolve (SRE on-call)

Prereq: read **adpix-devops**. Tools are deferred — load with `ToolSearch "select:mcp__adpix-devops__<name>"`. Read-only tools are safe to run anywhere; `schedule_job` (add/remove), `honeypot` (deploy/remove), and `ai_fix mode:fix` mutate — see the confirm notes below.

Principle: **detect on-box (survives an MCP disconnect), observe off the serving nodes (on the witness), auto-resolve with guardrails.** Prefer the dedicated tool over raw `run_command`.

---
## Stand up monitoring on a node (do all four)
1. **Baseline** — `health_check server=<name>`. Verdict HEALTHY/DEGRADED/DOWN; checks every container's state/health + HTTP-probes the front door through local Caddy (in domain mode this exercises the real TLS path). Follow with `system_metrics` for load/mem/disk.
2. **On-box self-heal + alerts** — `watchdog_install server=<name> project=<adanalytics|adpix-account|adpix-tm> webhookUrl=<slack/discord>`. systemd timer, restarts unhealthy containers, POSTs outage/recovery alerts, records per-check uptime. Set `project` to the stack that box actually runs or it false-flags (an IdP box has no Analytics stack). Data lands in `/var/log/adpix-watchdog/`.
3. **Observability** — `obs_deploy server=witness` (Prometheus + Alertmanager + Grafana; ships under the compose `extras` profile). Run on the **witness, off the serving nodes**. Then `obs_status`.
4. **Security + TLS watch** — schedule a recurring `threat_scan` (see below) and keep an eye on `tls_status`.

---
## Respond to an alert / outage — triage sequence
Run in order; stop when you find the failing tier.
1. `health_check` — which containers/probes are red, and the verdict.
2. `stack_doctor` — end-to-end diagnose across the whole stack (wiring/config/dependency faults `health_check` can't see).
3. **The specific tier tool** for whatever `stack_doctor` fingered:
   - Postgres → `pg_health` · ClickHouse → `ch_health` · Kafka → `kafka_health` (+ `kafka_lag` for streaming backlog) · Tag Manager → `tm_health` · OIDC/IdP → `oidc_health`.
4. **Logs** — `adpix_logs` / `tm_logs service:<svc>` (e.g. `service:caddy` for TLS, the offending app for a 5xx).
5. **If a container is pegged / the box is hot** and services time out while containers read "running" → this is the miner pattern: run `threat_scan` FIRST, then hand off to **adpix-incident**. The watchdog does NOT catch this (see gaps).
6. **Can't crack it** → `ai_fix` (below).

---
## The on-box watchdog (24/7 — no MCP client needed)
`watchdog_install` renders a systemd timer that every `intervalSeconds` (default 60) verifies each container + the Caddy front door (HTTP + TLS), auto-restarts anything unhealthy, and alerts. Idempotent — re-run to change settings.
- `autoRestart:true` (default) restarts unhealthy containers; `autoRestart:false` = observe-only.
- `realertEvery` re-alerts while still down; `escalateAfter` N failed checks triggers escalation.
- `aiEscalate:true` hands a surviving outage to Claude Code on the box — **requires `ai_setup` first** (or the install refuses).
- `force:true` installs even on a not-yet-running stack (it'll alert immediately — normally you install after bring-up).
- **`watchdog_status`** — timer schedule, last check, recent incidents. **`uptime_report days=<n>`** — uptime % per day + the incident log (down → what restarted → recovered), computed from the on-box per-check records.
- **BLIND SPOT:** the watchdog checks container/front-door health only — it does **not** detect CPU-abuse, miners, disk-full, or OOM. Pair it with a scheduled `threat_scan` (below) until auto-quarantine lands.

---
## Observability stack (Prometheus / Grafana) — on the witness
- `obs_deploy` scrapes `/healthz` + worker:9100 / identity-job:9101 + node/PG/Redis/CH exporters; Grafana ships the pipeline + golden-signals dashboards.
- `obs_status` gives the real "are we observing everything" signal: Prometheus target **up vs down** counts, Alertmanager readiness, Grafana health. Any DOWN target = something isn't being observed.
- **Lock it down before exposing:** Alertmanager defaults to a nowhere receiver — set a real one (`ops/alertmanager/alertmanager.yml`) with cert-expiry / replication-lag / 5xx / outbox-depth alerts. Grafana is internal-only (no host port) with anonymous Admin on (`GF_AUTH_ANONYMOUS`) — tunnel/front with Caddy and disable anon before exposing.

### PromQL (metrics_query)
`metrics_query server=witness query='<promql>'` — read-through to that host's Prometheus (:9090). Instant query, JSON result. Examples: `up` (which targets are down), `rate(http_requests_total[5m])`, `node_load1`, consumer-group lag, disk-free. Read-only.

---
## TLS / cert expiry
`tls_status server=<name>` — live cert issuer/validity/days-remaining. Caddy auto-renews ~30 days out, so **under 14 days means renewal is failing** — check port 80 reachability + `adpix_logs service:caddy`. HTTP-on-IP nodes have no cert to check.

---
## Security monitoring
- **Scheduled compromise hunt** — `threat_scan` is a read-only hunt (miners/droppers/bad egress/root+wget containers/exposed ports) with a CLEAN/SUSPICIOUS/COMPROMISED verdict; it carries the prod1 XMRig IOCs. Run it FIRST in any suspected-intrusion triage, and schedule it recurring via `schedule_job` (**`confirm:true`** for add/remove) so the box is swept even between on-call touches.
- **Attacker detection (honeypot)** — after a node is hardened (real services moved to loopback/high ports), `honeypot action=deploy` (**`confirm:true`**) occupies the vacated attacker-magnet ports with an isolated decoy (internal-only net, non-root, read-only, cap-drop — leads nowhere, can't escalate). It tarpits + logs every source IP. Pull findings with `honeypot action=report` (`block:true` firewalls the caught IPs); `action=remove` needs `confirm:true`. Every touch of it is a confirmed intruder.

---
## Auto-resolve (AI self-heal)
- `ai_setup server=<name>` — installs the Claude Code CLI + the escalation fixer (root-only API key, lockfile + 30-min cooldown to bound spend). Prereq for `watchdog_install aiEscalate:true`.
- `ai_fix server=<name> problem='<plain words>'` — points headless Claude Code at a problem the deterministic tools can't crack. Hard guardrails: never touches volumes/DBs/backups/secrets, never pushes, least-invasive fix, stops when unsure. **`mode:diagnose` is read-only** (investigate, change nothing); default `mode:fix` mutates under guardrails. Returns the report + cost; transcript stays on the server.

---
## Phase-2 gaps (don't over-promise these yet — see docs/security-network-review.md)
Not built yet: watchdog **auto-detect** of CPU/miner/disk/OOM + auto-`quarantine` (the monitor→respond loop is still manual — pair scan + incident skill); **anomaly baseline**; **SLO / error-budget** tracking; **log-pattern alerts** (the ingest→CH 403 was silent); cert-expiry auto-renew beyond Caddy's own. Until then, cover them with a scheduled `threat_scan`, `obs_status`/`metrics_query` review, and `uptime_report`.

---
## Related skills
**adpix-incident** (a scan/health_check says COMPROMISED or the box is pegged → triage + contain), **adpix-performance** (slow/hot but healthy — capacity, tuning, loading speed), **adpix-harden** (lock the node down before running the honeypot), **adpix-devops** (env map + the detached-run + relay gotchas).
