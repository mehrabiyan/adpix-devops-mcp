import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PROMPT_RULES,
  buildFixPrompt,
  claudeInvocation,
  parseClaudeResult,
  renderAiFixScript,
} from "../src/remote/aifix.js";

describe("buildFixPrompt", () => {
  const base = { problem: "api container crash-looping", evidence: "EV-MARKER", adpixDir: "/opt/adpix" };

  it("fix mode carries the guardrails, facts, problem and evidence", () => {
    const p = buildFixPrompt({ ...base, mode: "fix" });
    expect(p).toContain("NEVER delete or prune docker volumes");
    expect(p).toContain("NEVER git push");
    expect(p).toContain("/opt/adpix");
    expect(p).toContain("api container crash-looping");
    expect(p).toContain("EV-MARKER");
    expect(p).toContain("ROOT CAUSE:");
  });

  it("diagnose mode forbids changes and asks for a recommendation", () => {
    const p = buildFixPrompt({ ...base, mode: "diagnose" });
    expect(p).toContain("DIAGNOSE ONLY");
    expect(p).toContain("RECOMMENDED FIX");
    expect(p).not.toContain("WHAT I CHANGED");
  });

  it("rules are heredoc-safe (no $, backticks, or single quotes)", () => {
    expect(PROMPT_RULES).not.toMatch(/[$`']/);
  });
});

describe("claudeInvocation", () => {
  const o = {
    promptFile: "/var/log/adpix-ai/prompt-x.txt",
    outFile: "/var/log/adpix-ai/run-x.json",
    errFile: "/var/log/adpix-ai/run-x.err",
    maxTurns: 40,
    mode: "fix" as const,
  };

  it("builds a headless run with turn budget and tool allowlist", () => {
    const c = claudeInvocation(o);
    expect(c).toContain("claude -p --output-format json --max-turns 40");
    expect(c).toContain('--allowedTools "Bash,Read,Grep,Glob,Edit,Write"');
    expect(c).toContain("< '/var/log/adpix-ai/prompt-x.txt'");
    expect(c).toContain("NO_API_KEY");
    expect(c).toContain("NO_CLAUDE_CLI");
  });

  it("diagnose mode drops the write tools", () => {
    expect(claudeInvocation({ ...o, mode: "diagnose" })).toContain('--allowedTools "Bash,Read,Grep,Glob"');
  });

  it("passes model and inline key safely", () => {
    const c = claudeInvocation({ ...o, model: "claude-opus-4-8", inlineApiKey: "sk-x'y" });
    expect(c).toContain("--model 'claude-opus-4-8'");
    expect(c).toContain("ANTHROPIC_API_KEY='sk-xy'"); // quote stripped, not escaped out
  });
});

describe("parseClaudeResult", () => {
  it("parses the result JSON", () => {
    const r = parseClaudeResult('{"type":"result","result":"fixed it","total_cost_usd":0.42,"num_turns":7}');
    expect(r?.result).toBe("fixed it");
    expect(r?.total_cost_usd).toBe(0.42);
  });
  it("takes the last JSON document when noise precedes it", () => {
    const r = parseClaudeResult('npm warn something\n{"result":"ok","num_turns":3}');
    expect(r?.result).toBe("ok");
  });
  it("returns undefined on garbage", () => {
    expect(parseClaudeResult("total failure")).toBeUndefined();
  });
});

describe("ai-fix escalation script", () => {
  const s = renderAiFixScript({ adpixDir: "/opt/adpix", maxTurns: 40 });

  it("substitutes settings, self-protects, and gathers evidence", () => {
    expect(s).toContain("ADPIX_DIR='/opt/adpix'");
    expect(s).toContain("MAX_TURNS=40");
    expect(s).toContain("flock -n 9");
    expect(s).toContain('"$age" -lt 1800'); // 30-min cooldown
    expect(s).toContain("NEVER delete or prune docker volumes");
    expect(s).toContain("docker compose -p adanalytics");
    expect(s).not.toContain("undefined");
  });

  it("is valid bash (bash -n)", () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ai-")), "f.sh");
    fs.writeFileSync(tmp, s);
    execFileSync("bash", ["-n", tmp]);
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  });
});
