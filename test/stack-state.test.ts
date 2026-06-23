import { describe, expect, it } from "vitest";
import { stackState, requireStack } from "../src/adpix.js";
import type { ExecResult, Session } from "../src/ssh.js";

// fake session: control the `.git` presence + the `docker ps ... -q | wc -l` running/total counts.
function sess(opts: { cloned: boolean; running?: number; total?: number }): Session {
  return {
    server: { name: "prod", host: "h", port: 22, username: "root", adpixDir: "/opt/adpix" },
    authMethod: "publickey", close: () => {},
    exec: async (cmd: string): Promise<ExecResult> => {
      if (/&& echo yes \|\| echo no/.test(cmd)) return { code: 0, stdout: opts.cloned ? "yes" : "no", stderr: "" };
      if (/com\.docker\.compose\.project=.* -q/.test(cmd)) return { code: 0, stdout: `${opts.running ?? 0} ${opts.total ?? 0}`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

describe("stackState", () => {
  it("not cloned", async () => { expect(await stackState(sess({ cloned: false }), "/opt/adpix")).toEqual({ cloned: false, running: 0, total: 0, up: false }); });
  it("cloned but down (0 running)", async () => { expect(await stackState(sess({ cloned: true, running: 0, total: 8 }), "/opt/adpix")).toEqual({ cloned: true, running: 0, total: 8, up: false }); });
  it("running", async () => { expect(await stackState(sess({ cloned: true, running: 8, total: 8 }), "/opt/adpix")).toEqual({ cloned: true, running: 8, total: 8, up: true }); });
});

describe("requireStack", () => {
  it("not installed → clear provision message", async () => {
    const m = await requireStack(sess({ cloned: false }), "/opt/adpix", "prod", { needRunning: true });
    expect(m).toMatch(/not installed/); expect(m).toMatch(/Install/);
  });
  it("cloned-but-down + needRunning → 'NOT running' (the bug class)", async () => {
    const m = await requireStack(sess({ cloned: true, running: 0, total: 8 }), "/opt/adpix", "prod", { needRunning: true });
    expect(m).toMatch(/NOT running \(0 of 8/); expect(m).toMatch(/re-running Install/);
  });
  it("cloned-but-down without needRunning → ok (update/status allowed)", async () => {
    expect(await requireStack(sess({ cloned: true, running: 0, total: 8 }), "/opt/adpix", "prod", {})).toBeNull();
  });
  it("running → ok", async () => {
    expect(await requireStack(sess({ cloned: true, running: 8, total: 8 }), "/opt/adpix", "prod", { needRunning: true })).toBeNull();
  });
  it("product label is used in the message", async () => {
    const m = await requireStack(sess({ cloned: false }), "/opt/x", "prod", { needRunning: true, product: "Tag Manager" });
    expect(m).toMatch(/Tag Manager is not installed/);
  });
});
