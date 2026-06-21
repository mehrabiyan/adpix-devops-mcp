import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _steps, buildSteps } from "../src/install/steps.js";
import { runPlan, type InstallContext } from "../src/install/core.js";
import { emptyJournal } from "../src/install/journal.js";
import { defaultAnswers, type InstallAnswers, type SecretsBag } from "../src/install/answers.js";
import { loadRegistry } from "../src/registry.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";

let tmp: string;
const SAVED = process.env.ADPIX_DEVOPS_HOME;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-steps-test-")); process.env.ADPIX_DEVOPS_HOME = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

type LResp = [RegExp, Partial<ExecResult>];
type SResp = [RegExp, Partial<ExecResult>];
function deps(local: LResp[], ssh: SResp[] = [], sshThrows: Record<string, string> = {}): { d: Deps; sshCalls: string[] } {
  const sshCalls: string[] = [];
  const d: Deps = {
    resolve: (n) => ({ name: n!, host: "10.0.0.2", port: 22, username: "root", adpixDir: "/opt/adpix" } as never),
    connect: async (srv) => {
      if (sshThrows[(srv as { name: string }).name]) throw new Error(sshThrows[(srv as { name: string }).name]);
      const session: Session = {
        server: srv as never, authMethod: "publickey", close: () => {},
        exec: async (cmd) => { sshCalls.push(cmd); for (const [re, r] of ssh) if (re.test(cmd)) return { code: 0, stdout: "", stderr: "", ...r }; return { code: 0, stdout: "", stderr: "" }; },
      };
      return session;
    },
    local: async (cmd) => { for (const [re, r] of local) if (re.test(cmd)) return { code: 0, stdout: "", stderr: "", ...r }; return { code: 0, stdout: "", stderr: "" }; },
  };
  return { d, sshCalls };
}

function answers(): InstallAnswers {
  return {
    mcp: { domain: "mcp.example.com", port: 8930, bindHost: "127.0.0.1", tokenMode: "preserve", apiKeyMode: "none" },
    fleet: [{ name: "prod", host: "10.0.0.2", port: 22, username: "root", role: "standalone", adpixDir: "/opt/adpix", authorizeKey: true, bootstrapAuth: "agent" }],
    emit: { clients: ["claude-code"], dnsPlan: true },
  };
}
const ctx = (d: Deps, a = answers(), secrets: SecretsBag = { perTarget: {} }): InstallContext =>
  ({ answers: a, secrets, deps: d, journal: emptyJournal(), log: () => {}, force: false, runtime: {} });

describe("install steps", () => {
  it("gather-registry writes the fleet with the MCP key PATH (never bytes)", async () => {
    const c = ctx(deps([]).d);
    await _steps.gatherRegistry.apply(c);
    const reg = loadRegistry();
    expect(reg.servers["prod"].host).toBe("10.0.0.2");
    expect(reg.servers["prod"].privateKeyPath).toMatch(/\.ssh\/id_ed25519$/);
    expect(JSON.stringify(reg)).not.toMatch(/BEGIN .*PRIVATE KEY/);
  });

  it("identity reads the pubkey + host IP + token into runtime", async () => {
    const { d } = deps([
      [/cat .*id_ed25519\.pub/, { stdout: "ssh-ed25519 AAAAID test adpix" }],
      [/hostname -I/, { stdout: "203.0.113.7" }],
      [/MCP_AUTH_TOKEN=/, { stdout: "deadbeef" }],
    ]);
    const c = ctx(d);
    const r = await _steps.identity.apply(c);
    expect(r.ok).toBe(true);
    expect(c.runtime.mcpPubkey).toMatch(/^ssh-ed25519/);
    expect(c.runtime.mcpHostIp).toBe("203.0.113.7");
    expect(c.runtime.mcpToken).toBe("deadbeef");
  });

  it("authorize-key appends a SOURCE-PINNED, restricted key line idempotently", async () => {
    const { d, sshCalls } = deps([], [[/APPENDED/, { stdout: "APPENDED" }]]);
    const c = ctx(d);
    c.runtime.mcpPubkey = "ssh-ed25519 AAAAID test";
    c.runtime.mcpHostIp = "203.0.113.7";
    const r = await _steps.authorizeKey.apply(c);
    expect(r.ok).toBe(true);
    expect(c.journal.targets["prod"].authorized).toBe(true);
    const appendCmd = sshCalls.find((s) => s.includes("authorized_keys"))!;
    expect(appendCmd).toMatch(/from="203\.0\.113\.7",restrict ssh-ed25519/);
    expect(appendCmd).toMatch(/grep -qxF/); // idempotent
  });

  it("authorize-key SKIPS a target with authorizeKey:false (no SSH)", async () => {
    const a = answers(); a.fleet[0].authorizeKey = false;
    const { d, sshCalls } = deps([]);
    const c = ctx(d, a);
    c.runtime.mcpPubkey = "ssh-ed25519 x";
    await _steps.authorizeKey.apply(c);
    expect(c.journal.targets["prod"].detail).toMatch(/skipped/);
    expect(sshCalls.length).toBe(0);
  });

  it("verify-ssh soft-fails (keeps going) when a target is unreachable", async () => {
    const { d } = deps([], [], { prod: "SSH host-key verification FAILED" });
    const c = ctx(d);
    const r = await _steps.verifySsh.apply(c);
    expect(r.ok).toBe(false);
    expect(r.soft).toBe(true); // does not abort the plan
    expect(c.journal.targets["prod"].verified).toBe(false);
  });

  it("full plan runs end to end and emits DNS + connect + verify artifacts", async () => {
    const { d } = deps(
      [
        [/healthz/, { stdout: "ok" }],
        [/install-server\.sh/, { code: 0, stdout: "done" }],
        [/cat .*id_ed25519\.pub/, { stdout: "ssh-ed25519 AAAAID test" }],
        [/hostname -I/, { stdout: "203.0.113.7" }],
        [/MCP_AUTH_TOKEN=/, { stdout: "tok123" }],
        [/initialize/, { stdout: '{"serverInfo":{"name":"adpix-devops-mcp"}}' }],
        [/dig \+short/, { stdout: "203.0.113.9" }],
        [/openssl s_client/, { stdout: "subject=CN=mcp.example.com" }],
      ],
      [[/APPENDED/, { stdout: "APPENDED" }], [/uname/, { code: 0, stdout: "Linux docker:yes" }]]
    );
    const c = ctx(d);
    const out = await runPlan(buildSteps(), c, false);
    expect(out.aborted).toBe(false);
    expect(c.runtime.emitDns).toMatch(/DNS plan/);
    expect(c.runtime.emitConnect).toMatch(/Claude Code/);
    expect(c.runtime.emitVerify).toMatch(/READY/);
    expect(c.journal.targets["prod"].authorized).toBe(true);
  });
});
