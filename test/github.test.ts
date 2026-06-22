import { describe, expect, it } from "vitest";
import type { Deps } from "../src/deps.js";
import type { ServerConfig } from "../src/registry.js";
import type { ExecResult, Session } from "../src/ssh.js";
import { allTools } from "../src/tools/index.js";
import {
  coreSshCommand,
  deployKeyInstructions,
  ensureDeployKey,
  ensureSharedDeployKey,
  gitSshEnv,
  parseGithubRemote,
  toSshUrl,
} from "../src/github.js";

type Responder = [RegExp, Partial<ExecResult> | ((cmd: string) => Partial<ExecResult>)];

function match(responses: Responder[], cmd: string): ExecResult {
  for (const [re, res] of responses) if (re.test(cmd)) return { code: 0, stdout: "", stderr: "", ...(typeof res === "function" ? res(cmd) : res) };
  return { code: 0, stdout: "", stderr: "" };
}

// `responses` answer the prod SESSION; `localResponses` answer the MCP (deps.local) — where the
// shared deploy key is generated + checked for authorization before being distributed to the server.
function fakeSession(responses: Responder[], localResponses: Responder[] = []) {
  const calls: string[] = []; const localCalls: string[] = [];
  const server: ServerConfig = { name: "prod", host: "203.0.113.7", port: 22, username: "root", adpixDir: "/opt/adpix" };
  const session: Session = {
    server, authMethod: "publickey", close: () => {},
    exec: async (cmd: string) => { calls.push(cmd); return match(responses, cmd); },
  };
  const deps: Deps = { resolve: () => server, connect: async () => session, local: async (cmd: string) => { localCalls.push(cmd); return match(localResponses, cmd); } };
  return { deps, session, calls, localCalls };
}

const tool = (name: string) => allTools.find((t) => t.name === name)!;

describe("github url helpers", () => {
  it("parses https and ssh remotes", () => {
    expect(parseGithubRemote("https://github.com/mehrabiyan/adpix.git")).toEqual({ owner: "mehrabiyan", repo: "adpix" });
    expect(parseGithubRemote("git@github.com:mehrabiyan/adpix.git")).toEqual({ owner: "mehrabiyan", repo: "adpix" });
    expect(parseGithubRemote("ssh://git@github.com/a/b")).toEqual({ owner: "a", repo: "b" });
    expect(parseGithubRemote("https://gitlab.com/a/b")).toBeUndefined();
  });
  it("normalizes to the SSH form", () => {
    expect(toSshUrl("https://github.com/mehrabiyan/adpix")).toBe("git@github.com:mehrabiyan/adpix.git");
    expect(toSshUrl("git@github.com:mehrabiyan/adpix.git")).toBe("git@github.com:mehrabiyan/adpix.git");
  });
  it("builds matching env prefix and core.sshCommand", () => {
    expect(gitSshEnv("/k")).toContain("GIT_SSH_COMMAND=");
    expect(gitSshEnv("/k")).toContain("ssh -i /k");
    expect(coreSshCommand("/k")).toBe("ssh -i /k -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new");
  });
});

describe("ensureDeployKey", () => {
  it("reports authorized when ls-remote succeeds", async () => {
    const { session, calls } = fakeSession([
      [/adpix_deploy_ed25519\.pub/, { stdout: "ssh-ed25519 AAAAPUB adpix-deploy@h" }],
      [/git ls-remote/, { stdout: "OK" }],
    ]);
    const st = await ensureDeployKey(session, "https://github.com/mehrabiyan/adpix.git");
    expect(st.authorized).toBe(true);
    expect(st.sshUrl).toBe("git@github.com:mehrabiyan/adpix.git");
    expect(st.owner).toBe("mehrabiyan");
    expect(st.pubKey).toContain("ssh-ed25519");
    // generates only if absent, never overwrites
    expect(calls.some((c) => c.includes("[ -f") && c.includes("ssh-keygen"))).toBe(true);
  });

  it("reports unauthorized when ls-remote fails", async () => {
    const { session } = fakeSession([
      [/adpix_deploy_ed25519\.pub/, { stdout: "ssh-ed25519 AAAAPUB" }],
      [/git ls-remote/, { stdout: "NO" }],
    ]);
    const st = await ensureDeployKey(session, "git@github.com:mehrabiyan/adpix.git");
    expect(st.authorized).toBe(false);
  });

  it("rejects non-GitHub URLs", async () => {
    const { session } = fakeSession([]);
    await expect(ensureDeployKey(session, "https://gitlab.com/a/b")).rejects.toThrow(/Not a GitHub/);
  });
});

describe("deployKeyInstructions", () => {
  it("shows the key and the exact GitHub settings link", () => {
    const msg = deployKeyInstructions({
      pubKey: "ssh-ed25519 AAAAPUB host", sshUrl: "git@github.com:mehrabiyan/adpix.git",
      owner: "mehrabiyan", repo: "adpix", authorized: false,
    });
    expect(msg).toContain("READ-ONLY deploy key");
    expect(msg).toContain("ssh-ed25519 AAAAPUB host");
    expect(msg).toContain("https://github.com/mehrabiyan/adpix/settings/keys");
    expect(msg).toContain("write access");
  });
});

describe("ensureSharedDeployKey (MCP-managed, reused for every server)", () => {
  it("generates + checks the key ON THE MCP, then distributes it to the server when authorized", async () => {
    const { deps, session, calls, localCalls } = fakeSession(
      [], // session: only the key-write happens here
      [
        [/adpix_deploy_ed25519\.pub/, { stdout: "ssh-ed25519 SHARED mcp" }],
        [/git ls-remote/, { stdout: "OK" }],
        [/base64 </, { stdout: "QkFTRTY0" }],
      ]
    );
    const st = await ensureSharedDeployKey(deps, session, "https://github.com/mehrabiyan/adpix.git", "adpix");
    expect(st.authorized).toBe(true);
    expect(st.prodKeyPath).toBe("/root/.ssh/adpix_deploy_ed25519"); // shared with cicd_enable
    // keygen + ls-remote ran on the MCP, not the server
    expect(localCalls.some((c) => c.includes("ssh-keygen"))).toBe(true);
    expect(localCalls.some((c) => c.includes("git ls-remote"))).toBe(true);
    expect(calls.some((c) => c.includes("ssh-keygen"))).toBe(false);
    // the key was pushed to the server (base64 -d to the canonical path)
    expect(calls.some((c) => /base64 -d > '\/root\/\.ssh\/adpix_deploy_ed25519'/.test(c))).toBe(true);
  });

  it("does NOT touch the server when the shared key isn't authorized yet", async () => {
    const { deps, session, calls } = fakeSession([], [
      [/adpix_deploy_ed25519\.pub/, { stdout: "ssh-ed25519 SHARED mcp" }],
      [/git ls-remote/, { stdout: "NO" }],
    ]);
    const st = await ensureSharedDeployKey(deps, session, "git@github.com:mehrabiyan/adpix.git", "adpix");
    expect(st.authorized).toBe(false);
    expect(calls).toHaveLength(0); // nothing written to the server
  });
});

describe("adpix_install with the shared MCP deploy key", () => {
  const baseArgs = { branch: "main", repoUrl: "https://github.com/mehrabiyan/adpix.git", skipPreflight: true, timeoutSeconds: 600 };

  it("prints the ONE key and installs nothing when it isn't authorized yet", async () => {
    const { deps, calls } = fakeSession(
      [[/command -v git/, { code: 0 }]],
      [[/adpix_deploy_ed25519\.pub/, { stdout: "ssh-ed25519 NEWKEY mcp" }], [/git ls-remote/, { stdout: "NO" }]]
    );
    const out = await tool("adpix_install").handler(deps, { ...baseArgs, deployKey: true });
    expect(out).toMatch(/reused for every server/i);
    expect(out).toContain("ssh-ed25519 NEWKEY");
    expect(out).toContain("Nothing installed yet");
    expect(calls.some((c) => c.includes("deploy.sh"))).toBe(false);
    expect(calls.some((c) => c.includes("git clone"))).toBe(false);
  });

  it("distributes the key + clones over SSH once authorized, then deploys", async () => {
    const { deps, calls } = fakeSession(
      [
        [/command -v git/, { code: 0 }],
        [/git clone/, { code: 0 }],
        [/deploy\.sh/, { code: 0, stdout: "AdPix Analytics is running." }],
        [/for i in \$\(seq/, { code: 0, stdout: "healthy after ~5s (HTTP 200)" }],
        [/SITE_ADDRESS/, { stdout: "" }],
        [/PUBLIC_BASE_URL/, { stdout: "http://203.0.113.7" }],
        [/ADMIN_EMAIL/, { stdout: "admin@example.com" }],
      ],
      [[/adpix_deploy_ed25519\.pub/, { stdout: "ssh-ed25519 OKKEY mcp" }], [/git ls-remote/, { stdout: "OK" }], [/base64 </, { stdout: "QkFTRTY0" }]]
    );
    const out = await tool("adpix_install").handler(deps, { ...baseArgs, deployKey: true });
    expect(out).toContain("managed on the MCP");
    expect(out).toContain("authorized for mehrabiyan/adpix");
    expect(calls.some((c) => /base64 -d > '\/root\/\.ssh\/adpix_deploy_ed25519'/.test(c))).toBe(true); // key pushed
    const cloneCall = calls.find((c) => c.includes("git clone"));
    expect(cloneCall).toContain("git@github.com:mehrabiyan/adpix.git");
    expect(cloneCall).toContain("GIT_SSH_COMMAND=");
    expect(cloneCall).toContain("core.sshCommand");
    expect(out).toContain("http://203.0.113.7");
  });

  it("auto-switches to the shared key when a public clone hits an auth wall (unauthorized → prints key)", async () => {
    const { deps, calls } = fakeSession(
      [[/command -v git/, { code: 0 }], [/git clone -b 'main' 'https:/, { code: 128, stderr: "fatal: could not read Username for 'https://github.com': No such device or address" }]],
      [[/adpix_deploy_ed25519\.pub/, { stdout: "ssh-ed25519 AUTOKEY mcp" }], [/git ls-remote/, { stdout: "NO" }]]
    );
    const out = await tool("adpix_install").handler(deps, { ...baseArgs, deployKey: false });
    expect(out).toContain("ssh-ed25519 AUTOKEY");
    expect(out).toContain("Nothing installed yet");
    expect(calls.some((c) => c.includes("deploy.sh"))).toBe(false);
  });

  it("auto shared-key: clones over SSH + deploys when the key is already authorized", async () => {
    const { deps, calls } = fakeSession(
      [
        [/command -v git/, { code: 0 }],
        [/git clone -b 'main' 'https:/, { code: 128, stderr: "could not read Username for 'https://github.com'" }],
        [/git clone -b 'main' 'git@github/, { code: 0 }],
        [/deploy\.sh/, { code: 0, stdout: "AdPix Analytics is running." }],
        [/for i in \$\(seq/, { code: 0, stdout: "healthy after ~5s (HTTP 200)" }],
        [/SITE_ADDRESS/, { stdout: "" }],
        [/PUBLIC_BASE_URL/, { stdout: "http://203.0.113.7" }],
        [/ADMIN_EMAIL/, { stdout: "admin@example.com" }],
      ],
      [[/adpix_deploy_ed25519\.pub/, { stdout: "ssh-ed25519 OKKEY mcp" }], [/git ls-remote/, { stdout: "OK" }], [/base64 </, { stdout: "QkFTRTY0" }]]
    );
    const out = await tool("adpix_install").handler(deps, { ...baseArgs, deployKey: false });
    expect(out).toContain("authorized for mehrabiyan/adpix");
    expect(calls.some((c) => /git clone -b 'main' 'git@github\.com:mehrabiyan\/adpix\.git'/.test(c))).toBe(true);
    expect(out).toContain("http://203.0.113.7");
  });
});
