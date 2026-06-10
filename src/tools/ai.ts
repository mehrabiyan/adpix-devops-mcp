import { z } from "zod";
import { withSession } from "../deps.js";
import type { Session } from "../ssh.js";
import { uploadFile } from "../adpix.js";
import {
  AI_ENV_FILE,
  AI_FIX_SCRIPT_PATH,
  AI_LOG_DIR,
  buildFixPrompt,
  claudeInvocation,
  parseClaudeResult,
  renderAiFixScript,
} from "../remote/aifix.js";
import { shq, lastLines } from "../util.js";
import type { ToolDef } from "./types.js";

const serverParam = z
  .string()
  .optional()
  .describe("Registered server name. Omit to use the default server.");

async function gatherEvidence(s: Session, dir: string): Promise<string> {
  const r = await s.exec(
    [
      `echo '--- containers ---'; docker ps -a --filter label=com.docker.compose.project=adanalytics --format '{{.Names}} | {{.State}} | {{.Status}}' 2>&1 | head -30`,
      `echo '--- watchdog state + recent incidents ---'; cat /var/log/adpix-watchdog/state.json 2>/dev/null; echo; tail -8 /var/log/adpix-watchdog/incidents.jsonl 2>/dev/null`,
      `echo '--- autodeploy state + recent deploys ---'; cat /var/log/adpix-autodeploy/state.json 2>/dev/null; echo; tail -5 /var/log/adpix-autodeploy/deploys.jsonl 2>/dev/null`,
      `echo '--- disk / memory / load ---'; df -h / 2>/dev/null | tail -1; free -m 2>/dev/null | head -2; cat /proc/loadavg`,
      `echo '--- recent service logs ---'; cd ${shq(dir)} 2>/dev/null && docker compose -p adanalytics -f compose.yaml -f compose.prod.yaml logs --no-color --tail=40 2>&1 | tail -120`,
    ].join("; "),
    { timeoutMs: 120_000 }
  );
  return lastLines(r.stdout, 220);
}

export const aiTools: ToolDef[] = [
  {
    name: "ai_setup",
    title: "Set up AI self-healing",
    description:
      "Prepare a server for Claude Code self-healing: install the Claude Code CLI, store the " +
      "Anthropic API key in a root-only env file, and install the escalation fixer script the " +
      "watchdog calls when an outage survives auto-restarts (with lockfile + 30-min cooldown to " +
      "bound API spend). Finish by re-running watchdog_install with aiEscalate:true.",
    schema: {
      server: serverParam,
      apiKey: z
        .string()
        .optional()
        .describe("Anthropic API key. Omit to use ANTHROPIC_API_KEY from this MCP process's environment."),
      model: z.string().optional().describe("Model override for automatic runs (default: Claude Code's default)"),
      maxTurns: z.number().int().min(5).max(200).default(40).describe("Turn budget per automatic fix run"),
      webhookUrl: z.string().optional().describe("Webhook for escalation start/finish alerts (defaults to the server's registered webhook)"),
    },
    annotations: { idempotentHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; apiKey?: string; model?: string; maxTurns: number; webhookUrl?: string };
      const key = a.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!key) {
        return "No API key: pass apiKey, or set ANTHROPIC_API_KEY in the MCP server's environment. (Use a key with a spend limit — automatic fixes cost tokens.)";
      }
      return withSession(deps, a.server, async (s, srv) => {
        // Claude Code CLI (native installer; falls back to npm if node is present).
        const install = await s.exec(
          `export HOME="\${HOME:-/root}"; export PATH="$PATH:$HOME/.local/bin:/usr/local/bin"; ` +
            `if command -v claude >/dev/null 2>&1; then claude --version; ` +
            `else (curl -fsSL https://claude.ai/install.sh | bash) >/dev/null 2>&1; ` +
            `export PATH="$PATH:$HOME/.local/bin"; ` +
            `command -v claude >/dev/null 2>&1 && claude --version || ` +
            `(command -v npm >/dev/null 2>&1 && npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 && claude --version) || echo INSTALL_FAILED; fi`,
          { timeoutMs: 600_000 }
        );
        if (install.stdout.includes("INSTALL_FAILED")) {
          return `Could not install the Claude Code CLI on ${srv.name}:\n${lastLines(install.stdout + install.stderr, 15)}`;
        }

        const webhook = a.webhookUrl ?? srv.webhookUrl ?? "";
        const env = [
          `# adpix-devops-mcp AI self-healing config (root-only)`,
          `ANTHROPIC_API_KEY=${key}`,
          a.model ? `ANTHROPIC_MODEL=${a.model}` : "",
          webhook ? `WEBHOOK_URL=${webhook}` : "",
          "",
        ].filter((l) => l !== "").join("\n");
        await uploadFile(s, AI_ENV_FILE, env, "600");
        await uploadFile(s, AI_FIX_SCRIPT_PATH, renderAiFixScript({ adpixDir: srv.adpixDir, maxTurns: a.maxTurns }), "755");

        return [
          `AI self-healing ready on ${srv.name}:`,
          `- Claude Code CLI: ${install.stdout.trim().split("\n").pop()}`,
          `- API key stored in ${AI_ENV_FILE} (mode 600, root) — use a key with a spend limit`,
          `- escalation fixer at ${AI_FIX_SCRIPT_PATH} (max ${a.maxTurns} turns, 30-min cooldown, transcripts in ${AI_LOG_DIR}/)`,
          ``,
          `Activate automatic escalation: watchdog_install with aiEscalate:true (escalateAfter defaults to 5 failed checks).`,
          `Manual runs: the ai_fix tool, any time.`,
        ].join("\n");
      });
    },
  },

  {
    name: "ai_fix",
    title: "AI fix / diagnose",
    description:
      "Point Claude Code (running headless ON the server) at a problem the deterministic tools can't " +
      "solve. It gathers evidence (containers, watchdog incidents, deploy history, resources, logs), " +
      "then investigates with hard guardrails: never delete volumes/databases/backups, never touch " +
      "secrets, never push, prefer the least-invasive fix, stop and report when unsure. " +
      "mode:'diagnose' investigates without changing anything. Returns the report + cost; full " +
      "transcript stays on the server.",
    schema: {
      server: serverParam,
      problem: z.string().describe("What's wrong / what to investigate, in plain words"),
      mode: z.enum(["fix", "diagnose"]).default("fix"),
      maxTurns: z.number().int().min(5).max(200).default(40),
      model: z.string().optional(),
      timeoutSeconds: z.number().int().min(60).max(3600).default(900),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as {
        server?: string; problem: string; mode: "fix" | "diagnose";
        maxTurns: number; model?: string; timeoutSeconds: number;
      };
      return withSession(deps, a.server, async (s, srv) => {
        const evidence = await gatherEvidence(s, srv.adpixDir);
        const prompt = buildFixPrompt({
          mode: a.mode,
          problem: a.problem,
          evidence,
          adpixDir: srv.adpixDir,
        });
        const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
        const promptFile = `${AI_LOG_DIR}/prompt-${ts}.txt`;
        const outFile = `${AI_LOG_DIR}/run-${ts}.json`;
        const errFile = `${AI_LOG_DIR}/run-${ts}.err`;
        await s.exec(`mkdir -p ${AI_LOG_DIR}`);
        await uploadFile(s, promptFile, prompt, "600");

        const r = await s.exec(
          claudeInvocation({
            promptFile,
            outFile,
            errFile,
            maxTurns: a.maxTurns,
            mode: a.mode,
            model: a.model,
            inlineApiKey: process.env.ANTHROPIC_API_KEY,
          }),
          { timeoutMs: a.timeoutSeconds * 1000 }
        );
        if (r.code === 86) {
          return `No Anthropic API key on ${srv.name} (and none in the MCP env) — run ai_setup first.`;
        }
        if (r.code === 87) {
          return `Claude Code CLI is not installed on ${srv.name} — run ai_setup first.`;
        }

        const parsed = parseClaudeResult(r.stdout);
        if (!parsed?.result) {
          return (
            `Claude Code run on ${srv.name} did not produce a parseable result (exit ${r.code}).\n` +
            `stderr tail:\n${lastLines(r.stderr, 15)}\n` +
            `Raw output is on the server at ${outFile} (errors: ${errFile}).`
          );
        }
        const meta =
          `turns: ${parsed.num_turns ?? "?"}` +
          (parsed.total_cost_usd != null ? `, cost: $${parsed.total_cost_usd.toFixed(4)}` : "") +
          (parsed.is_error ? `, FINISHED WITH ERROR (${parsed.subtype ?? "unknown"})` : "");
        return [
          `# Claude Code ${a.mode === "fix" ? "fix" : "diagnosis"} on ${srv.name} (${meta})`,
          ``,
          parsed.result,
          ``,
          `Full transcript: ${outFile} on the server. ${a.mode === "fix" ? "Run health_check to confirm the result independently." : ""}`,
        ].join("\n");
      });
    },
  },
];
