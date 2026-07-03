---
name: adpix-devops
description: Foundational environment map + hard-won gotchas for operating the AdPix platform via the adpix-devops MCP. READ THIS FIRST before any AdPix server/deploy/migration/hardening/incident task. Covers the servers, the Google egress block on the prod nodes, the MCP long-call transport drop (→ run detached), cross-node network isolation, the tagmanager relay bridge, and the run_command destructive guard.
---

# AdPix DevOps — environment & gotchas (read first)

The adpix-devops MCP drives servers over SSH from the MCP host. Tools are deferred — load with `ToolSearch "select:mcp__adpix-devops__<name>"`. Most ops tools are read-only-ish; mutating ones (stack_update, bluegreen_deploy, service_relocate, server_resize) need `confirm:true`.

## Tool families (102 tools — prefer the dedicated tool over run_command)
- **Servers/registry:** server_add, server_list, server_remove, run_command, schedule_job, server_resize, data_move, mcp_status, mcp_self_update.
- **Analytics lifecycle:** adpix_install, adpix_update, adpix_status, adpix_restart, adpix_logs, adpix_backup, adpix_restore. **Stack:** stack_update (confirm), stack_status, stack_doctor, service_relocate (confirm).
- **Tag Manager / IdP:** tm_install, tm_status, tm_health, tm_logs, tm_restart, tm_update, account_install, console_install, pop_add.
- **Postgres:** pg_health, pg_tune, pg_optimize, pg_harden, pg_backup, pg_restore_db, pg_replication, pg_redeploy.
- **ClickHouse:** ch_health, ch_tune, ch_optimize, ch_harden, ch_backup, ch_restore_db, ch_replication, ch_retention, ch_redeploy.
- **Kafka (NEW):** kafka_deploy (confirm), kafka_health, kafka_topics (create=confirm), kafka_lag, kafka_tune (confirm).
- **Cluster/HA:** cluster_define, cluster_list, cluster_status, bluegreen_deploy (confirm), ha_quorum, ha_standup.
- **Monitoring/observability:** health_check, system_metrics, performance_report, tls_status, obs_deploy, obs_status, metrics_query, watchdog_install, watchdog_status, uptime_report.
- **Security:** security_audit, harden_server (apply=confirm), patch_system (reboot=confirm), threat_scan, quarantine (stop/block=confirm), secret_rotate (confirm), honeypot (deploy/remove=confirm), egress_lockdown (apply/teardown=confirm).
- **Network:** net_probe, net_bridge, net_diag, dns_plan, cert_install, connect_configs.
- **Launch/scale/consult:** launch_gate, secrets_preflight, oidc_health, edge_validate, launch_smoke, predeploy_gate, launch_readiness, scale_ingest (confirm), capacity_plan, scale_assessment, consult_topic.
- **Air-gap:** offline_bundle, offline_install. **AI:** ai_setup, ai_fix. **CICD:** cicd_enable, cicd_status, cicd_run_now, cicd_disable.

## Servers (server_list is authoritative)
- **prod** `167.233.59.44` — legacy single-node analytics.
- **tagmanager** `188.245.92.203` — all-in-one (Hetzner fsn1). **Reaches EVERYTHING incl. Google/gcr.io/proxy.golang** — use it as the build/relay host.
- **prod1** `188.121.120.36:1349` (user ubuntu) — small (23 GB disk), was compromised (XMRig), being decommissioned.
- **prod2** `185.226.117.14` — HA peer, no local checkout.
- **prod3** `188.121.121.28:1349` (user ubuntu) — new big box (4 vCPU/12 GB/70 GB), prod1's replacement.
- **witness** `188.121.108.197` — HA quorum keeper.
- **MCP host** = `dev.adpix.io` / `167.233.101.248`, service runs as user **`adpixmcp`**; registry at `/var/lib/adpix-devops-mcp/servers.json`. (You cannot run_command on the MCP host itself.)

## THE BIG GOTCHAS

1. **Google egress is BLOCKED on the 188.121.x prod nodes (prod1/2/3) and the firewall can't be changed.**
   - Blocked: `gcr.io` (403), `proxy.golang.org` module zips (302→`storage.googleapis.com` blocked), `sum.golang.org`, `mirror.gcr.io` (DNS). 
   - Reachable: docker.io, github.com, db-ip.com, **goproxy.io / goproxy.cn**, files.pythonhosted.org (slow).
   - ⇒ Builds that pull gcr.io/distroless or fetch Go modules from Google FAIL on these nodes. See skill **adpix-offline-build**.

2. **The MCP transport drops on long calls** (builds, multi-hundred-MB downloads, anything > ~1-2 min). Don't run long ops inline.
   - Pattern: `systemd-run --unit=<NAME> --working-directory=<DIR> /usr/bin/<cmd> …`, then poll in short windows: `for i in $(seq 1 30); do [ "$(systemctl is-active <NAME>)" != active ] && break; sleep 5; done` + `journalctl -u <NAME>`.
   - **`nohup … &` does NOT survive** the run_command wrapper — always use `systemd-run`. Keep each poll call under ~110 s (use `timeoutSeconds` up to 600000ms but expect drops past ~2 min).

3. **Cross-node network isolation**: prod1 ↔ prod3 cannot reach each other (different subnets; :443 → 000). prod1 can't reach the MCP host's filesystem. **All cross-node file movement goes through the tagmanager relay** (see below).

4. **run_command destructive guard**: `docker prune`, `rm -rf /`, `mkfs`, `reboot`, `DROP TABLE`, `docker volume rm` are refused unless you pass `confirm:true`. `docker builder/image/buildx prune` all trip it.

## The tagmanager relay (cross-node transfer)
tagmanager reaches every node + the internet. Stand up two tiny systemd services on it:
- **Download bridge** (serve `/tmp`): `systemd-run --unit=adpix-tmphttpd --working-directory=/tmp /usr/bin/python3 -m http.server 8000`. Targets pull with `curl http://188.245.92.203:8000/<file>`.
- **Upload sink** (PUT → `/tmp`): a small python `BaseHTTPRequestHandler` doing `do_PUT` (write `/tmp/<path>`), run on `:8001`. Push with `curl -T <file> http://188.245.92.203:8001/<file>`.
- Move a file A→B: A `curl -T` to `:8001`; B `curl` from `:8000`. The cross-provider link is **slow (~0.85 MB/s)** — size accordingly, run detached.
- **Tear these down** when done (`systemctl stop adpix-tmphttpd adpix-upload`).

## Registering a new server (server_add)
`server_add` reads the key from `privateKeyPath` **on the MCP host, readable by `adpixmcp`**. If a key is in `/root/.ssh/...` it WON'T be readable. Have the operator `install -o adpixmcp -g adpixmcp -m600 <key> /var/lib/adpix-devops-mcp/id_<name>` and pass that path. prod nodes use SSH port **1349**, user **ubuntu**.

## Data-plane facts
- ONE Postgres (`adanalytics-postgres-1`) holds DBs `sovereign` (analytics), `auth` (IdP), `tagmanager` (TM).
- ClickHouse `default` user HAS a password (`.env CLICKHOUSE_PASSWORD`); pass `--user default --password "$CHPW"` (read it: `grep ^CLICKHOUSE_PASSWORD /opt/adpix/.env|cut -d= -f2`).
- Known bug: dictionary `sovereign.integrity_net_dict` is created WITHOUT creds → fails (`default: Authentication failed`) → rejects every `events_local` insert via the integrity MV. Fix: `CREATE OR REPLACE DICTIONARY … SOURCE(CLICKHOUSE(TABLE 'integrity_net_ip' DB 'sovereign' USER 'default' PASSWORD '<chpw>')) …` then `SYSTEM RELOAD DICTIONARY`.
- IdP (`deploy-auth`, alias `tm-auth:9696`) on the NEW code uses **embedded PGlite** (`DB_DIR=/data`), signing key via `OIDC_PRIVATE_KEY_PEM` env, admin from `BOOTSTRAP_ADMIN_*`.
- **Kafka** = optional streaming tier, managed entirely by the `kafka_*` tools — **not** part of the main `/opt/adpix` compose. Its own `/opt/adpix-kafka` compose, **KRaft** (no ZooKeeper), **loopback listener** only. Bring up with `kafka_deploy` (confirm); `kafka_topics` create=confirm; `kafka_lag` is the streaming health signal; `kafka_tune` (confirm) for dynamic broker configs. See skill **adpix-kafka**.

## Related skills
`adpix-offline-build` (build behind the Google block) · `adpix-host-migrate` (move a whole node) · `adpix-harden` (lock a node down) · `adpix-incident` (compromise triage) · `adpix-kafka` (streaming tier) · `adpix-performance` (tune/scale the stack) · `adpix-monitor` (observability/uptime) · `adpix-network` (net_diag/egress-lockdown/relay).
