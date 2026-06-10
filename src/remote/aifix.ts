/**
 * AI self-healing via Claude Code (headless `claude -p`) running ON the target
 * server. Three consumers share this module:
 *   - the ai_fix tool (manual, evidence gathered over SSH, prompt built here)
 *   - the watchdog escalation (adpix-ai-fix.sh, generated from the template
 *     below, fired by systemd-run when auto-restarts haven't fixed an outage)
 *   - the MCP host's own OnFailure self-heal (scripts/selfheal.sh, static)
 *
 * NOTE: the rules text is embedded in an unquoted bash heredoc — keep it free
 * of $, backticks and single quotes.
 */

export const AI_ENV_FILE = "/etc/adpix-ai/env";
export const AI_LOG_DIR = "/var/log/adpix-ai";
export const AI_FIX_SCRIPT_PATH = "/usr/local/bin/adpix-ai-fix.sh";

/** Guardrails for "fix with guardrails" mode — single source for tool + escalation. */
export const PROMPT_RULES = `HARD RULES (non-negotiable)
1. NEVER delete or prune docker volumes, databases, or anything under backups/.
   Forbidden: docker volume rm, docker system prune, docker volume prune, DROP, TRUNCATE.
   (docker builder prune -f to reclaim BUILD cache only is allowed.)
2. NEVER print, edit, or commit secrets. Do not cat the whole .env - if you must read a
   non-secret key, grep that one key only.
3. NEVER git push or rewrite remote history. Local-only git operations (stash, reset to
   origin, checkout of a previous commit) are allowed.
4. Do not reboot the machine. Do not stop sshd. Restarting a hung docker daemon is allowed.
5. Prefer the least invasive fix, in this order: restart one service; free disk space
   (old logs, build cache); fix a config error; redeploy with ./scripts/deploy.sh;
   roll back to the previous commit and redeploy.
6. If a safe fix is not possible under these rules, STOP and write exactly what you found
   and what a human should do.`;

export const DEPLOYMENT_FACTS = (adpixDir: string) => `DEPLOYMENT FACTS
- AdPix Analytics lives at ${adpixDir} (a git checkout). The production stack runs as:
  docker compose -p adanalytics -f compose.yaml -f compose.prod.yaml   (from that dir)
- Caddy is the only public service (ports 80/443). Behind it: web (Next.js), api (Go),
  ingest (Go collect path), worker, identity-job, postgres, clickhouse.
- Postgres and ClickHouse hold ALL customer data, in docker volumes of project "adanalytics".
- ./scripts/deploy.sh is the idempotent rebuild+migrate entrypoint. ./scripts/backup.sh
  writes backups under backups/.
- Health is "good" when http://127.0.0.1:80/_apx_health answers 2xx/3xx and every
  adanalytics container is running and healthy.
- A watchdog (adpix-watchdog.timer) logs to /var/log/adpix-watchdog/; auto-deploy
  (adpix-autodeploy.timer) logs to /var/log/adpix-autodeploy/.`;

export interface FixPromptOpts {
  mode: "fix" | "diagnose";
  problem: string;
  evidence: string;
  adpixDir: string;
}

export function buildFixPrompt(o: FixPromptOpts): string {
  const head =
    o.mode === "fix"
      ? `You are a senior SRE operating directly on a production Ubuntu server that hosts AdPix
Analytics. You have shell access. Investigate the problem below and FIX it.`
      : `You are a senior SRE investigating a production Ubuntu server that hosts AdPix
Analytics. DIAGNOSE ONLY: run read-only commands; make NO changes of any kind.`;
  const tail =
    o.mode === "fix"
      ? `WHEN DONE
End with a short report in exactly this shape:
ROOT CAUSE: ...
WHAT I CHANGED: ...
VERIFICATION: commands you ran and their results proving health
FOLLOW-UPS: anything a human should still do`
      : `WHEN DONE
End with a short report in exactly this shape:
DIAGNOSIS: ...
RECOMMENDED FIX: exact commands, in order
RISKS: what could go wrong applying them`;
  return [
    head,
    "",
    DEPLOYMENT_FACTS(o.adpixDir),
    "",
    PROMPT_RULES,
    "",
    `PROBLEM\n${o.problem}`,
    "",
    `EVIDENCE GATHERED BEFORE YOU STARTED\n${o.evidence}`,
    "",
    tail,
  ].join("\n");
}

export interface ClaudeInvocationOpts {
  promptFile: string;
  outFile: string;
  errFile: string;
  maxTurns: number;
  /** Restrict to read-only-ish tools in diagnose mode. */
  mode: "fix" | "diagnose";
  model?: string;
  /** Pass the key inline (from the MCP host env) instead of relying on AI_ENV_FILE. */
  inlineApiKey?: string;
}

/** Shell command that runs headless Claude Code on the server and emits the result JSON on stdout. */
export function claudeInvocation(o: ClaudeInvocationOpts): string {
  const tools = o.mode === "fix" ? "Bash,Read,Grep,Glob,Edit,Write" : "Bash,Read,Grep,Glob";
  const model = o.model ? ` --model '${o.model.replace(/'/g, "")}'` : "";
  const key = o.inlineApiKey ? `export ANTHROPIC_API_KEY='${o.inlineApiKey.replace(/'/g, "")}'; ` : "";
  return (
    `[ -f ${AI_ENV_FILE} ] && . ${AI_ENV_FILE}; ${key}` +
    `export HOME="\${HOME:-/root}"; export PATH="$PATH:$HOME/.local/bin:/usr/local/bin"; ` +
    `[ -n "\${ANTHROPIC_API_KEY:-}" ] || { echo NO_API_KEY >&2; exit 86; }; ` +
    `command -v claude >/dev/null 2>&1 || { echo NO_CLAUDE_CLI >&2; exit 87; }; ` +
    `mkdir -p ${AI_LOG_DIR}; ` +
    `claude -p --output-format json --max-turns ${Math.floor(o.maxTurns)}${model} ` +
    `--allowedTools "${tools}" < '${o.promptFile}' > '${o.outFile}' 2> '${o.errFile}'; ` +
    `rc=$?; cat '${o.outFile}'; exit $rc`
  );
}

/** Result JSON shape of `claude -p --output-format json` (fields we use). */
export interface ClaudeResult {
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  is_error?: boolean;
  subtype?: string;
}

export function parseClaudeResult(stdout: string): ClaudeResult | undefined {
  const t = stdout.trim();
  // the result object is the last JSON document on stdout
  const start = t.lastIndexOf("\n{");
  const candidate = start >= 0 ? t.slice(start + 1) : t;
  try {
    return JSON.parse(candidate) as ClaudeResult;
  } catch {
    return undefined;
  }
}

export interface AiFixScriptOpts {
  adpixDir: string;
  maxTurns: number;
}

/**
 * The escalation script installed at /usr/local/bin/adpix-ai-fix.sh. The
 * watchdog launches it (via systemd-run) when an outage survives auto-restarts.
 * Self-protecting: lockfile, 30-min cooldown, silent no-op without key/CLI.
 */
export function renderAiFixScript(o: AiFixScriptOpts): string {
  const clean = (s: string) => s.replace(/'/g, "");
  return `#!/usr/bin/env bash
# adpix-ai-fix — headless Claude Code fixer, installed by adpix-devops-mcp (ai_setup).
# Invoked by the watchdog escalation (systemd-run) or manually:
#   adpix-ai-fix.sh "description of the problem"
set -u
PROBLEM="\${1:-AdPix is unhealthy and auto-restarts did not recover it}"
ADPIX_DIR='${clean(o.adpixDir)}'
MAX_TURNS=${Math.floor(o.maxTurns)}
LOG_DIR=${AI_LOG_DIR}
mkdir -p "$LOG_DIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)

exec 9>/var/lock/adpix-ai-fix.lock
flock -n 9 || exit 0

# cooldown: at most one AI run per 30 minutes (bounds API spend)
last=$(ls -1t "$LOG_DIR"/run-*.json 2>/dev/null | head -1)
if [ -n "$last" ]; then
  age=$(( $(date +%s) - $(stat -c %Y "$last") ))
  [ "$age" -lt 1800 ] && exit 0
fi

[ -f ${AI_ENV_FILE} ] && . ${AI_ENV_FILE}
export HOME="\${HOME:-/root}"
export PATH="$PATH:$HOME/.local/bin:/usr/local/bin:/usr/bin"
[ -n "\${ANTHROPIC_API_KEY:-}" ] || exit 0
export ANTHROPIC_API_KEY
command -v claude >/dev/null 2>&1 || exit 0

post() {
  [ -n "\${WEBHOOK_URL:-}" ] || return 0
  payload="{\\"text\\":\\"$1\\",\\"content\\":\\"$1\\",\\"host\\":\\"$(hostname)\\",\\"ts\\":\\"$TS\\"}"
  curl -ksS -m 10 -X POST -H 'Content-Type: application/json' -d "$payload" "$WEBHOOK_URL" >/dev/null 2>&1 || true
}
post "Claude Code escalation STARTING on $(hostname): $PROBLEM (transcript: $LOG_DIR/run-$TS.json)"

EV_PS=$(docker ps -a --filter label=com.docker.compose.project=adanalytics --format '{{.Names}} | {{.State}} | {{.Status}}' 2>&1 | head -30)
EV_WD=$(cat /var/log/adpix-watchdog/state.json 2>/dev/null; echo; tail -8 /var/log/adpix-watchdog/incidents.jsonl 2>/dev/null)
EV_CD=$(cat /var/log/adpix-autodeploy/state.json 2>/dev/null; echo; tail -5 /var/log/adpix-autodeploy/deploys.jsonl 2>/dev/null)
EV_RES=$(df -h / 2>/dev/null | tail -1; free -m 2>/dev/null | head -2)
EV_LOGS=$(cd "$ADPIX_DIR" 2>/dev/null && docker compose -p adanalytics -f compose.yaml -f compose.prod.yaml logs --no-color --tail=50 2>&1 | tail -150)

PF="$LOG_DIR/prompt-$TS.txt"
cat > "$PF" <<PROMPT_EOF
You are a senior SRE operating directly on a production Ubuntu server that hosts AdPix
Analytics. You have shell access. The monitoring watchdog escalated to you because the
problem below survived automatic restarts. Investigate and FIX it.

${DEPLOYMENT_FACTS("$ADPIX_DIR")}

${PROMPT_RULES}

PROBLEM
$PROBLEM

EVIDENCE GATHERED BEFORE YOU STARTED
--- containers ---
$EV_PS
--- watchdog state + recent incidents ---
$EV_WD
--- autodeploy state + recent deploys ---
$EV_CD
--- disk / memory ---
$EV_RES
--- recent service logs ---
$EV_LOGS

WHEN DONE
End with a short report in exactly this shape:
ROOT CAUSE: ...
WHAT I CHANGED: ...
VERIFICATION: commands you ran and their results proving health
FOLLOW-UPS: anything a human should still do
PROMPT_EOF

claude -p --output-format json --max-turns "$MAX_TURNS" \${ANTHROPIC_MODEL:+--model "$ANTHROPIC_MODEL"} --allowedTools "Bash,Read,Grep,Glob,Edit,Write" < "$PF" > "$LOG_DIR/run-$TS.json" 2> "$LOG_DIR/run-$TS.err"
rc=$?
if [ "$rc" -eq 0 ]; then
  post "Claude Code escalation FINISHED on $(hostname) — transcript: $LOG_DIR/run-$TS.json"
else
  post "Claude Code escalation FAILED (exit $rc) on $(hostname) — see $LOG_DIR/run-$TS.err"
fi
find "$LOG_DIR" -name 'run-*' -mtime +90 -delete 2>/dev/null
find "$LOG_DIR" -name 'prompt-*' -mtime +90 -delete 2>/dev/null
exit 0
`;
}
