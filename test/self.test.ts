import { describe, expect, it } from "vitest";
import type { Deps } from "../src/deps.js";
import type { ExecResult } from "../src/ssh.js";
import { allTools } from "../src/tools/index.js";

type Responder = [RegExp, Partial<ExecResult> | ((cmd: string) => Partial<ExecResult>)];

function depsWithLocal(responses: Responder[]) {
  const calls: string[] = [];
  const deps: Deps = {
    resolve: () => { throw new Error("not used"); },
    connect: async () => { throw new Error("not used"); },
    local: async (cmd: string) => {
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
  return { deps, calls };
}

const selfUpdate = allTools.find((t) => t.name === "mcp_self_update")!;

describe("mcp_self_update", () => {
  it("refuses outside a git checkout", async () => {
    const { deps } = depsWithLocal([[/is-inside-work-tree/, { stdout: "false\n", code: 128 }]]);
    const out = await selfUpdate.handler(deps, { force: false, confirm: true });
    expect(out).toContain("Not a git checkout");
  });

  it("refuses on local modifications (possible AI self-heal patches)", async () => {
    const { deps, calls } = depsWithLocal([
      [/is-inside-work-tree/, { stdout: "true\n" }],
      [/status --porcelain/, { stdout: " M src/index.ts\n" }],
    ]);
    const out = await selfUpdate.handler(deps, { force: false, confirm: true });
    expect(out).toContain("Refusing to self-update");
    expect(out).toContain("src/index.ts");
    expect(calls.some((c) => c.includes("pull"))).toBe(false);
  });

  it("short-circuits when already up to date", async () => {
    const { deps, calls } = depsWithLocal([
      [/is-inside-work-tree/, { stdout: "true\n" }],
      [/status --porcelain/, { stdout: "" }],
      [/rev-parse --short HEAD/, { stdout: "abc1234\n" }],
      [/pull --ff-only/, { stdout: "Already up to date.\n" }],
    ]);
    const out = await selfUpdate.handler(deps, { force: false, confirm: true });
    expect(out).toContain("Already up to date (abc1234)");
    expect(calls.some((c) => c.includes("npm ci"))).toBe(false);
  });

  it("reports a failed build without restarting", async () => {
    let head = "aaa1111";
    const { deps, calls } = depsWithLocal([
      [/is-inside-work-tree/, { stdout: "true\n" }],
      [/status --porcelain/, { stdout: "" }],
      [/rev-parse --short HEAD/, () => ({ stdout: head + "\n" })],
      [/pull --ff-only/, () => { head = "bbb2222"; return { stdout: "Updating...\n" }; }],
      [/npm ci/, { code: 1, stdout: "TS2304: Cannot find name 'oops'" }],
    ]);
    const out = await selfUpdate.handler(deps, { force: false, confirm: true });
    expect(out).toContain("BUILD FAILED");
    expect(out).toContain("aaa1111 → bbb2222");
    expect(calls.some((c) => c.includes("systemctl restart"))).toBe(false);
  });

  it("rebuilds and schedules a restart under systemd", async () => {
    const prevInvocation = process.env.INVOCATION_ID;
    process.env.INVOCATION_ID = "deadbeef";
    try {
      let head = "aaa1111";
      const { deps, calls } = depsWithLocal([
        [/is-inside-work-tree/, { stdout: "true\n" }],
        [/status --porcelain/, { stdout: "" }],
        [/rev-parse --short HEAD/, () => ({ stdout: head + "\n" })],
        [/pull --ff-only/, () => { head = "bbb2222"; return { stdout: "Updating...\n" }; }],
        [/npm ci/, { code: 0, stdout: "built" }],
      ]);
      const out = await selfUpdate.handler(deps, { force: false, confirm: true });
      expect(out).toContain("Restarting the service in ~2s");
      expect(calls.some((c) => c.includes("sudo -n systemctl restart adpix-devops-mcp.service"))).toBe(true);
    } finally {
      if (prevInvocation === undefined) delete process.env.INVOCATION_ID;
      else process.env.INVOCATION_ID = prevInvocation;
    }
  });
});
