#!/usr/bin/env bash
# AI self-heal for the adpix-devops-mcp service itself. Wired as the systemd
# OnFailure= unit by install-server.sh: when the service crash-loops past its
# restart limit, ask Claude Code (headless) to diagnose and repair this
# installation. Silent no-op without an API key or the claude CLI.
# Self-protecting: lockfile + 60-min cooldown so a broken install can't burn
# API spend in a loop.
set -u
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE=/etc/adpix-devops-mcp/env
LOG_DIR=/var/log/adpix-devops-mcp
mkdir -p "$LOG_DIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)

exec 9>/var/lock/adpix-mcp-selfheal.lock
flock -n 9 || exit 0

last=$(ls -1t "$LOG_DIR"/selfheal-*.json 2>/dev/null | head -1)
if [ -n "$last" ]; then
  age=$(( $(date +%s) - $(stat -c %Y "$last") ))
  [ "$age" -lt 3600 ] && exit 0
fi

[ -f "$ENV_FILE" ] && . "$ENV_FILE"
export HOME="${HOME:-/root}"
export PATH="$PATH:$HOME/.local/bin:/usr/local/bin:/usr/bin"
[ -n "${ANTHROPIC_API_KEY:-}" ] || { echo "selfheal: no ANTHROPIC_API_KEY — skipping" >&2; exit 0; }
export ANTHROPIC_API_KEY
command -v claude >/dev/null 2>&1 || { echo "selfheal: claude CLI not installed — skipping" >&2; exit 0; }

JOURNAL=$(journalctl -u adpix-devops-mcp -n 200 --no-pager 2>/dev/null | tail -120)
RECENT=$(git -C "$INSTALL_DIR" log --oneline -5 2>/dev/null; git -C "$INSTALL_DIR" status --porcelain 2>/dev/null | head -20)

PF="$LOG_DIR/selfheal-prompt-$TS.txt"
cat > "$PF" <<PROMPT_EOF
You are repairing a crashed systemd service on this Ubuntu server: adpix-devops-mcp,
a Node.js MCP server installed at $INSTALL_DIR. It is built with "npm ci && npm run build"
and run by the systemd unit adpix-devops-mcp.service, which reads env config from
$ENV_FILE and serves HTTP on 127.0.0.1:${MCP_HTTP_PORT:-8930}. It has crash-looped past
its restart limit; systemd invoked you as the OnFailure hook. Diagnose and fix it.

HARD RULES (non-negotiable)
1. NEVER print or modify the secrets in $ENV_FILE (checking that the file exists and its
   permissions is fine).
2. NEVER git push. Local git operations (diff, log, reset to origin) are allowed.
3. Do not delete anything under /var/lib/adpix-devops-mcp (it holds the server registry).
4. Do not reboot the machine; do not touch sshd.
5. If you cannot fix it safely, write your findings to $LOG_DIR/selfheal-$TS.report and stop.

A SENSIBLE PATH
- journalctl -u adpix-devops-mcp -n 200 for the crash reason
- check recent changes: git -C $INSTALL_DIR log --oneline -5; git -C $INSTALL_DIR status
- a bad self-update is the most likely cause: cd $INSTALL_DIR && npm ci && npm run build,
  or git reset --hard to the previous commit and rebuild
- after fixing: chown -R adpixmcp: $INSTALL_DIR, systemctl restart adpix-devops-mcp,
  then verify: curl -fsS http://127.0.0.1:${MCP_HTTP_PORT:-8930}/healthz returns "ok"

JOURNAL (last lines)
$JOURNAL

RECENT GIT STATE
$RECENT

WHEN DONE
End with: ROOT CAUSE / WHAT I CHANGED / VERIFICATION / FOLLOW-UPS.
PROMPT_EOF

claude -p --output-format json --max-turns 40 ${ANTHROPIC_MODEL:+--model "$ANTHROPIC_MODEL"} \
  --allowedTools "Bash,Read,Grep,Glob,Edit,Write" \
  < "$PF" > "$LOG_DIR/selfheal-$TS.json" 2> "$LOG_DIR/selfheal-$TS.err" || true

find "$LOG_DIR" -name 'selfheal-*' -mtime +90 -delete 2>/dev/null
exit 0
