/**
 * Templates for the on-server watchdog: a bash script driven by a systemd
 * timer. It runs ON the AdPix host, so health enforcement and alerting keep
 * working even when no MCP client is connected.
 *
 * Files it maintains on the server (under /var/log/adpix-watchdog):
 *   checks-YYYYMM.log  — one line per pass: "<iso-ts> ok" | "<iso-ts> fail <what>"
 *   incidents.jsonl    — one JSON object per down/recovered/still_down event
 *   state.json         — last pass result + consecutive failure count
 */

export const WATCHDOG_SCRIPT_PATH = "/usr/local/bin/adpix-watchdog.sh";
export const WATCHDOG_LOG_DIR = "/var/log/adpix-watchdog";
export const WATCHDOG_SERVICE = "adpix-watchdog.service";
export const WATCHDOG_TIMER = "adpix-watchdog.timer";

export interface WatchdogOpts {
  adpixDir: string;
  webhookUrl?: string;
  autoRestart: boolean;
  httpPath: string;
  /** While down, re-alert every N consecutive failed checks. */
  realertEvery: number;
  /** Escalate to Claude Code (adpix-ai-fix.sh, installed by ai_setup) when an outage survives restarts. */
  aiEscalate?: boolean;
  /** Escalate after this many consecutive failed checks. */
  escalateAfter?: number;
  /** Compose project whose containers must be running (adanalytics | adpix-account | adpix-tm). */
  project?: string;
  /** Primary HTTP health endpoint to probe (default: the Analytics Caddy front door on :80). */
  healthUrl?: string;
}

export function renderWatchdogScript(o: WatchdogOpts): string {
  const clean = (s: string) => s.replace(/'/g, ""); // keep the script's single-quoting intact
  const project = o.project ?? "adanalytics";
  const healthUrl = o.healthUrl ?? `http://127.0.0.1:80${o.httpPath}`;
  const port = (healthUrl.match(/:(\d+)/) ?? [])[1] ?? "80";
  const isFrontDoor = project === "adanalytics"; // only Analytics fronts a Caddy/TLS domain
  return `#!/usr/bin/env bash
# adpix-watchdog — installed by adpix-devops-mcp. Do not edit in place:
# re-run the watchdog_install tool to change settings.
# One pass per invocation (driven by adpix-watchdog.timer):
#   - every compose container of project "${project}" must be running & healthy
#   - the health endpoint (${healthUrl}) must answer 2xx/3xx
#   - unhealthy services are restarted (if enabled), incidents logged,
#     webhook pinged on down/recovery transitions.
set -u
ADPIX_DIR='${clean(o.adpixDir)}'
WEBHOOK_URL='${clean(o.webhookUrl ?? "")}'
AUTO_RESTART=${o.autoRestart ? 1 : 0}
HTTP_PATH='${clean(o.httpPath)}'
HEALTH_URL='${clean(healthUrl)}'
REALERT_EVERY=${Math.max(2, Math.floor(o.realertEvery))}
AI_ESCALATE=${o.aiEscalate ? 1 : 0}
ESCALATE_AFTER=${Math.max(2, Math.floor(o.escalateAfter ?? 5))}
PROJECT=${project}
LOG_DIR=/var/log/adpix-watchdog
STATE_FILE="$LOG_DIR/state.json"
INCIDENTS="$LOG_DIR/incidents.jsonl"
mkdir -p "$LOG_DIR"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
CHECKS_FILE="$LOG_DIR/checks-$(date -u +%Y%m).log"

bad=""
actions=""

# --- docker daemon -----------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  bad="docker-daemon"
  if [ "$AUTO_RESTART" -eq 1 ]; then
    if systemctl start docker >/dev/null 2>&1; then actions="started:docker"; else actions="start-failed:docker"; fi
  fi
else
  # --- containers --------------------------------------------------------------
  while IFS='|' read -r name state status; do
    [ -n "$name" ] || continue
    case "$name" in *migrate*|*run-*) continue ;; esac
    ok=1
    [ "$state" = "running" ] || ok=0
    case "$status" in *unhealthy*|*Restarting*) ok=0 ;; esac
    if [ "$ok" -eq 0 ]; then
      bad="$bad $name"
      if [ "$AUTO_RESTART" -eq 1 ]; then
        if docker restart "$name" >/dev/null 2>&1; then actions="$actions restarted:$name"; else actions="$actions restart-failed:$name"; fi
      fi
    fi
  done <<EOF
$(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}}|{{.State}}|{{.Status}}' 2>/dev/null)
EOF

  # --- health endpoint over HTTP (Caddy answers redirects in domain mode -> 3xx ok) --
  code=$(curl -ksS -o /dev/null -m 10 -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || echo 000)
  case "$code" in 2*|3*) : ;; *) bad="$bad http:${port}($code)" ;; esac
${isFrontDoor ? `
  # --- full TLS path in domain mode (Analytics front door only) -----------------
  SITE=$(grep ^SITE_ADDRESS= "$ADPIX_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)
  if [ -n "$SITE" ] && [ "$SITE" != ":80" ]; then
    code2=$(curl -ksS -o /dev/null -m 10 --resolve "$SITE:443:127.0.0.1" -w '%{http_code}' "https://$SITE$HTTP_PATH" 2>/dev/null || echo 000)
    case "$code2" in 2*) : ;; *) bad="$bad https:443($code2)" ;; esac
  fi` : ""}
fi

bad=$(echo "$bad" | sed -e 's/^ *//' -e 's/ *$//')
if [ -n "$bad" ]; then status=fail; else status=ok; fi

# --- per-check line (uptime_report reads these) --------------------------------
if [ "$status" = ok ]; then echo "$TS ok" >> "$CHECKS_FILE"; else echo "$TS fail $bad" >> "$CHECKS_FILE"; fi

# --- previous state -------------------------------------------------------------
prev_status=""
prev_consec=0
if [ -f "$STATE_FILE" ]; then
  prev_status=$(sed -nE 's/.*"status":"([a-z]+)".*/\\1/p' "$STATE_FILE")
  pc=$(sed -nE 's/.*"consecutive_failures":([0-9]+).*/\\1/p' "$STATE_FILE")
  [ -n "$pc" ] && prev_consec=$pc
fi

consec=0
[ "$status" = fail ] && consec=$((prev_consec + 1))

alert=""
event=""
if [ "$status" = fail ] && [ "$prev_status" != fail ]; then
  event=down; alert=1
elif [ "$status" = ok ] && [ "$prev_status" = fail ]; then
  event=recovered; alert=1
elif [ "$status" = fail ] && [ $((consec % REALERT_EVERY)) -eq 0 ]; then
  event=still_down; alert=1
fi

actions=$(echo "$actions" | sed 's/^ *//')
if [ -n "$event" ]; then
  echo "{\\"ts\\":\\"$TS\\",\\"event\\":\\"$event\\",\\"services\\":\\"$bad\\",\\"actions\\":\\"$actions\\",\\"consecutive\\":$consec}" >> "$INCIDENTS"
fi

if [ -n "$alert" ] && [ -n "$WEBHOOK_URL" ]; then
  host=$(hostname)
  msg=""
  case "$event" in
    down)       msg="ALERT [$host] AdPix DOWN: $bad" ;;
    recovered)  msg="OK [$host] AdPix recovered" ;;
    still_down) msg="ALERT [$host] AdPix still down ($consec checks): $bad" ;;
  esac
  [ -n "$actions" ] && msg="$msg | actions: $actions"
  payload="{\\"text\\":\\"$msg\\",\\"content\\":\\"$msg\\",\\"host\\":\\"$host\\",\\"status\\":\\"$status\\",\\"services\\":\\"$bad\\",\\"ts\\":\\"$TS\\"}"
  curl -ksS -m 10 -X POST -H 'Content-Type: application/json' -d "$payload" "$WEBHOOK_URL" >/dev/null 2>&1 || true
fi

# --- AI escalation: outage survived auto-restarts -> hand off to Claude Code -----
# (once per outage; adpix-ai-fix.sh is installed by ai_setup and is a silent no-op
#  without an API key. systemd-run detaches it so this oneshot pass isn't blocked.)
if [ "$status" = fail ] && [ "$AI_ESCALATE" -eq 1 ] && [ "$consec" -ge "$ESCALATE_AFTER" ] && [ ! -f "$LOG_DIR/ai-escalation.active" ]; then
  if [ -x /usr/local/bin/adpix-ai-fix.sh ] && command -v systemd-run >/dev/null 2>&1; then
    touch "$LOG_DIR/ai-escalation.active"
    echo "{\\"ts\\":\\"$TS\\",\\"event\\":\\"ai_escalation\\",\\"services\\":\\"$bad\\",\\"actions\\":\\"claude-code\\",\\"consecutive\\":$consec}" >> "$INCIDENTS"
    systemd-run --collect --unit "adpix-ai-fix-$(date +%s)" /usr/local/bin/adpix-ai-fix.sh "watchdog escalation: AdPix failing for $consec consecutive checks: $bad (auto-restarts did not recover it)" >/dev/null 2>&1 || rm -f "$LOG_DIR/ai-escalation.active"
  fi
fi
if [ "$status" = ok ]; then rm -f "$LOG_DIR/ai-escalation.active"; fi

# --- state + retention (keep ~4 months of per-check logs) ------------------------
echo "{\\"ts\\":\\"$TS\\",\\"status\\":\\"$status\\",\\"consecutive_failures\\":$consec,\\"services\\":\\"$bad\\"}" > "$STATE_FILE"
find "$LOG_DIR" -name 'checks-*.log' -mtime +120 -delete 2>/dev/null
exit 0
`;
}

export const WATCHDOG_SERVICE_UNIT = `[Unit]
Description=AdPix watchdog check (installed by adpix-devops-mcp)
Wants=docker.service

[Service]
Type=oneshot
ExecStart=${WATCHDOG_SCRIPT_PATH}
Nice=10
`;

export function renderWatchdogTimer(intervalSeconds: number): string {
  const iv = Math.min(3600, Math.max(15, Math.floor(intervalSeconds)));
  return `[Unit]
Description=Run the AdPix watchdog every ${iv}s (installed by adpix-devops-mcp)

[Timer]
OnBootSec=90
OnUnitActiveSec=${iv}
AccuracySec=5

[Install]
WantedBy=timers.target
`;
}
