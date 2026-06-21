#!/usr/bin/env bash
# AdPix DevOps MCP — interactive setup wizard (shell TUI front-end over the install core).
# Gathers the MCP host config + the fleet + the optional HA cluster, builds an InstallAnswers
# JSON, and drives node dist/install/cli.js. Secrets go to ENV (never the answers file, never
# argv, never the journal). gum gives the rich UI; plain prompts are the fallback.
#
#   sudo ./scripts/adpix-setup.sh           # interactive
#   sudo ./scripts/adpix-setup.sh --dry-run # show the plan, change nothing
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
# shellcheck source=scripts/wizard/ui.sh
. "$HERE/wizard/ui.sh"

[ "$(id -u)" -eq 0 ] || { ui_err "run as root (sudo)."; exit 1; }
if [ ! -t 0 ]; then
  ui_err "no TTY — this wizard is interactive. For automation use:"
  ui_say "  node $REPO/dist/install/cli.js --answers-file answers.json"
  exit 1
fi

# Ensure the install core is built (the CLI we drive).
CLI="$REPO/dist/install/cli.js"
if [ ! -f "$CLI" ]; then
  ui_say "Building the install core…"
  ( cd "$REPO" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null ) || { ui_err "build failed — run 'npm ci && npm run build' in $REPO"; exit 1; }
fi

# ---- S1 preflight -----------------------------------------------------------
ui_title "AdPix DevOps MCP — setup"
. /etc/os-release 2>/dev/null || true
case "${ID:-}${ID_LIKE:-}" in *debian*|*ubuntu*) ui_ok "OS: ${PRETTY_NAME:-Ubuntu/Debian}";; *) ui_err "this installer targets Ubuntu/Debian (found ${PRETTY_NAME:-unknown})."; exit 1;; esac
command -v node >/dev/null 2>&1 && ui_ok "Node: $(node -v)" || ui_warn "Node not found — install-server.sh will install it"

# ---- S2 MCP host ------------------------------------------------------------
ui_title "MCP host"
MODE="$(ui_choose "Serving mode" "Domain + HTTPS (Caddy/Let's Encrypt)" "HTTP only (loopback/tunnel)")"
DOMAIN=""
[ "$MODE" = "Domain + HTTPS (Caddy/Let's Encrypt)" ] && DOMAIN="$(ui_input "MCP domain (e.g. mcp.example.com)")"
PORT="$(ui_input "MCP port" "8930")"
if ui_confirm "Enable AI self-heal (needs an Anthropic API key)?"; then
  ANTHROPIC_API_KEY="$(ui_password "ANTHROPIC_API_KEY")"; export ANTHROPIC_API_KEY
fi

# ---- S3 fleet ---------------------------------------------------------------
ui_title "Fleet (the AdPix servers this MCP manages)"
FLEET_RECORDS=""   # one TAB-delimited record per line: name host port user role dir auth
while ui_confirm "Add an AdPix server?"; do
  NAME="$(ui_input "  name" "prod")"
  HOST="$(ui_input "  host / IP")"
  SUSER="$(ui_input "  ssh user" "root")"
  SPORT="$(ui_input "  ssh port" "22")"
  ADIR="$(ui_input "  AdPix dir" "/opt/adpix")"
  ROLE="$(ui_choose "  role" "standalone" "node" "witness")"
  AUTH="$(ui_choose "  bootstrap auth (one-shot, to install the MCP key)" "agent" "password" "keyfile")"
  if [ "$AUTH" = password ]; then ADPIX_SSH_PASSWORD="$(ui_password "  ssh password (one-shot, not stored)")"; export ADPIX_SSH_PASSWORD; fi
  FLEET_RECORDS+="${NAME}	${HOST}	${SPORT}	${SUSER}	${ROLE}	${ADIR}	${AUTH}"$'\n'
  ui_ok "added ${NAME} (${SUSER}@${HOST})"
done

# ---- S4 HA cluster (optional) ----------------------------------------------
CLUSTER_NAME=""; CLUSTER_VIP=""
ui_title "HA cluster (optional)"
if ui_confirm "Configure an HA cluster (witness + nodes + VIP)?"; then
  CLUSTER_NAME="$(ui_input "  cluster name" "prod")"
  CLUSTER_VIP="$(ui_input "  floating VIP (keepalived)")"
fi

# ---- build the answers JSON (secrets stay in env) ---------------------------
ANS="$(mktemp)"; chmod 600 "$ANS"; trap 'rm -f "$ANS"' EXIT
FLEET_RECORDS="$FLEET_RECORDS" DOMAIN="$DOMAIN" PORT="$PORT" CLUSTER_NAME="$CLUSTER_NAME" CLUSTER_VIP="$CLUSTER_VIP" \
  node "$REPO/dist/install/answers-build.js" > "$ANS" || { ui_err "failed to build answers"; exit 1; }

# ---- S6 review + S7 run -----------------------------------------------------
ui_title "Review"
# Read+parse the file explicitly: require() on a no-.json-extension temp file parses it as JS.
node -e "const fs=require('fs'); const a=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log(JSON.stringify({...a, fleet:a.fleet.map(m=>({name:m.name,host:m.host,user:m.username,role:m.role}))}, null, 2))" "$ANS"
ui_say "(secrets are held in environment only — not in this file)"
PASSTHRU=""
for arg in "$@"; do PASSTHRU+=" $arg"; done
if [ -z "$PASSTHRU" ]; then ui_confirm "Proceed with the install?" || { ui_warn "aborted — nothing changed."; exit 0; }; fi

ui_title "Installing"
# shellcheck disable=SC2086
node "$CLI" --answers-file "$ANS" $PASSTHRU
