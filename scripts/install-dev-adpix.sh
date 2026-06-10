#!/usr/bin/env bash
# One-command installer for THIS deployment of the AdPix DevOps MCP:
#
#     MCP address:  https://dev.adpix.io
#     Server:       167.233.101.248  (Ubuntu/Debian, run as root)
#
#   curl -fsSL https://raw.githubusercontent.com/mehrabiyan/adpix-devops-mcp/main/scripts/install-dev-adpix.sh | sudo bash
#   (until the branch is merged to main, swap main for the current default branch)
#
# Optional env:
#   ANTHROPIC_API_KEY=sk-...   enable the AI self-heal hook (Claude Code OnFailure)
#   BRANCH=<name>              install a specific branch instead of the repo default
#
# It sanity-checks the box + DNS, fetches the (public) repo, runs the generic
# scripts/install-server.sh with the dev.adpix.io settings, then verifies HTTPS
# end to end. Idempotent — re-run any time to update.
set -euo pipefail

export MCP_DOMAIN="${MCP_DOMAIN:-dev.adpix.io}"
export MCP_PORT="${MCP_PORT:-8930}"
export REPO_URL="${REPO_URL:-https://github.com/mehrabiyan/adpix-devops-mcp.git}"
export BRANCH="${BRANCH:-}"
EXPECTED_IP="${EXPECTED_IP:-167.233.101.248}"
INSTALL_DIR=/opt/adpix-devops-mcp
ENV_FILE=/etc/adpix-devops-mcp/env

say()  { printf '\n\033[1;36m>> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)."

# --- guard: is this the right box? ---------------------------------------------
PUB_IP="$(curl -fsS -m 10 https://ipv4.icanhazip.com 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
PUB_IP="$(printf '%s' "$PUB_IP" | tr -d '[:space:]')"
if [ -n "$PUB_IP" ] && [ "$PUB_IP" != "$EXPECTED_IP" ]; then
  warn "this server's public IP looks like $PUB_IP, but $MCP_DOMAIN is meant for $EXPECTED_IP."
  warn "continuing in 10s — Ctrl-C to abort (set EXPECTED_IP=$PUB_IP to silence this check)."
  sleep 10
fi

# --- guard: DNS (Caddy needs the A record for Let's Encrypt) ---------------------
DNS_IP="$(getent ahostsv4 "$MCP_DOMAIN" 2>/dev/null | awk '{print $1; exit}')"
if [ -z "$DNS_IP" ]; then
  warn "$MCP_DOMAIN does not resolve yet. Add the DNS record:   $MCP_DOMAIN  A  $EXPECTED_IP"
  warn "Installing anyway — Caddy retries certificate issuance automatically once DNS is live."
elif [ "$DNS_IP" != "$EXPECTED_IP" ] && [ "$DNS_IP" != "${PUB_IP:-$EXPECTED_IP}" ]; then
  warn "$MCP_DOMAIN currently resolves to $DNS_IP (expected $EXPECTED_IP) — HTTPS issuance will fail until the A record is fixed."
fi

# --- fetch the repo and hand off to the generic installer -------------------------
command -v git >/dev/null 2>&1 || {
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git ca-certificates >/dev/null
}
if [ -d "$INSTALL_DIR/.git" ]; then
  say "Updating existing checkout…"
  git -C "$INSTALL_DIR" fetch origin
  [ -n "$BRANCH" ] && git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only
else
  say "Cloning $REPO_URL…"
  git clone ${BRANCH:+-b "$BRANCH"} "$REPO_URL" "$INSTALL_DIR"
fi

bash "$INSTALL_DIR/scripts/install-server.sh"

# --- verify the public HTTPS endpoint ----------------------------------------------
say "Waiting for https://$MCP_DOMAIN (first Let's Encrypt issuance can take ~30-60s)…"
live=""
for i in $(seq 1 18); do
  if curl -fsS -m 5 "https://$MCP_DOMAIN/healthz" 2>/dev/null | grep -q '^ok'; then live=1; break; fi
  sleep 5
done

TOKEN="$(grep '^MCP_AUTH_TOKEN=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
if [ -n "$live" ]; then
  cat <<EOF

============================================================
 https://$MCP_DOMAIN is LIVE (TLS verified end to end).

 Connect from Claude Code:
   claude mcp add --transport http adpix-devops https://$MCP_DOMAIN/mcp \\
     --header "Authorization: Bearer $TOKEN"
============================================================
EOF
else
  warn "https://$MCP_DOMAIN is not answering yet (the local service IS healthy)."
  warn "Usual causes, in order:"
  warn "  1. DNS: $MCP_DOMAIN A-record must point at $EXPECTED_IP (currently: ${DNS_IP:-unresolved})"
  warn "  2. Cloud firewall: ports 80 + 443 must be open to this server"
  warn "  3. Certificate still being issued — watch: journalctl -u caddy -f"
  warn "Once DNS + ports are right it goes live by itself; re-run this script any time to re-check."
fi
