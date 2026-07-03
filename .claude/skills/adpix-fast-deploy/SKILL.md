---
name: adpix-fast-deploy
description: Fast deploy/upgrade of AdPix apps to the latest version, and fast launch of a brand-new node — by pulling PREBUILT images from a private registry instead of building from source on the node. Use when asked to deploy/upgrade to latest ASAP, recover quickly, or stand up a new server fast. This is the FAST path; fall back to adpix-offline-build only when the registry is unavailable. Root cause of past slowness: per-node source builds + the Google egress block. This skill builds once on tagmanager and pulls everywhere.
---

# AdPix fast deploy / launch (build-once, pull-many)

Prereq: read **adpix-devops**. Principle: **the prod nodes can't build cleanly (Google egress block) and building per-node is the slowness.** tagmanager reaches everything → it is the **build+registry host**. Every node just pulls.

Speed target: upgrade an existing node ≈ a few min (pull deltas + migrate + up). Launch a new node ≈ ~10 min (bootstrap + pull + restore + up). No source builds on prod nodes.

---
## WHY this is fast — the network reality (measured 2026-06-28)
| Link | Speed |
|------|-------|
| tagmanager → prod nodes | **~0.85 MB/s** 🐌 (cross-provider WAN) |
| prod2 ↔ prod3 public | **~550 MB/s** |
| prod2 ↔ prod3 private (10.10.0.x) | ~376 MB/s |
Prod nodes talk to each OTHER ~600× faster than to tagmanager. So **registry lives on prod3, NOT tagmanager**. tagmanager only BUILDS (reaches Google/gcr/goproxy), pushes ONCE to prod3 over the slow link; both nodes pull at LAN speed. Old design (registry on tagmanager) crossed the slow link once PER NODE PULL = the slowness. Persistent prod3 registry also makes repeat pushes **delta-only** (shared base layers already there).

## ONE-TIME setup: SECURED registry on prod3 (DONE 2026-06-28)
Runs on **prod3 188.121.121.28:5000**, htpasswd-auth (anon→401), data `/opt/registry/data`, creds `/opt/registry/auth/htpasswd` (user `adpix`; pass in transcript → ROTATE). Stood up:
```sh
# prod3
docker run --rm httpd:2.4-alpine htpasswd -Bbn adpix "$PASS" > /opt/registry/auth/htpasswd
docker run -d --restart=always --name registry -p 5000:5000 \
  -v /opt/registry/data:/var/lib/registry -v /opt/registry/auth:/auth \
  -e REGISTRY_AUTH=htpasswd -e REGISTRY_AUTH_HTPASSWD_REALM=adpix -e REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd registry:2
```
Each node (tagmanager builder + prod2 + prod3) trusts `188.121.121.28:5000` (insecure-registries + **`systemctl reload docker`** = SIGHUP, NO bounce) and is `docker login`'d. Old open tagmanager:5000 registry torn down (was unauthenticated = hole).
```sh
python3 - <<'PY'
import json,os
p='/etc/docker/daemon.json'; d=json.load(open(p)) if os.path.exists(p) and os.path.getsize(p) else {}
d.setdefault('insecure-registries',[])
[d['insecure-registries'].append(x) for x in ['188.121.121.28:5000'] if x not in d['insecure-registries']]
json.dump(d,open(p,'w'),indent=2)
PY
systemctl reload docker   # SIGHUP — no bounce (NOT restart)
echo "$PASS" | docker login 188.121.121.28:5000 -u adpix --password-stdin
```
(Better long-term: TLS registry + CI build+push on release tag.)

---
## BUILD (on tagmanager) + PUSH to prod3 registry
`REG=188.121.121.28:5000`. **Build only the services whose source changed** (`git diff --name-only <deployed>..origin/main` → service map below). Build detached (`systemd-run --unit=tmbuildN ... build <svc>` + poll `systemctl is-active`) — inline build drops the MCP transport.
```sh
cd /opt/adpix && git reset --hard origin/main; REG=188.121.121.28:5000
systemd-run --unit=tmbuild --working-directory=/opt/adpix /usr/bin/docker compose -p adanalytics -f compose.yaml -f compose.prod.yaml build <changed-svcs>
# after build active→inactive exit:0, push ONLY changed (detached — push crosses the SLOW link):
for s in <changed-svcs>; do docker tag adanalytics-$s:latest $REG/adanalytics-$s:latest; done
systemd-run --unit=tmpush /bin/bash -c "for s in <changed-svcs>; do docker push $REG/adanalytics-\$s:latest; done"
# poll tmpush; verify: curl -su adpix:$PASS http://$REG/v2/adanalytics-<svc>/tags/list
# IdP/deploy stack: same, prefix deploy-* ; export OIDC_PRIVATE_KEY_PEM + --env-file deploy/.env to build
```
Service→image map: `services/ingest`,`packages/tracker`→**ingest**; `apps/web`→**web**; `services/api`→**api**; `services/worker`→worker; `jobs/*`→lift/mmm/integrity-job; `migrations/`→run **migrate**; `integrations/whmcs/*.php`→**none** (customer-side plugin, not an image). tagmanager reaches gcr/goproxy/pypi → no Google-block patches needed there.

**Kafka image:** `kafka_deploy` (confirm:true) pulls `apache/kafka:3.9.0` — a **docker.io** image, not built here. If a target node is egress-blocked, relay it like any other: pull on tagmanager → tag/push to prod3 `$REG` → node pulls at LAN speed. See **adpix-kafka**.

---
## UPGRADE existing nodes to latest (fast) — pull from prod3:5000
Registry now on prod3 → prod3 pulls are **localhost (instant)**, prod2 pulls over the **~550 MB/s** prod-link (instant). The slow link was already paid once at PUSH. Compose uses `build:` (no `image:`) → pull + **retag to local name** + `up --no-build`. Roll ONLY changed services.
```sh
REG=188.121.121.28:5000
cd /opt/adpix && git fetch && git stash && git merge --ff-only origin/main && git stash pop  # advance HEAD, keep local patches
# pull changed images. prod3 = instant. prod2 = fast but detached anyway (transport-safe):
for s in <changed-svcs>; do docker pull $REG/adanalytics-$s:latest && docker tag $REG/adanalytics-$s:latest adanalytics-$s:latest; done
docker compose -p adanalytics -f compose.yaml -f compose.prod.yaml run --rm --no-deps migrate   # only if migrations/ changed
docker compose -p adanalytics -f compose.yaml -f compose.prod.yaml up -d --no-build <changed-svcs>
docker inspect -f '{{.Image}}' adanalytics-<svc>-1   # VERIFY == pushed ID
curl -sk --resolve analytics.adpix.io:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' https://analytics.adpix.io/api/v1/version
```
**Do prod3 (PRIMARY) + prod2 in PARALLEL** (both pulls instant now) — not sequential. For zero-downtime do one at a time (`bluegreen_deploy` style).

### Lessons baked in (cost me time before)
- **Inline `docker pull/push/build` over the slow link DROPS the MCP transport** mid-op → wasted re-do (lost ~8min/round). ALWAYS detached (`systemd-run --unit=X` + poll `systemctl is-active`). With the registry on prod3 this only matters for the tagmanager→prod3 PUSH; node pulls are now LAN-fast.
- **ALWAYS verify image ID after pull** — `up -d --no-build` only recreates if the image ID changed, so a silently-failed pull leaves the OLD version running looking "deployed". Assert `docker inspect -f '{{.Image}}' <ctr>` == pushed ID before declaring done.
- **prod2 disk fills from leftover build cache** — it no longer builds (pull-only), so `docker builder prune -af` reclaims big (freed 5.5 GB once: 89%→57%). `docker image prune -af` clears old registry-ref images too.
- HEAD advance: `git fetch` FIRST or ff-merge is a no-op (HEAD stays behind). stash/pop preserves local Caddyfile/Dockerfile/geo patches (different files than upstream).

---
## LAUNCH a brand-new node (fast recovery / scale-out)
1. **Register + recon** (server_add; key readable by adpixmcp). Confirm it reaches the prod3 registry `188.121.121.28:5000` (and the prod-link is fast — same provider as prod3 ideal).
2. **Bootstrap** (detached): `curl -fsSL https://get.docker.com|sh`; set insecure-registry `188.121.121.28:5000` + `systemctl reload docker` + `docker login` (above); pull images from prod3 (LAN-fast).
3. **Compose + config + secrets** (NOT source build): relay/clone the checkout for `compose*.yaml` + `ops/caddy` + `migrations` + `.env` (+ `/opt/adpix-tagmanager/deploy` + `deploy/.env` + `deploy/oidc_key.pem`). Set `PG_BIND_IP=127.0.0.1`.
4. **Pull all images** from the registry + retag (analytics + deploy), per above.
5. **Datastores up → restore data** (latest off-host backup if available, else `pg_dumpall` + CH Native from the source node via the relay). Run `migrate`. **Fix `integrity_net_dict`** creds + RELOAD.
6. **Up** analytics + deploy stacks (`up -d --no-build`). Connect deploy svc to `adanalytics_default` with aliases `tm-auth/tm-api/tm-console`. Re-add the `account`/`tagmanager` Caddy routes (see adpix-host-migrate §7).
7. **Verify** locally (`curl --resolve`), then DNS cutover, then verify external + decommission old.

---
## Make it permanently fast (recommend to the operator/dev)
- **CI builds+pushes on release** (tagged by git SHA) → nodes only ever pull. Removes the build phase entirely.
- **Land the Google-block patches upstream** (GOPROXY/GOSUMDB/git in Go Dockerfiles, pip retries, distroless via a docker.io-hosted base or the registry) so images build anywhere.
- **Off-host backup sync** (`.env BACKUP_SYNC_DEST`) so a new node restores data from object storage, not the old node.
- **Add `image:` refs to the compose** (registry path) so plain `docker compose pull && up` works with no retag step.
- **Golden base image / cloud-init** that pre-installs docker + registry trust + the checkout, so step 2-3 are one command.
- Keep a **versioned secrets bundle** (`.env`, `deploy/.env`, `oidc_key.pem`, caddy patch) in a vault so no live reconstruction.

---
Related skills: **adpix-offline-build** (fallback when the registry is unavailable / build-phase failures), **adpix-kafka** (kafka_deploy image relay + streaming health), **adpix-performance** (scale/tune after the deploy), **adpix-host-migrate** (full-node move, §7 Caddy routes), **adpix-devops** (prereq).
