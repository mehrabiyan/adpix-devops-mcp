import { describe, expect, it } from "vitest";
import type { Deps } from "../src/deps.js";
import type { ServerConfig } from "../src/registry.js";
import type { ExecResult, Session } from "../src/ssh.js";
import { allTools } from "../src/tools/index.js";
import { parseGithubRemote } from "../src/tools/cicd.js";

type Responder = [RegExp, Partial<ExecResult> | ((cmd: string) => Partial<ExecResult>)];

function fakeDeps(responses: Responder[], srvOverrides: Partial<ServerConfig> = {}) {
  const calls: string[] = [];
  const server: ServerConfig = {
    name: "prod", host: "203.0.113.7", port: 22, username: "root", adpixDir: "/opt/adpix",
    webhookUrl: "https://hooks.example.com/x", ...srvOverrides,
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

describe("parseGithubRemote", () => {
  it("parses https and ssh remotes, with and without .git", () => {
    expect(parseGithubRemote("https://github.com/mehrabiyan/adpix.git")).toEqual({ owner: "mehrabiyan", repo: "adpix" });
    expect(parseGithubRemote("https://github.com/a/b")).toEqual({ owner: "a", repo: "b" });
    expect(parseGithubRemote("git@github.com:a/b.git")).toEqual({ owner: "a", repo: "b" });
    expect(parseGithubRemote("https://gitlab.com/a/b")).toBeUndefined();
  });
});

describe("cicd_enable", () => {
  const argsDefaults = { branch: "main", intervalSeconds: 300, skipBackup: false };

  it("requires an existing install", async () => {
    const { deps } = fakeDeps([[/test -d .*\.git.* && echo yes/, { stdout: "no" }]]);
    const out = await tool("cicd_enable").handler(deps, argsDefaults);
    expect(out).toContain("adpix_install first");
  });

  it("installs script + units and enables the timer when fetch works", async () => {
    const { deps, calls } = fakeDeps([
      [/test -d .*\.git.* && echo yes/, { stdout: "yes" }],
      [/git fetch origin/, { code: 0 }],
    ]);
    const out = await tool("cicd_enable").handler(deps, argsDefaults);
    expect(out).toContain("Continuous deployment ENABLED");
    expect(out).toContain("no deploy key needed");
    expect(calls.some((c) => c.includes("adpix-autodeploy.sh") && c.includes("base64 -d"))).toBe(true);
    expect(calls.some((c) => c.includes("adpix-autodeploy.timer") && c.includes("enable --now"))).toBe(true);
    expect(out).toContain("protect that branch");
  });

  it("sets up a read-only deploy key for private repos and still enables the timer", async () => {
    const { deps, calls } = fakeDeps([
      [/test -d .*\.git.* && echo yes/, { stdout: "yes" }],
      [/GIT_TERMINAL_PROMPT=0 timeout 30 git fetch/, { code: 128, stdout: "fatal: could not read Username for 'https://github.com'" }],
      [/git remote get-url origin/, { stdout: "https://github.com/mehrabiyan/adpix.git\n" }],
      [/adpix_deploy_ed25519\.pub/, { stdout: "ssh-ed25519 AAAA-test adpix-autodeploy@host\n" }],
    ]);
    const out = await tool("cicd_enable").handler(deps, argsDefaults);
    expect(out).toContain("READ-ONLY deploy key");
    expect(out).toContain("ssh-ed25519 AAAA-test");
    expect(out).toContain("github.com/mehrabiyan/adpix/settings/keys");
    expect(calls.some((c) => c.includes("remote set-url origin") && c.includes("git@github.com:mehrabiyan/adpix.git"))).toBe(true);
    expect(calls.some((c) => c.includes("core.sshCommand"))).toBe(true);
    expect(out).toContain("Continuous deployment ENABLED");
  });

  it("surfaces non-auth fetch failures instead of enabling", async () => {
    const { deps } = fakeDeps([
      [/test -d .*\.git.* && echo yes/, { stdout: "yes" }],
      [/git fetch/, { code: 1, stdout: "fatal: unable to access: Could not resolve host" }],
    ]);
    const out = await tool("cicd_enable").handler(deps, argsDefaults);
    expect(out).toContain("fix this first");
    expect(out).not.toContain("ENABLED");
  });
});

describe("cicd_status / cicd_run_now", () => {
  it("explains when CI/CD is not enabled", async () => {
    const { deps } = fakeDeps([[/systemctl is-enabled adpix-autodeploy/, { stdout: "===TIMER\nnot-installed\n" }]]);
    const out = await tool("cicd_status").handler(deps, { history: 10 });
    expect(out).toContain("not enabled");
  });

  it("renders timer, state, version and history", async () => {
    const { deps } = fakeDeps([
      [/echo ===TIMER/, {
        stdout: [
          "===TIMER", "enabled", "NEXT  LEFT  adpix-autodeploy.timer",
          "===STATE", '{"ts":"2026-06-10T00:00:00Z","head":"abc1234","result":"deployed","detail":"aaa -> abc"}',
          "===GIT", "deployed: abc1234 fix the thing (2026-06-10)", "behind origin/main by 0 commit(s)",
          "===HISTORY", '{"ts":"2026-06-10T00:00:00Z","event":"deployed","from":"aaa","to":"abc1234","detail":"ok"}',
        ].join("\n"),
      }],
    ]);
    const out = await tool("cicd_status").handler(deps, { history: 10 });
    expect(out).toContain('"result":"deployed"');
    expect(out).toContain("behind origin/main by 0");
    expect(out).toContain('"event":"deployed"');
  });

  it("run_now refuses when not installed", async () => {
    const { deps } = fakeDeps([[/test -x .*autodeploy\.sh/, { stdout: "no" }]]);
    const out = await tool("cicd_run_now").handler(deps, { timeoutSeconds: 60 });
    expect(out).toContain("cicd_enable first");
  });
});
