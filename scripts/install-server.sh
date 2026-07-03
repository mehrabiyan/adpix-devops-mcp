#!/usr/bin/env bash
# Install adpix-devops-mcp as a hosted (HTTP) MCP service on a fresh Ubuntu/Debian server.
#
#   curl -fsSL https://raw.githubusercontent.com/mehrabiyan/adpix-devops-mcp/main/scripts/install-server.sh | sudo bash
# or from a clone:   sudo ./scripts/install-server.sh
#
# Options (env vars):
#   MCP_DOMAIN=mcp.example.com   serve HTTPS via Caddy + Let's Encrypt (recommended; needs a DNS A-record)
#   MCP_PORT=8930                internal HTTP port (also the public port when no domain is set)
#   ANTHROPIC_API_KEY=sk-...     enable AI self-healing of this service (Claude Code, OnFailure hook)
#   REPO_URL / BRANCH            where to install from (default: this repo's GitHub main branch)
#   REPO_URL=git@github.com:…    private repo: sets up a read-only deploy key (prints it on first run)
#
# Idempotent: re-run any time to update (it preserves the auth token and env file).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/mehrabiyan/adpix-devops-mcp.git}"
BRANCH="${BRANCH:-}"
INSTALL_DIR=/opt/adpix-devops-mcp
ENV_FILE=/etc/adpix-devops-mcp/env
STATE_DIR=/var/lib/adpix-devops-mcp
LOG_DIR=/var/log/adpix-devops-mcp
SVC_USER=adpixmcp
MCP_PORT="${MCP_PORT:-8930}"
MCP_DOMAIN="${MCP_DOMAIN:-}"

say() { printf '\n\033[1;36m>> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)."
. /etc/os-release 2>/dev/null || true
case "${ID:-}${ID_LIKE:-}" in *debian*|*ubuntu*) ;; *) die "this installer targets Ubuntu/Debian (found: ${PRETTY_NAME:-unknown})." ;; esac

export DEBIAN_FRONTEND=noninteractive

# 1. base packages + Node.js >= 18 --------------------------------------------
say "Installing base packages…"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates openssl gnupg >/dev/null

need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  [ "${major:-0}" -ge 18 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  say "Installing Node.js 22 (NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
say "Node: $(node -v), npm: $(npm -v)"

# 2. service user + dirs + SSH identity ----------------------------------------
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$STATE_DIR" --create-home --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$STATE_DIR/.ssh" "$LOG_DIR" /etc/adpix-devops-mcp
chmod 700 "$STATE_DIR/.ssh"
if [ ! -f "$STATE_DIR/.ssh/id_ed25519" ]; then
  say "Generating the SSH identity this MCP uses to reach your AdPix servers…"
  ssh-keygen -t ed25519 -N "" -C "adpix-devops-mcp@$(hostname)" -f "$STATE_DIR/.ssh/id_ed25519" -q
fi
chown -R "$SVC_USER:$SVC_USER" "$STATE_DIR" "$LOG_DIR"

# 3. code ----------------------------------------------------------------------
# Private repo over SSH: REPO_SSH=1 (auto for git@ URLs) sets up a read-only
# deploy key owned by the service user, so the first manual clone, this
# installer, and the mcp_self_update tool all pull with the same key (and any
# token in an existing origin URL gets scrubbed). git runs as the service user
# in this mode so the key's ownership matches.
case "$REPO_URL" in git@*|ssh://*) REPO_SSH=1 ;; esac
DEPLOY_KEY="$STATE_DIR/.ssh/repo_deploy_ed25519"
GIT=(git)
if [ "${REPO_SSH:-0}" = "1" ]; then
  case "$REPO_URL" in
    https://github.com/*) p="${REPO_URL#https://github.com/}"; REPO_URL="git@github.com:${p%.git}.git" ;;
  esac
  [ -f "$DEPLOY_KEY" ] || sudo -u "$SVC_USER" ssh-keygen -t ed25519 -N "" -C "adpix-mcp-deploy@$(hostname)" -f "$DEPLOY_KEY" -q
  SSH_CMD="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  GIT=(sudo -u "$SVC_USER" env GIT_SSH_COMMAND="$SSH_CMD" git)
  if ! sudo -u "$SVC_USER" env GIT_SSH_COMMAND="$SSH_CMD -o BatchMode=yes" git ls-remote "$REPO_URL" >/dev/null 2>&1; then
    cat <<EOF

>> This private repo needs a deploy key. Add this READ-ONLY key to GitHub:

    $(cat "$DEPLOY_KEY.pub")

   -> https://github.com/<owner>/<repo>/settings/keys   (Add deploy key; leave write access OFF)

   Then re-run this installer. Nothing else was changed.
EOF
    exit 0
  fi
  mkdir -p "$INSTALL_DIR"; chown "$SVC_USER:$SVC_USER" "$(dirname "$INSTALL_DIR")" 2>/dev/null || true
  chown -R "$SVC_USER:$SVC_USER" "$INSTALL_DIR" 2>/dev/null || true
fi

# The tree is owned by $SVC_USER but git here runs as root (public-repo path) → git's
# dubious-ownership guard would abort the update. Mark it safe system-wide (idempotent).
git config --system --get-all safe.directory 2>/dev/null | grep -qxF "$INSTALL_DIR" \
  || git config --system --add safe.directory "$INSTALL_DIR"

if [ -d "$INSTALL_DIR/.git" ]; then
  say "Updating existing install…"
  if [ "${REPO_SSH:-0}" = "1" ]; then
    "${GIT[@]}" -C "$INSTALL_DIR" remote set-url origin "$REPO_URL"
    "${GIT[@]}" -C "$INSTALL_DIR" config core.sshCommand "$SSH_CMD"
  fi
  "${GIT[@]}" -C "$INSTALL_DIR" fetch origin
  if [ -n "$BRANCH" ]; then "${GIT[@]}" -C "$INSTALL_DIR" checkout "$BRANCH"; fi
  "${GIT[@]}" -C "$INSTALL_DIR" pull --ff-only
else
  say "Cloning $REPO_URL…"
  "${GIT[@]}" clone ${BRANCH:+-b "$BRANCH"} "$REPO_URL" "$INSTALL_DIR"
  if [ "${REPO_SSH:-0}" = "1" ]; then "${GIT[@]}" -C "$INSTALL_DIR" config core.sshCommand "$SSH_CMD"; fi
fi
say "Building…"
cd "$INSTALL_DIR"
npm ci --no-audit --no-fund >/dev/null
chown -R "$SVC_USER:$SVC_USER" "$INSTALL_DIR"

# 4. env file (token survives re-runs) ------------------------------------------
TOKEN="$(grep '^MCP_AUTH_TOKEN=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
[ -n "$TOKEN" ] || TOKEN="$(openssl rand -hex 32)"
BIND_HOST=127.0.0.1
[ -z "$MCP_DOMAIN" ] && BIND_HOST=0.0.0.0
{
  echo "# adpix-devops-mcp service config (root-only). Re-running the installer preserves this token."
  echo "MCP_TRANSPORT=http"
  echo "MCP_HTTP_HOST=$BIND_HOST"
  echo "MCP_HTTP_PORT=$MCP_PORT"
  echo "MCP_AUTH_TOKEN=$TOKEN"
  echo "ADPIX_DEVOPS_HOME=$STATE_DIR"
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"; else
    grep '^ANTHROPIC_API_KEY=' "$ENV_FILE" 2>/dev/null || true
  fi
} > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# 5. sudoers: the service may restart exactly itself (mcp_self_update) ----------
cat > /etc/sudoers.d/adpix-devops-mcp <<EOF
$SVC_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart adpix-devops-mcp.service
EOF
chmod 440 /etc/sudoers.d/adpix-devops-mcp

# 6. systemd units ---------------------------------------------------------------
NODE_BIN="$(command -v node)"
cat > /etc/systemd/system/adpix-devops-mcp.service <<EOF
[Unit]
Description=AdPix DevOps MCP server (HTTP)
Documentation=https://github.com/mehrabiyan/adpix-devops-mcp
After=network-online.target
Wants=network-online.target
OnFailure=adpix-mcp-selfheal.service
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
User=$SVC_USER
Group=$SVC_USER
EnvironmentFile=$ENV_FILE
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/dist/index.js --http
Restart=always
RestartSec=3
NoNewPrivileges=no

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/adpix-mcp-selfheal.service <<EOF
[Unit]
Description=AI self-heal for adpix-devops-mcp (Claude Code, fires when the service crash-loops)

[Service]
Type=oneshot
ExecStart=$INSTALL_DIR/scripts/selfheal.sh
TimeoutStartSec=1800
EOF

systemctl daemon-reload
systemctl enable --now adpix-devops-mcp.service

# 7. self-heal prerequisites (only useful with an API key) ------------------------
if grep -q '^ANTHROPIC_API_KEY=' "$ENV_FILE"; then
  if ! command -v claude >/dev/null 2>&1 && [ ! -x /root/.local/bin/claude ]; then
    say "Installing Claude Code CLI for the self-heal hook…"
    (curl -fsSL https://claude.ai/install.sh | bash) >/dev/null 2>&1 || \
      npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || \
      say "Claude Code install failed — self-heal will no-op until it's installed."
  fi
else
  say "No ANTHROPIC_API_KEY provided — the AI self-heal hook stays dormant (re-run with the key to enable)."
fi

# 8. Caddy (HTTPS) when a domain is given -----------------------------------------
if [ -n "$MCP_DOMAIN" ]; then
  if ! command -v caddy >/dev/null 2>&1; then
    say "Installing Caddy (automatic HTTPS)…"
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  if ! grep -q "adpix-devops-mcp" /etc/caddy/Caddyfile 2>/dev/null; then
    cat >> /etc/caddy/Caddyfile <<EOF

# adpix-devops-mcp (managed block — added by install-server.sh)
$MCP_DOMAIN {
	reverse_proxy 127.0.0.1:$MCP_PORT
}
EOF
  fi
  systemctl enable --now caddy >/dev/null 2>&1 || true
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
fi

# 9. firewall (when ufw is active) -------------------------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  if [ -n "$MCP_DOMAIN" ]; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  else ufw allow "$MCP_PORT"/tcp >/dev/null; fi
fi

# 10. verify + print the connection recipe ------------------------------------------
sleep 1
HEALTH="$(curl -fsS "http://127.0.0.1:$MCP_PORT/healthz" 2>/dev/null || true)"
[ "$HEALTH" = "ok" ] || die "service did not come up — check: journalctl -u adpix-devops-mcp -n 50"

if [ -n "$MCP_DOMAIN" ]; then URL="https://$MCP_DOMAIN/mcp"; else URL="http://$(hostname -I 2>/dev/null | awk '{print $1}'):$MCP_PORT/mcp"; fi
cat <<EOF

============================================================
 adpix-devops-mcp is running.

 Connect from Claude Code:
   claude mcp add --transport http adpix-devops $URL \\
     --header "Authorization: Bearer $TOKEN"

 (the token lives in $ENV_FILE; re-running this installer keeps it)
EOF
[ -n "$MCP_DOMAIN" ] && echo " Point the $MCP_DOMAIN A-record at this server -> Caddy issues HTTPS automatically." \
  || echo " WARNING: no MCP_DOMAIN set -> plain HTTP. Use only on a trusted network, or re-run with MCP_DOMAIN=."
cat <<EOF

 This MCP reaches your AdPix servers over SSH as its own identity.
 Authorize it on each AdPix server (as root):
   echo '$(cat "$STATE_DIR/.ssh/id_ed25519.pub")' >> /root/.ssh/authorized_keys

 Then (from Claude): server_add name:prod host:<ip> privateKeyPath:$STATE_DIR/.ssh/id_ed25519
 Update later: re-run this installer, or use the mcp_self_update tool.
 Logs: journalctl -u adpix-devops-mcp -f
============================================================
EOF
