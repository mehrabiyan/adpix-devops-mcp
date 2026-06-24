# Installing the AdPix stack with the MCP tools (the path that works)

The panel/wizard is a fixed happy-path. Driving the **tools directly** (ask Claude, or call them from any
MCP client) is what reliably installs everything, because each step can adapt — pass the right args, read
the output, run a workaround, retry. This is the exact order used to bring up `188.245.92.203`.

> Prereqs: DNS A-records resolve to the host **before** install (Let's Encrypt HTTP-01); ports 80/443 open
> at the **cloud** firewall; one separate **read-only deploy key per repo** (`adpix`, `AdpixTagManager`)
> added to that repo's Settings → Deploy keys. One product per directory: `/opt/adpix` (Analytics),
> `/opt/adpix-tagmanager` (TM/IdP/console).

## 0. Register the server

```
server_add  name=prod host=<ip> user=root key=~/.ssh/id_ed25519
```

## 1. Account / IdP  (`auth.adpix.io`)

```
account_install
  server=prod  domain=auth.adpix.io
  consoleOrigin=https://tag.adpix.io
  analyticsOrigin=https://app.adpix.io
  analyticsApiOrigin=https://app.adpix.io
```

Self-contained: embedded PGlite, stable signing key, Caddy front door (auto Let's Encrypt on :80/:443).
The origins make the IdP register real redirect URIs for `tm-console` + `analytics-console` (without them you
get `Invalid redirect_uri` at `/authorize`). Capture the bootstrap admin (in `deploy/.env.account`); change it
on first login. Verify: `curl -s https://auth.adpix.io/.well-known/openid-configuration | jq .issuer`.

## 2. Tag Manager delivery core  (api :8686, edge behind varnish)

```
tm_install  server=prod  authIssuer=https://auth.adpix.io  dbContainer=true
            s3AccessKey=<gen>  s3SecretKey=<gen>  purgeToken=<gen>   # blank → auto-generated
```

This is the **delivery plane only** (api + edge + varnish + minio + redis + purge-bridge). It does NOT ship the
console UI — that's step 3. Confirm the upstream `varnish.vcl` fix (B1) is landed or varnish crash-loops.

## 3. Tag Manager console UI  (`tag.adpix.io`)

```
console_install  server=prod  domain=tag.adpix.io
                 authIssuer=https://auth.adpix.io  apiUrl=https://tag.adpix.io/api
                 analyticsUrl=https://app.adpix.io
```

Builds `apps/console` (Next.js) with the `NEXT_PUBLIC_*` baked at **build time** + a Caddy route that
path-strips `/api/*` → the TM api. **Any later change to those URLs needs a rebuild, not a restart.**

## 4. Analytics  (`app.adpix.io`)

```
adpix_install  server=prod  dir=/opt/adpix  domain=app.adpix.io
```

Pass `dir` explicitly (don't rely on the registry default; keeps products from colliding). On an unpatched
tree the install may stop at: api boot (A1), CH boot (A2), the migrate PG wait (A3), or the first CH migration
(A4) — apply the upstream fix and re-run (`deploy.sh` is idempotent). The install now **names which one** it
hit. Workaround for A4 if you can't patch yet: apply `migrations/clickhouse/*.sql` via
`clickhouse-client --multiquery`.

Then wire Analytics as an OIDC client (its `.env`): `AUTH_PROVIDER=keycloak`, `OIDC_ISSUER=https://auth.adpix.io`,
`OIDC_CLIENT_ID=analytics-console`, `OIDC_PLATFORM_AUDIENCE=adpix-analytics`,
`OIDC_REQUIRE_EMAIL_VERIFIED=false` (until the IdP emits `email_verified`, B2), recreate `api`.

## 5. Verify

```
oidc_health   server=prod            # IdP discovery + issuer match + JWKS + TLS
tm_health     server=prod            # api + edge(via varnish) + varnish
adpix_status  server=prod            # containers, version, URL
health_check  server=prod            # front door through the real TLS path
```

## Intranet-only / air-gapped targets (only the MCP has internet)

`net_probe server=<box>` first → verdict **online / filtered / offline**.

1. **Tunnel (primary).** The MCP shares its internet:
   ```
   net_bridge  server=<box>  action=up      # points the target's apt/docker/git at the MCP, verifies github+docker
   account_install / tm_install / adpix_install …          # normal install, through the MCP's internet
   net_bridge  server=<box>  action=down    # restore direct egress
   ```
   Needs: the MCP host has internet; the target's sshd allows `AllowTcpForwarding` (default yes).
2. **Offline bundle (deep fallback, when the tunnel can't open).** The MCP builds + ships everything:
   ```
   offline_bundle   app=tagmanager  buildImages=true        # on the MCP: clone + docker save images → a tarball
   offline_install  server=<box>  app=tagmanager  bundlePath=/tmp/adpix-offline-tagmanager.tar.gz
   ```
   The MCP needs Docker matching the target's arch (default `linux/amd64`). A truly bare target (no
   Docker) needs Docker delivered first via the tunnel.
3. **TLS without Let's Encrypt.** Upload a key + cert (+ chain) in **Settings → Certificate Manager**
   (a `*.adpix.io` wildcard covers every sub-domain); `account_install`/`console_install` auto-serve it
   via Caddy `tls`. Internet-connected servers still get DV Let's Encrypt by default.

## Gotchas (memorize)

- **`NEXT_PUBLIC_*` is build-time** (console + analytics web) → rebuild per environment; a restart does nothing.
- **One shared Caddy** owns :80/:443 on a multi-product box; route by host. Don't stack two.
- **Repo on-box edits are clobbered by `git pull`/redeploy** (`varnish.vcl`, `migrate.sh`, `allow-network.xml`).
  Land them upstream (see `upstream-app-fixes.md`).
- **Deploy keys are per-repo.** Adding the `AdpixTagManager` key doesn't authorize `adpix`. If a clone fails
  `Permission denied`, the tool now asks GitHub from the server which repo the key belongs to.
- **Admin + signing key live in the `authdata` volume** — recreating the auth container preserves them.
