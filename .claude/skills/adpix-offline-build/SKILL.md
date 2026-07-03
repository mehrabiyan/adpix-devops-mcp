---
name: adpix-offline-build
description: Build/deploy AdPix Docker images onto the Google-egress-blocked prod nodes (prod1/2/3). Use when a build/deploy on those nodes fails with gcr.io 403 / "failed to authorize ... EOF" / proxy.golang.org 403 / sum.golang.org timeout / pip ReadTimeout, or when adpix_update/stack_update/deploy.sh dies in the build phase. Covers the Dockerfile patches, the distroless relay, the build-on-tagmanager + image relay, and detached builds.
---

# Offline / relay builds for Google-blocked AdPix nodes

Prereq: read **adpix-devops** (the Google block, MCP long-call drop, tagmanager relay). prod1/2/3 block all Google; tagmanager reaches everything. Run every build **detached** via `systemd-run` + poll (see adpix-devops).

## Decide: patch-and-build-on-node vs build-on-tagmanager-and-relay
- **Node can build** (prod3: docker.io + goproxy reachable) → patch Dockerfiles + relay only the distroless base. Faster, node stays self-sufficient.
- **Node can't build / too small / urgent** (prod1) → **build on tagmanager**, `docker save | gzip` → relay → `docker load` on the node, run with `up -d --no-build`.

## Dockerfile patches (the durable fix — also tell the dev to land upstream)
Run on the node's checkout (these survive only until the next `git pull`; adpix_update/stack_update reset them — so for a managed deploy the DEV must commit them).

Go services (`services/*/Dockerfile` with `FROM golang…AS build`):
```sh
for df in $(grep -rlE '^FROM golang' services/*/Dockerfile); do
  grep -q 'GOPROXY=' "$df" || sed -i '/^FROM golang.*AS build/a ENV GOPROXY=https://goproxy.cn,https://goproxy.io GOSUMDB=off GOTOOLCHAIN=local' "$df"
  grep -q 'apk add --no-cache git' "$df" || sed -i '/ENV GOPROXY=/a RUN apk add --no-cache git' "$df"
done
```
- Do NOT use `GOPROXY=…,direct` — the `direct` fallback hits `golang.org` (Google) → 403. Two non-Google proxies, no `direct`.
- `git` is needed because the proxies occasionally fall back to VCS for odd pseudo-versions and `golang:alpine` ships without git.

Python jobs (`pip install`): `sed -i 's#pip install --no-cache-dir#pip install --no-cache-dir --timeout 300 --retries 8#g' services/*/Dockerfile` (PyPI reads stall on the big ML wheels). If still timing out, relay those images from tagmanager instead.

## Relay the gcr.io/distroless base (web image needs it; gcr.io is blocked)
```sh
# tagmanager (reaches gcr.io):
docker pull gcr.io/distroless/nodejs22-debian12:latest
docker save gcr.io/distroless/nodejs22-debian12:latest | gzip > /tmp/distroless.tgz   # serve via :8000 bridge
# node:
curl -fsS http://188.245.92.203:8000/distroless.tgz | gunzip | docker load
```
With the image in the local store, BuildKit uses it for `FROM gcr.io/distroless/...` without contacting gcr.io.

- Kafka: `kafka_deploy` pulls **apache/kafka:3.9.0** — a docker.io image (NOT Google). If the node reaches docker.io it needs no relay; if not, relay it exactly like the distroless base (save → :8000 bridge → load). See **adpix-kafka**.

## Build-on-tagmanager + relay finished images (Option B)
```sh
# tagmanager: update checkout to target commit, then build with the SAME project name the node uses
cd /opt/adpix && git fetch && git reset --hard origin/main
systemd-run --unit=bld --working-directory=/opt/adpix /usr/bin/docker compose -p adanalytics -f compose.yaml -f compose.prod.yaml build   # poll
# save ONLY the images that changed (compare IDs node-vs-tagmanager, or `git diff --name-only A B` → services)
docker save adanalytics-web:latest adanalytics-api:latest … | gzip > /tmp/imgs.tgz
# node: stream-load (no tar on disk if disk-tight), detached
systemd-run --unit=ld /bin/bash -c 'curl -fsS http://188.245.92.203:8000/imgs.tgz | gunzip | docker load'
# then on node: docker compose -p adanalytics -f compose.yaml -f compose.prod.yaml up -d --no-build
```
- `up -d --no-build` uses locally-present images; unchanged services keep the node's existing tagged image (don't relay them).
- Pre-pull docker.io bases sequentially on the node to dodge parallel-pull rate-limit EOFs: `for img in golang:1.24-alpine alpine:3.20 node:20-alpine python:3.11-slim postgres:17-alpine; do docker pull "$img"; done`.

## Disk watch (small nodes)
Builds fill `/`. Check `df -h /` + `docker system df`. Reclaim with `docker builder prune -af` / `docker image prune -af` (needs `confirm:true`). On a 100%-full box, container logs `truncate -s0 /var/lib/docker/containers/*/*-json.log`. If still wedged → the node is undersized (resize/migrate; see adpix-host-migrate). Stream-loads can stall a single-threaded python bridge — download to a file (measurable) and restart the bridge if a big transfer hangs.

Related skills: **adpix-devops** (the Google block + relay + detached-build primitives), **adpix-fast-deploy** (the FAST path — prefer it; fall back here when the registry is unavailable), **adpix-kafka** (deploying/operating the apache/kafka:3.9.0 broker), **adpix-host-migrate** (when a node is too undersized to build at all).
