import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { uninstall, revokeKeys, rollback } from "../src/install/lifecycle.js";
import { parseArgs } from "../src/install/cli.js";
import { saveRegistry } from "../src/registry.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";

let tmp: string;
const SAVED = process.env.ADPIX_DEVOPS_HOME;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-life-test-")); process.env.ADPIX_DEVOPS_HOME = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

function deps(local: [RegExp, Partial<ExecResult>][], sshOut: [RegExp, Partial<ExecResult>][] = [], throwsFor: string[] = []) {
  const localCalls: string[] = [];
  const sshCalls: string[] = [];
  const d: Deps = {
    resolve: (n) => ({ name: n!, host: "10.0.0.2", port: 22, username: "root", adpixDir: "/opt/adpix" } as never),
    connect: async (srv) => {
      if (throwsFor.includes((srv as { name: string }).name)) throw new Error("SSH connect failed");
      const s: Session = { server: srv as never, authMethod: "publickey", close: () => {}, exec: async (c) => { sshCalls.push(c); for (const [re, r] of sshOut) if (re.test(c)) return { code: 0, stdout: "", stderr: "", ...r }; return { code: 0, stdout: "", stderr: "" }; } };
      return s;
    },
    local: async (c) => { localCalls.push(c); for (const [re, r] of local) if (re.test(c)) return { code: 0, stdout: "", stderr: "", ...r }; return { code: 0, stdout: "", stderr: "" }; },
  };
  return { d, localCalls, sshCalls };
}

describe("parseArgs", () => {
  it("parses the modes + flags", () => {
    expect(parseArgs([])).toMatchObject({ mode: "install" });
    expect(parseArgs(["--dry-run"]).mode).toBe("dry-run");
    expect(parseArgs(["--uninstall", "--purge"])).toMatchObject({ mode: "uninstall", purge: true });
    expect(parseArgs(["--revoke"]).mode).toBe("revoke");
    expect(parseArgs(["--rollback"]).mode).toBe("rollback");
    expect(parseArgs(["--answers-file", "/x.json", "--force"])).toMatchObject({ answersFile: "/x.json", force: true });
  });
});

describe("uninstall", () => {
  it("disables units + removes managed files; keeps data without --purge", async () => {
    const { d, localCalls } = deps([[/systemctl disable/, { code: 0, stdout: "" }]]);
    const out = await uninstall(d, {});
    expect(out).toMatch(/data kept/);
    const cmd = localCalls.join("\n");
    expect(cmd).toMatch(/disable --now adpix-devops-mcp\.service/);
    expect(cmd).toMatch(/rm -f \/etc\/systemd\/system\/adpix-devops-mcp\.service/);
    expect(cmd).toMatch(/sed -i .*adpix-devops-mcp \(managed/); // delimited Caddy block removal
    expect(cmd).not.toMatch(/rm -rf .*var\/lib/); // no purge
  });

  it("--purge also removes the state dir + registry", async () => {
    const { d, localCalls } = deps([]);
    const out = await uninstall(d, { purge: true });
    expect(out).toMatch(/PURGED/);
    expect(localCalls.join("\n")).toMatch(/rm -rf .*var\/lib\/adpix-devops-mcp/);
  });
});

describe("revokeKeys", () => {
  it("strips the key by its body from each target, flags unreachable ones", async () => {
    saveRegistry({ version: 1, servers: { a: { host: "h1", port: 22, username: "root", adpixDir: "/opt/adpix" }, b: { host: "h2", port: 22, username: "root", adpixDir: "/opt/adpix" } } });
    const { d, sshCalls } = deps([], [[/REVOKED|NOKEYS/, { stdout: "REVOKED" }]], ["b"]);
    const out = await revokeKeys(d, "ssh-ed25519 AAAAID_the_body_blob adpix-mcp@host");
    expect(out).toMatch(/a: MCP key removed/);
    expect(out).toMatch(/b: UNREACHABLE/);
    expect(sshCalls.join()).toMatch(/grep -vF .*AAAAID_the_body_blob/); // matches by body, not the from=/restrict line
  });
});

describe("rollback", () => {
  it("checks out the previous commit + rebuilds + restarts", async () => {
    const { d } = deps([[/git rev-parse --short 'HEAD@\{1\}'/, { code: 0, stdout: "rolled back to abc1234" }]]);
    const out = await rollback(d);
    expect(out).toMatch(/Rollback OK/);
  });
});
