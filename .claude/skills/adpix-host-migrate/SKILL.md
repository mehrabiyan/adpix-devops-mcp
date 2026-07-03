---
name: adpix-host-migrate
description: Migrate a full AdPix node (analytics + IdP/deploy stack + datastores) to a fresh server — e.g. prod1→prod3 to escape a small/compromised box. Use when asked to move a node, stand up a replacement, or relocate the whole stack with data. Covers register+recon, docker install, code+image relay, PG/ClickHouse restore, Kafka data-volume migration (kafka_deploy), the IdP/deploy-stack bring-up (deploy/.env reconstruction incl. the multiline OIDC key), caddy multi-domain re-add, network aliasing, the DNS cutover sequence, secret_rotate of burned secrets on the new node, and adpix-harden after cutover.
---

# AdPix full-host migration runbook

Prereq: read **adpix-devops** + **adpix-offline-build**. Everything long runs detached (`systemd-run`+poll). Cross-node files go via the tagmanager relay. The OLD node stays up until you verify the new one — DNS is the only cutover and it's reversible.

## 0. Register + recon the target
- `server_add` (key readable by `adpixmcp` in `/var/lib/adpix-devops-mcp/`; port 1349, user ubuntu).
- Recon: `nproc; free -h; df -h /`; egress test (`gcr.io`, `proxy.golang.org`, `registry-1.docker.io`, `github.com`, `goproxy.io`); reach to tagmanager `:8000`. Expect the Google block.

## 1. Base
- Install docker detached: `systemd-run --unit=dk /bin/bash -c 'curl -fsSL https://get.docker.com|sh && systemctl enable --now docker'`.
- Relay the analytics checkout: on tagmanager `tar czf /tmp/adpix-checkout.tgz -C /opt/adpix --exclude=./backups --exclude=./node_modules .` → node `curl …:8000/… | tar xz -C /opt/adpix`. Load the distroless base (adpix-offline-build). Apply the Go/pip Dockerfile patches.

## 2. Secrets (.env)
- Get the source node's `/opt/adpix/.env` onto the target (relay, or read+write). Set `PG_BIND_IP=127.0.0.1` (HA-replication-only var; a fresh box has no 10.x interface). Confirm `SITE_ADDRESS` lists all 8 domains.

## 3. Analytics images
- Build on the target (it can, with patches) OR relay all 9 `adanalytics-*` from tagmanager. Verify `docker images | grep adanalytics- | wc -l` = 9.

## 4. Datastores + data restore (do BEFORE app services)
- `docker compose -p adanalytics -f compose.yaml -f compose.prod.yaml up -d postgres clickhouse redis`; wait healthy.
- On source: `docker exec adanalytics-postgres-1 pg_dumpall -U sovereign | gzip` (captures sovereign+auth+tagmanager) + ClickHouse Native exports of `events_local raw_events_jsonl distinct_id_overrides`. Relay the tarball.
- Restore PG: `gunzip -c pgall.sql.gz | docker exec -i adanalytics-postgres-1 psql -U sovereign -d postgres` (ignore "already exists").
- `docker compose … run --rm --no-deps migrate` (applies new migrations + creates CH schema).
- **Fix `integrity_net_dict`** (add USER/PASSWORD + `SYSTEM RELOAD DICTIONARY`) BEFORE importing CH — else the integrity MV rejects inserts.
- Import CH: `cat ch_<t>.native | docker exec -i adanalytics-clickhouse-1 clickhouse-client --user default --password "$CHPW" -q "INSERT INTO sovereign.<t> FORMAT Native"`.

## 4b. Kafka — only if the source runs `/opt/adpix-kafka`
- Check the source first: `ls /opt/adpix-kafka` (or `kafka_health` against it). If there's no Kafka, skip this whole section.
- Stand it up on the target: `kafka_deploy confirm:true` — match the source's brokers/extPort/retention; the external listener stays **LOOPBACK-only** (never `bindPublic` in prod). Auto-create is OFF, so recreate topics with `kafka_topics action=create confirm:true`.
- The KRaft **data volume migrates like the datastores**: stop the source broker, relay the `adpix-kafka_broker_data` volume tarball, restore into the target's volume, then `kafka_deploy confirm:true` again (the fixed CLUSTER_ID reuses the already-formatted storage).
- Verify BEFORE cutover: `kafka_health` (HEALTHY — 0 under-replicated / 0 offline partitions) + `kafka_lag` (consumers keeping up, not falling behind).

## 5. Analytics services
`docker compose -p adanalytics -f compose.yaml -f compose.prod.yaml up -d --no-build`. Verify via `curl -sk --resolve analytics.adpix.io:443:127.0.0.1 https://analytics.adpix.io/{,api/v1/version}`.

## 6. IdP / deploy stack (required — analytics login needs `tm-auth`)
- Relay the **AdpixTagManager** checkout (repo name is `mehrabiyan/AdpixTagManager`; deploy compose at `deploy/docker-compose.yml` + `deploy/docker-compose.apps.yml`) → `/opt/adpix-tagmanager`.
- **Reconstruct `deploy/.env`** from the source's running `deploy-*` containers via `printenv` (keeps secrets off the wire). Map names: `AUTH_DATABASE_URL`←auth `DATABASE_URL`, plus `AUTH_ISSUER, CONSOLE_ORIGIN, ANALYTICS_ORIGIN, ANALYTICS_API_ORIGIN, COOKIE_DOMAIN, BOOTSTRAP_ADMIN_EMAIL/PASSWORD, NEXT_PUBLIC_AUTH_ISSUER, NEXT_PUBLIC_{ACCOUNT,ANALYTICS,API,TAGMANAGER}_URL, NEXT_PUBLIC_OIDC_CLIENT_ID(=tm-console), DATABASE_URL(tagmanager), S3_*, REDIS_URL, PURGE_TOKEN`. Enumerate required vars: `grep -ohE '\$\{[A-Z_]+' deploy/*.yml | sort -u`.
- **OIDC signing key**: do NOT put the multiline PEM in `deploy/.env` (env_file can't do multiline → corrupts the file). Save it to `deploy/oidc_key.pem` (raw) and inject at compose time: `export OIDC_PRIVATE_KEY_PEM="$(cat deploy/oidc_key.pem)"`. Migrating it as-is preserves the JWKS `kid` so existing tokens stay valid.
- Build (node:22-alpine, no Google block) + up, ALWAYS with `--env-file deploy/.env`:
  `export OIDC_PRIVATE_KEY_PEM="$(cat deploy/oidc_key.pem)"; docker compose -p deploy --env-file deploy/.env -f deploy/docker-compose.yml -f deploy/docker-compose.apps.yml build && … up -d --no-build`.
- **Network**: the deploy compose has NO network block. Connect its services onto the analytics net so caddy + analytics resolve them:
  `docker network connect --alias tm-auth --alias auth adanalytics_default deploy-auth-1`
  `docker network disconnect adanalytics_default deploy-api-1; docker network connect --alias tm-api adanalytics_default deploy-api-1`
  `docker network disconnect adanalytics_default deploy-console-1; docker network connect --alias tm-console adanalytics_default deploy-console-1`
  (deploy `auth` uses the analytics `postgres` over this net; auth itself uses embedded PGlite at /data on the new code.)

## 7. Caddy multi-domain (single-box fix)
The NEW analytics Caddyfile drops `account`/`tagmanager` routing (it assumes a multi-host layout). On a single box, re-add before the `# LEGACY single-domain` line (MULTI-LINE syntax — inline `{ … }` fails to parse):
```
@accountHost host account.adpix.io
handle @accountHost {
	reverse_proxy tm-auth:9696
}
@tmConsoleHost host tagmanager.adpix.io
handle @tmConsoleHost {
	reverse_proxy tm-console:3000
}
```
`docker exec adanalytics-caddy-1 caddy validate --config /etc/caddy/Caddyfile` then `caddy reload …`. Caddyfile is bind-mounted from `ops/caddy/Caddyfile`.

## 8. Verify + cutover
- Local verify each domain: `curl -sk --resolve <d>:443:127.0.0.1 https://<d>/…` (TLS for non-account domains stays 000 until DNS — that's expected).
- Hand the operator the **8 A-records → new IP** (analytics/account/tagmanager/api.adpix.io + cdn/collect/config/gateway.adpix.net). Caddy auto-issues LE certs after DNS arrives. Plan + sequence the cutover with **adpix-network** (`dns_plan`).
- After DNS: verify externally (certs, login flow end-to-end, ingest, all 8 domains) → THEN operator shuts down the old node.
- **Harden the new node** (once traffic is on it): run **adpix-harden** — closes the dev-open posture (datastores on 0.0.0.0, no firewall, SSH password auth) and now also locks container egress with `egress_lockdown` (confirm:true) + drops a `honeypot` (confirm:true). Don't skip: the migrated box inherits the source's wide-open compose defaults.
- Cleanup: tear down tagmanager relay units; note all build/caddy/network patches are node-local (dev should land upstream). Secrets touched are burned → **`secret_rotate` on the NEW node** (`scope:"datastore"` or `"all"`, `confirm:true`) — it generates AND applies each PG/Redis/app secret entirely on the target (the value never transits the MCP), backs up `.env`, restarts stateless consumers, and health-gates. CH / MinIO / IdP-signing-key / OIDC-client / SMTP come back as **assisted** — rotate those by their own path (see the tool's notes + `docs/incident-prevention.md`).

Related skills: **adpix-devops** (env map + gotchas) · **adpix-offline-build** (images on the egress-blocked prod nodes) · **adpix-network** (`dns_plan` + cutover sequencing) · **adpix-harden** (post-cutover lockdown) · **adpix-incident** (if you're migrating to escape a compromised box).
