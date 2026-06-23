# Upstream fixes for the AdPix app repos

These are real defects hit during the `188.245.92.203` bring-up. They live in the **product repos**, not
in `adpix-devops-mcp` — the MCP install tools can detect/warn and work around some, but CD keeps
reintroducing them until they're landed upstream **with tests**. Each item: file, symptom, fix, and the
test that makes it permanent.

The MCP-side gaps from the same bring-up are tracked separately in `adpix-devops-mcp` (see the bottom
section) — those are being fixed in this repo.

---

## `github.com/mehrabiyan/adpix` (Analytics)

### A1 — `scripts/deploy.sh` only generates secrets when `.env` is ABSENT  *(P0, blocks api boot)*
A pre-existing/partial `.env` (failed run, committed sample) is reused as-is, leaving `SERVER_API_KEY=demo…`
and empty `CLICKHOUSE_PASSWORD`. The api fail-fasts: `APP_ENV=production but insecure/missing secrets`.
**Fix:** make secret provisioning idempotent + validating — on *every* run, for each required secret,
generate one if missing/empty/default (`openssl rand -hex 24`), else keep it; never ship a `.env` whose
`demo`/empty values satisfy a file-exists check.
**Test:** `deploy.sh` fills/upgrades weak secrets even when `.env` pre-exists.

### A2 — ClickHouse `ops/clickhouse/users.d/allow-network.xml` missing `replace`  *(P0, blocks CH boot in prod)*
`<password from_env="CLICKHOUSE_PASSWORD"/>` works with an empty password (dev) but CH 25.3 refuses to
start with a non-empty one: *"Element <password> has value and does not have 'replace' attribute"*.
**Fix:** `<password from_env="CLICKHOUSE_PASSWORD" replace="replace"/>` (mirror the sibling
`<networks replace="replace">`).
**Test:** boot CH with a non-empty `CLICKHOUSE_PASSWORD` and assert healthy.

### A3 — `scripts/migrate.sh` exports an empty `PGSSLMODE`  *(P0, false "postgres not ready")*
`export PGSSLMODE="${PGSSLMODE:-}"` → libpq rejects an empty sslmode → `pg_isready` never succeeds →
`ERROR: postgres not ready after 120s` though PG is healthy; `2>/dev/null` hides the real reason.
**Fix:** `[ -n "${PGSSLMODE:-}" ] && export PGSSLMODE` (only when set); don't swallow the `pg_isready` error
while diagnosing.

### A4 — `scripts/migrate.sh` comment-aware SQL splitting  *(P0, silently corrupts the schema)*
`tr ';' '\0' < "$f"` shreds any SQL comment containing `;`. `0006_full_geo.sql` splits inside the header
comment; `sort key unchanged.` is sent as SQL and the prose is prepended to the next statement — eating the
`ALTER TABLE events_local ADD COLUMN … ip …`, so later MVs fail `UNKNOWN_IDENTIFIER 'ip'`. Compounding:
`[ -n "$out" ] && exit 1` treats any non-empty HTTP body as fatal under `set -e`.
**Fix:** pipe each file to `clickhouse-client --multiquery < "$f"` (handles comments + multi-statement
natively) and check HTTP status / `--fail` instead of non-empty output. Delete the hand-rolled splitter.
**Test (A3+A4):** run `migrate.sh` against fresh PG+CH with `APP_ENV=production` + a non-empty CH password,
then assert *all* tables/columns exist (esp. `events_local.ip` and the integrity MVs).

### A5 — `OIDC_REQUIRE_EMAIL_VERIFIED` defaults `true` vs the house IdP  *(P1, blocks SSO)*
The api requires a verified email but the Account IdP doesn't emit `email_verified` (see B2). Every SSO login
is rejected. **Real fix is in the IdP (B2);** until then default `false` for the trusted house IdP and
document the cross-repo dependency.

### A6 — `web` bakes `NEXT_PUBLIC_API_BASE=http://localhost:8081`  *(P1, dashboard calls localhost)*
`NEXT_PUBLIC_*` are inlined at **build time**; a runtime `.env` change does nothing.
**Fix:** pass `NEXT_PUBLIC_API_BASE` (public api origin) as a **build arg** and rebuild per environment.
**Test:** grep the built bundle in CI — must not contain `localhost:8081`.

---

## `github.com/mehrabiyan/AdpixTagManager` (Tag Manager + IdP + Console)

### B1 — `deploy/varnish.vcl` invalid VCL (crash-loop)  *(P0)*
VCL has no C ternary. `set resp.http.X-Cache = obj.hits > 0 ? "HIT" : "MISS";` → VCC-compiler failed.
**Fix:** use `if (obj.hits > 0) { … } else { … }`.
**Test:** `varnishd -C -f deploy/varnish.vcl` (compile-check) in CI.

### B2 — IdP id_token omits `email_verified`  *(P0, every RP login rejected)*
`apps/auth/src/app.ts` signs only `iss,sub,aud,email,name,locale,nonce`. RPs that require a verified email
reject all logins; marking the user verified in the DB does nothing (claim never emitted).
**Fix:** emit `email_verified: user.emailVerified === true`; add it to `claims_supported`; bootstrap the admin
with `emailVerified: true`.
**Test:** id_token contains `email_verified` for a verified user.

### B3 — Client redirect origins hard-default  *(P0, console/analytics can't log in)*
`apps/auth/src/clients.ts` builds `tm-console` / `analytics-console` redirect URIs from `CONSOLE_ORIGIN` /
`ANALYTICS_ORIGIN` / `ANALYTICS_API_ORIGIN`. The app reads them correctly — but they must be **passed in**.
**App side:** keep reading the env (already correct); document the three vars. **MCP side:** `account_install`
now passes them through (see the MCP section). **Test:** `/authorize` accepts the configured `CONSOLE_ORIGIN`
redirect and rejects others.

### B4 — No console build/deploy path  *(P0, the management UI never ships)*
`apps/console` (Next.js) has `next build/start` but **no `deploy/Dockerfile.console` and no compose service**.
**Fix (recommended, app side):** add `deploy/Dockerfile.console` + a compose service so CD builds it. A
verified Dockerfile is in the bring-up guide. **Critical:** `NEXT_PUBLIC_*` (API URL, issuer, client id,
product URLs) are inlined at **build time** — changing them needs a rebuild, not a restart; document loudly.
> The MCP now ships a `console_install` that builds this image with the right build-args even before the repo
> carries the Dockerfile (mirroring how `account_install` ships `Dockerfile.auth`). Landing it upstream lets CD
> own it.

### B5 — `tm_health` edge probe is a host-direct false negative  *(P2, cosmetic but misleading)*
`apps/edge` (:8585) is intentionally not host-published (it sits behind varnish), so a host-direct probe
reports DOWN even when edge is healthy. **This is an MCP-tool issue (fixed in this repo);** noted here so the
edge's intended topology (behind varnish, internal `{"ok":true}`) is documented for any health tooling.

---

## Cross-cutting

- **One reverse proxy owns :80/:443.** Multiple products on one box need ONE Caddy fanning out by host —
  never two (port clash). Analytics ships a Caddy; the IdP's `account_install` Caddy is for an IdP-only box.
  On a shared box, route everything through one Caddyfile.
- **One product per directory.** `/opt/adpix` (Analytics), `/opt/adpix-tagmanager` (TM/IdP/console). Never
  repoint a host's registry `adpixDir` across products (see MCP M1).
- **Deploy keys are per-repo.** `adpix` and `AdpixTagManager` need *separate* read-only deploy keys, each added
  to its own repo's Settings → Deploy keys. The MCP's authorization probe is now isolated + self-diagnosing.

---

## MCP-side (being fixed in `adpix-devops-mcp`, for reference)

- **M1** — `adpix_install`: explicit `dir` param + the pre-clone `rm -rf` only removes a checkout of THIS repo
  (never an arbitrary dir). Closes the cross-product data-loss footgun.
- **M2** — `account_install`: pass `CONSOLE_ORIGIN` / `ANALYTICS_ORIGIN` / `ANALYTICS_API_ORIGIN` to the auth
  container (params + `.env.account`), so the IdP registers real redirect URIs (B3).
- **M3** — `console_install`: build + run `apps/console` (ships a `Dockerfile.console`, NEXT_PUBLIC build args,
  Caddy route), so the management UI ships (B4).
- **M4** — `tm_health`: probe edge through varnish / the compose network, not host-direct (B5).
- **M5** — install **self-diagnostics**: detect the A1–A4 signatures (weak `.env`, CH `from_env` without
  `replace`, empty `PGSSLMODE`, comment-split migration errors) and surface the exact upstream fix instead of an
  opaque failure.
