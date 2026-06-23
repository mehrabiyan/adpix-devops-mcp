# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

`adpix-devops-mcp` — an [MCP](https://modelcontextprotocol.io) server that acts as a DevOps/SRE for the AdPix stack (Analytics, Tag Manager, Account/IdP). It reaches target servers over SSH and runs Docker/compose, Postgres/ClickHouse, CI/CD, HA, monitoring, and install/lifecycle operations. **86 tools.** Ships with a web **control panel** (AdPix Cloud) and a guided **setup wizard**.

TypeScript ESM. Node 18+. `tsc` → `dist/`. Tests: vitest (**612**, all green — keep it that way).

## Build / test / run loop

```bash
npm run build          # tsc + copies src/panel/public → dist/panel/public (the panel is served from dist)
npx vitest run         # full suite; or `npx vitest run test/<file>.test.ts`
npm run typecheck      # tsc --noEmit
```

Panel dev restart (after an app.js / server.ts change):

```bash
pkill -f "dist/index.js --panel"; TOK=$(cat /tmp/adpix-panel-token)
ADPIX_PANEL_TOKEN=$TOK ADPIX_MCP_ROOT="$PWD" node dist/index.js --panel --port 8931 &
# open http://127.0.0.1:8931/#token=$TOK   (the SPA is blank without the #token)
```

Run modes (`src/index.ts`): **stdio** (default, the MCP transport) · `--http` (hosted, Bearer token) · `--panel` · `--wizard`.

## Architecture

- **Tools** live in `src/tools/*.ts`, each exporting a `ToolDef[]`; all are aggregated in `src/tools/index.ts` (`allTools`). A `ToolDef` is `{ name, title, description, schema (zod object), annotations, handler(deps, args) → Promise<string> }`. **Handlers return TEXT (markdown).** A thrown handler maps to an MCP `isError` result.
- **Deps seam** (`src/deps.ts`): `{ resolve(name?), connect(server), local(cmd) }`. Use `withSession(deps, serverName, async (s, srv) => …)` — it resolves, connects, runs, and closes. `s.exec(cmd, { timeoutMs })` runs on the target; `deps.local(cmd)` runs on the MCP host (e.g. the deploy-key probe). For multi-server tools (e.g. `service_relocate`) call `deps.resolve` + `deps.connect` per host and `.close()` each.
- **Stack model** (`src/tools/stack.ts`): per-stack stateless/stateful service lists + compose/health builders. Reuse `stackServices` / `stackComposeCmd` / `stackHealthCmd` / `STACK_META` rather than re-deriving.
- **Panel**: vanilla-JS SPA `src/panel/public/app.js` + a `node:http` server `src/panel/server.ts`; job engine `src/panel/engine.ts` (SSE; the `done` event carries `job.result`). Design system "AdPix Cloud" (CSS vars `--c-bg/--c-brand/…`). No build step for the SPA — it's copied to dist as-is.
- **Deploy keys** (`src/github.ts`): one shared, read-only, MCP-managed key per repo; the authorization probe is isolated (`-i … -o IdentitiesOnly=yes -o IdentityAgent=none -F /dev/null`) so the operator's personal key can't give a false "authorized". `diagnoseDeployKey` asks GitHub who the key is from the failing host.

## Conventions (follow these)

- **ESM imports use `.js`** extensions (`import { x } from "./util.js"`) even though the source is `.ts`.
- **Destructive-tool safety:** dry-run/preview by default, `confirm:true` to execute, preflight resources, verify-before-destroy, keep the source until the target is verified, warn on interruption. Mirror an existing destructive tool (`service_relocate`, `stack_update`, `container_control`).
- **Secrets:** never print them. Redact tool output with `redactSecrets` (`src/util.ts`). The registry stores a key **path**, never the bytes; passwords/passphrases are env-only, never written.
- **Match the surrounding style** — terse comments that explain *why*, the same shell-quoting (`shq`), `lastLines`, the same section-markdown shape (`## …`).

## Testing patterns

- Per-handler: `tool("name").handler(fakeDeps, args)` with regex→`ExecResult` responders. `responses` answer the target session; `localResponses` answer `deps.local`. See `test/tagmanager.test.ts`, `test/relocate.test.ts`, `test/deploy-flow.test.ts`.
- **Gotcha:** a direct `handler(deps, args)` call does **not** apply Zod schema defaults — pass every field the handler reads (e.g. `confirm: false`, `timeoutSeconds: 600`) explicitly in tests.
- Regexes match the *real* shell strings; remember shell quotes (e.g. `.git'` not `.git `) when writing them.
- Integration (`test/integration.test.ts`) drives the real MCP server in-memory and has a fixture per tool — add one when you add a tool, and bump the count assertions in `test/postgres.test.ts`.
- Panel endpoints: `servePanel({ port: 0, host, token, deps })` + `fetch`. Token actor is `owner` when no admins exist (set a temp `ADPIX_DEVOPS_HOME`).
- `test/deploy-flow.test.ts` is the regression suite — one guard per real failure we hit. Add to it when fixing a deploy/install bug.

## Git

- Branch off the current branch; **push only when asked.**
- End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- After a change: build, run the full suite green, restart the panel if the UI changed, then commit.
