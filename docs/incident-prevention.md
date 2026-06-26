# Incident prevention & response — MCP tool coverage

Mapping of every finding in **ADPIX-IR-2026-06-26** (Analytics RCE → XMRig miner → secret
exfiltration → login outage) to the MCP tools that prevent it (proactive) or detect/contain it
(reactive). Updated after that incident: the gaps it exposed are now closed except where noted
"app repo" (the dev owns the fix) or "manual" (a documented runbook, not yet a tool).

## Reactive — detect & contain an active compromise

| Capability | Tool | What it does |
|---|---|---|
| **Hunt a host for compromise** | `threat_scan` | Known-miner/high-CPU processes, `/tmp` droppers (host + inside containers), outbound to mining-pool ports/IOC IPs, public listeners beyond SSH/80/443, containers running as **root shipping wget/curl**. Verdict CLEAN/SUSPICIOUS/COMPROMISED. Carries the IR-2026-06-26 IOCs (`77.90.13.20`, pool `:10128`, `/tmp/dashboard`, `.shchmod`). |
| **Contain a hit** | `quarantine` | Snapshots evidence (`docker inspect`/logs/in-container ps + `/tmp` + `docker diff`) to `/root/ir-<ts>/`, then (confirm-gated) **stops** the container (kills the payload) and **blocks egress** to the C2 IP — exactly the manual containment done during the incident. |
| Outage detection | on-box watchdog | Caught the outage (733 consecutive front-door failures). Alerts via webhook. |
| Front-door / app health | `tm_health`, `oidc_health`, `stack_doctor` | End-to-end health incl. the IdP. |

Run `threat_scan` on a schedule (or after any alert); if COMPROMISED → `quarantine` → rotate
secrets → rebuild from a clean image.

## Proactive — shrink the attack surface

| IR # | Finding | Status | Tool |
|---|---|---|---|
| 1.2 | IdP published on `0.0.0.0:9696` | **FIXED in our installer** | `account_install` now binds 9696 to `127.0.0.1` when Caddy fronts the domain (public sees only `:443`). Same for `console_install` (3000). |
| 3.1 | Datastores on `0.0.0.0` (redis/minio/CH/auth…) | **detected** | `security_audit` flags exposed datastore + docker-published ports |
| 3.2 | No firewall | detect + fix | `security_audit` → `harden_server` (ufw: SSH/80/443 only) |
| 3.3 | SSH password auth + brute force | detect + fix | `security_audit` → `harden_server` (key-only SSH + fail2ban) |
| 2.2 | Container runs as **root + ships wget/shell** | **detected (new)** | `security_audit` now flags root containers shipping wget/curl; `threat_scan` too |
| 3.7 | Pending security patches | fix | `patch_system` (+ unattended-upgrades) |
| 1.3 / 3.8 | IdP/datastores co-located on app host (SPOF/blast radius) | fix | `service_relocate`, HA tools, `cluster_*` |

## Known gaps (deliberately not yet tools)

| IR # | Finding | Why / how to handle today |
|---|---|---|
| 2.1 | RCE in the Next.js app (`child_process` sink / CVE) | **App repo** — the MCP can't patch app code. `predeploy_gate` runs an adversarial review; grep source for `child_process`/`exec`/`spawn`/`eval`, upgrade Next.js off 15.1.0, `npm audit`. Until shipped, any host serving the app is re-exploitable over 443 — firewalls don't close it. |
| 3.4 | Unrestricted container egress (enabled the `wget` payload pull) | `quarantine blockIp` blocks a known C2; a general default-deny-egress-with-allow-list tool is **not yet built** (high break-risk; needs per-stack allow-lists). Stopgap: the iptables DROP rule. |
| 3.5 | Rotate all exfiltrated secrets (CH/PG/Redis/MinIO/OIDC/SMTP + IdP signing keys) | **No one-shot rotation tool yet.** Manual today: rotate at each store, update `.env`, `stack_update`/redeploy, force global re-auth on the IdP (new `kid`). Biggest remaining automation gap. |
| 2.3 | OIDC cold-start cache race ("identity provider unavailable") | App repo (lazy discovery + retry). Workaround: restart `web` after the IdP is up. |
| 2.4 | Ingest → ClickHouse auth failure (data loss) | App/config — correct ingest CH creds (coordinate with 3.5 rotation). |
| 2.5 | Health checks reported green during the outage | App repo (real dependency probes). |

## One-look runbook after an alert

1. `threat_scan server=<host>` → if COMPROMISED, note the container + C2 IP.
2. `quarantine server=<host> container=<name> stop:true blockIp:<C2> confirm:true` → evidence saved, payload killed, egress blocked. Copy `/root/ir-<ts>/` off-box.
3. Rotate every secret the container's env held (assume exfiltrated). Force IdP re-auth.
4. Rebuild from a clean, **non-root, minimal** image (not the cleaned container).
5. `harden_server` + `security_audit` + re-run `threat_scan` to confirm CLEAN.
