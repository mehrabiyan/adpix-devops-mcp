/**
 * Templates for pull-based continuous deployment: a systemd timer on the AdPix
 * server polls GitHub and, when the tracked branch moves, runs the full safe
 * pipeline: backup → reset to origin → deploy.sh → health gate → automatic
 * rollback on failure → webhook alert. This upgrades the bare snippet in
 * adpix's runbook (docs/runbooks/deploy-digitalocean.md) with the same safety
 * the manual adpix_update tool has.
 *
 * Files it maintains on the server (under /var/log/adpix-autodeploy):
 *   deploys.jsonl       — one JSON object per deploy/rollback/failure event
 *   state.json          — last pass result
 *   deploy-<ts>.log     — full build/migrate output per attempted deploy
 */

export const AUTODEPLOY_SCRIPT_PATH = "/usr/local/bin/adpix-autodeploy.sh";
export const AUTODEPLOY_LOG_DIR = "/var/log/adpix-autodeploy";
export const AUTODEPLOY_SERVICE = "adpix-autodeploy.service";
export const AUTODEPLOY_TIMER = "adpix-autodeploy.timer";

export interface AutodeployOpts {
  adpixDir: string;
  branch: string;
  webhookUrl?: string;
  /** Skip the pre-deploy backup (not recommended). */
  skipBackup: boolean;
  /** Health-gate attempts after deploy, 5s apart. */
  healthTries: number;
}

export function renderAutodeployScript(o: AutodeployOpts): string {
  const clean = (s: string) => s.replace(/'/g, "");
  return `#!/usr/bin/env bash
# adpix-autodeploy — installed by adpix-devops-mcp (cicd_enable). Do not edit in
# place: re-run cicd_enable to change settings.
# One pass per invocation (driven by adpix-autodeploy.timer):
#   fetch origin; when the tracked branch moved: backup -> reset to origin ->
#   ./scripts/deploy.sh -> health gate -> rollback to the previous commit on
#   failure. Outcomes are appended to deploys.jsonl and posted to the webhook.
set -u
ADPIX_DIR='${clean(o.adpixDir)}'
BRANCH='${clean(o.branch)}'
WEBHOOK_URL='${clean(o.webhookUrl ?? "")}'
SKIP_BACKUP=${o.skipBackup ? 1 : 0}
HEALTH_TRIES=${Math.max(6, Math.floor(o.healthTries))}
LOG_DIR=/var/log/adpix-autodeploy
HISTORY="$LOG_DIR/deploys.jsonl"
STATE="$LOG_DIR/state.json"
mkdir -p "$LOG_DIR"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# never let two passes (or a pass and a long build) overlap
exec 9>/var/lock/adpix-autodeploy.lock
flock -n 9 || exit 0

post() {
  [ -n "$WEBHOOK_URL" ] || return 0
  payload="{\\"text\\":\\"$1\\",\\"content\\":\\"$1\\",\\"host\\":\\"$(hostname)\\",\\"ts\\":\\"$TS\\"}"
  curl -ksS -m 10 -X POST -H 'Content-Type: application/json' -d "$payload" "$WEBHOOK_URL" >/dev/null 2>&1 || true
}
log_event() {
  echo "{\\"ts\\":\\"$TS\\",\\"event\\":\\"$1\\",\\"from\\":\\"$2\\",\\"to\\":\\"$3\\",\\"detail\\":\\"$4\\"}" >> "$HISTORY"
}
save_state() {
  echo "{\\"ts\\":\\"$TS\\",\\"head\\":\\"$(git rev-parse --short HEAD 2>/dev/null)\\",\\"result\\":\\"$1\\",\\"detail\\":\\"$2\\"}" > "$STATE"
}
prev_result=""
[ -f "$STATE" ] && prev_result=$(sed -nE 's/.*"result":"([a-z_-]+)".*/\\1/p' "$STATE")

cd "$ADPIX_DIR" 2>/dev/null || { post "ALERT [$(hostname)] adpix-autodeploy: checkout missing at $ADPIX_DIR"; exit 0; }

if ! git fetch --quiet origin "$BRANCH" 2>>"$LOG_DIR/fetch-errors.log"; then
  log_event fetch_failed "" "" "git fetch origin $BRANCH failed (auth? network?)"
  if [ "$prev_result" != "fetch_failed" ]; then
    post "ALERT [$(hostname)] AdPix autodeploy cannot fetch origin/$BRANCH — deploy key/network problem? See $LOG_DIR/fetch-errors.log"
  fi
  save_state fetch_failed "see fetch-errors.log"
  exit 0
fi

local_head=$(git rev-parse HEAD)
remote_head=$(git rev-parse "origin/$BRANCH")
if [ "$local_head" = "$remote_head" ]; then
  save_state up-to-date ""
  exit 0
fi

from=$(git rev-parse --short HEAD)
to=$(git rev-parse --short "origin/$BRANCH")
DEPLOY_LOG="$LOG_DIR/deploy-$(date -u +%Y%m%dT%H%M%SZ).log"

if [ "$SKIP_BACKUP" -eq 0 ]; then
  if ! ./scripts/backup.sh >>"$DEPLOY_LOG" 2>&1; then
    log_event backup_failed "$from" "$to" "backup.sh failed; deploy aborted"
    if [ "$prev_result" != "backup_failed" ]; then
      post "ALERT [$(hostname)] AdPix autodeploy: pre-deploy backup FAILED — deploy of $to aborted (see $DEPLOY_LOG)"
    fi
    save_state backup_failed "see $DEPLOY_LOG"
    exit 0
  fi
fi

# take exactly what's on the branch; .env is gitignored and survives
git reset --hard "origin/$BRANCH" >>"$DEPLOY_LOG" 2>&1

healthy() {
  i=0
  while [ "$i" -lt "$HEALTH_TRIES" ]; do
    code=$(curl -ksS -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:80/_apx_health 2>/dev/null || echo 000)
    case "$code" in 2*|3*) return 0 ;; esac
    sleep 5
    i=$((i+1))
  done
  return 1
}

if ./scripts/deploy.sh >>"$DEPLOY_LOG" 2>&1 && healthy; then
  log_event deployed "$from" "$to" "ok"
  post "AdPix deployed $from -> $to on $(hostname) (origin/$BRANCH)"
  save_state deployed "$from -> $to"
else
  log_event deploy_failed "$from" "$to" "see $DEPLOY_LOG"
  post "ALERT [$(hostname)] AdPix deploy of $to FAILED health gate — rolling back to $from"
  git reset --hard "$local_head" >>"$DEPLOY_LOG" 2>&1
  if ./scripts/deploy.sh >>"$DEPLOY_LOG" 2>&1 && healthy; then
    log_event rolled_back "$to" "$from" "previous version restored"
    post "AdPix rollback OK on $(hostname) — $from is live again; $to needs investigation before it can ship"
    save_state rolled_back "see $DEPLOY_LOG"
  else
    log_event rollback_failed "$to" "$from" "MANUAL INTERVENTION NEEDED"
    post "CRITICAL [$(hostname)] AdPix rollback FAILED — site may be down. Manual intervention needed (see $DEPLOY_LOG)."
    save_state rollback_failed "see $DEPLOY_LOG"
  fi
fi

find "$LOG_DIR" -name 'deploy-*.log' -mtime +60 -delete 2>/dev/null
exit 0
`;
}

export function renderAutodeployServiceUnit(adpixDir: string): string {
  return `[Unit]
Description=AdPix auto-deploy pass (installed by adpix-devops-mcp)
Wants=docker.service network-online.target

[Service]
Type=oneshot
WorkingDirectory=${adpixDir}
ExecStart=${AUTODEPLOY_SCRIPT_PATH}
# first deploys build every image — give them room
TimeoutStartSec=3900
Nice=5
`;
}

export function renderAutodeployTimer(intervalSeconds: number): string {
  const iv = Math.min(86_400, Math.max(60, Math.floor(intervalSeconds)));
  return `[Unit]
Description=Poll GitHub + auto-deploy AdPix every ${iv}s (installed by adpix-devops-mcp)

[Timer]
OnBootSec=180
OnUnitActiveSec=${iv}
AccuracySec=30

[Install]
WantedBy=timers.target
`;
}
