import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Deps } from "../src/deps.js";
import type { ServerConfig } from "../src/registry.js";
import type { ExecResult, Session } from "../src/ssh.js";
import { allTools } from "../src/tools/index.js";

type Responder = [RegExp, Partial<ExecResult> | ((cmd: string) => Partial<ExecResult>)];

function fakeDeps(responses: Responder[], srvOverrides: Partial<ServerConfig> = {}) {
  const calls: string[] = [];
  const server: ServerConfig = {
    name: "prod", host: "203.0.113.7", port: 22, username: "root", adpixDir: "/opt/adpix", ...srvOverrides,
  };
  const session: Session = {
    server, authMethod: "publickey", close: () => {},
    exec: async (cmd: string) => {
      calls.push(cmd);
      for (const [re, res] of responses) {
        if (re.test(cmd)) {
          const r = typeof res === "function" ? res(cmd) : res;
          return { code: 0, stdout: "", stderr: "", ...r };
        }
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const deps: Deps = {
    resolve: () => server,
    connect: async () => session,
    local: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  return { deps, calls };
}

const tool = (name: string) => {
  const t = allTools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};

const savedKey = process.env.ANTHROPIC_API_KEY;
beforeEach(() => delete process.env.ANTHROPIC_API_KEY);
afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

describe("ai_setup", () => {
  it("requires an API key from somewhere", async () => {
    const { deps, calls } = fakeDeps([]);
    const out = await tool("ai_setup").handler(deps, { maxTurns: 40 });
    expect(out).toContain("No API key");
    expect(calls).toHaveLength(0);
  });

  it("installs CLI, key file (600) and the escalation script", async () => {
    const { deps, calls } = fakeDeps([
      [/claude --version/, { stdout: "2.1.0 (Claude Code)" }],
    ]);
    const out = await tool("ai_setup").handler(deps, { apiKey: "sk-test-123", maxTurns: 40 });
    expect(out).toContain("AI self-healing ready");
    const envUpload = calls.find((c) => c.includes("/etc/adpix-ai/env") && c.includes("base64 -d"));
    expect(envUpload).toBeTruthy();
    expect(envUpload).toContain("chmod 600");
    expect(calls.some((c) => c.includes("/usr/local/bin/adpix-ai-fix.sh") && c.includes("chmod 755"))).toBe(true);
    // key is uploaded base64-encoded, never in clear in the command line
    expect(envUpload).not.toContain("sk-test-123");
    expect(out).toContain("watchdog_install with aiEscalate:true");
  });
});

describe("ai_fix", () => {
  const args = { problem: "ingest is 502ing", mode: "fix", maxTurns: 40, timeoutSeconds: 900 } as const;

  it("points at ai_setup when the CLI is missing", async () => {
    const { deps } = fakeDeps([[/claude -p|NO_CLAUDE_CLI/, { code: 87, stderr: "NO_CLAUDE_CLI" }]]);
    const out = await tool("ai_fix").handler(deps, { ...args });
    expect(out).toContain("run ai_setup first");
  });

  it("points at ai_setup when no key is available", async () => {
    const { deps } = fakeDeps([[/claude -p|NO_API_KEY/, { code: 86, stderr: "NO_API_KEY" }]]);
    const out = await tool("ai_fix").handler(deps, { ...args });
    expect(out).toContain("No Anthropic API key");
  });

  it("returns the report with turns and cost on success", async () => {
    const { deps, calls } = fakeDeps([
      [/claude -p/, {
        stdout: JSON.stringify({
          type: "result", result: "ROOT CAUSE: disk full\nWHAT I CHANGED: pruned build cache",
          total_cost_usd: 0.3141, num_turns: 12,
        }),
      }],
    ]);
    const out = await tool("ai_fix").handler(deps, { ...args });
    expect(out).toContain("ROOT CAUSE: disk full");
    expect(out).toContain("turns: 12");
    expect(out).toContain("$0.3141");
    // evidence was gathered and the prompt uploaded before the run
    expect(calls.some((c) => c.includes("--- containers ---"))).toBe(true);
    expect(calls.some((c) => c.includes("prompt-") && c.includes("base64 -d"))).toBe(true);
  });

  it("diagnose mode restricts the tool allowlist", async () => {
    const { deps, calls } = fakeDeps([[/claude -p/, { stdout: '{"result":"DIAGNOSIS: x","num_turns":3}' }]]);
    await tool("ai_fix").handler(deps, { ...args, mode: "diagnose" });
    const run = calls.find((c) => c.includes("claude -p"));
    expect(run).toContain('--allowedTools "Bash,Read,Grep,Glob"');
    expect(run).not.toContain("Edit,Write");
  });
});

describe("watchdog AI escalation gating", () => {
  it("watchdog_install with aiEscalate requires ai_setup artifacts", async () => {
    const { deps } = fakeDeps([[/test -x \/usr\/local\/bin\/adpix-ai-fix\.sh/, { stdout: "no" }]]);
    const out = await tool("watchdog_install").handler(deps, {
      intervalSeconds: 60, autoRestart: true, httpPath: "/_apx_health",
      realertEvery: 30, aiEscalate: true, escalateAfter: 5,
    });
    expect(out).toContain("run ai_setup first");
  });
});
