import { describe, expect, it } from "vitest";
import { allTools } from "../src/tools/index.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";

const SRV: ServerConfig = { name: "prod3", host: "10.0.0.3", port: 22, username: "root", adpixDir: "/opt/adpix" };
const tool = (n: string) => { const t = allTools.find((t) => t.name === n); if (!t) throw new Error(n); return t; };

function deps(responses: [RegExp, Partial<ExecResult>][]) {
  const session: Session = {
    server: SRV, authMethod: "publickey", close: () => {},
    exec: async (cmd: string): Promise<ExecResult> => { for (const [re, r] of responses) if (re.test(cmd)) return { code: 0, stdout: "", stderr: "", ...r }; return { code: 0, stdout: "", stderr: "" }; },
  };
  return { resolve: () => SRV, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) } as Deps;
}

const HOST_OK: [RegExp, Partial<ExecResult>] = [/etc\/os-release/, { stdout: "OS=Ubuntu 24.04 LTS\nDOCKER=Docker version 27.1\nDAEMON=up\nDISKMB=40000\nRAMMB=8000" }];

describe("stack_doctor", () => {
  it("FAILS clearly when not installed (and stops early)", async () => {
    const d = deps([HOST_OK, [/&& echo yes \|\| echo no/, { stdout: "no" }]]);
    const out = await tool("stack_doctor").handler(d, {});
    expect(out).toMatch(/✗ AdPix install: not installed/);
    expect(out).toMatch(/VERDICT: FAIL/);
    expect(out).toMatch(/NEXT: provision it/);
  });

  it("FAILS when cloned but containers are down (the bug class)", async () => {
    const d = deps([HOST_OK, [/&& echo yes \|\| echo no/, { stdout: "yes" }], [/com\.docker\.compose\.project=.* -q/, { stdout: "0 8" }], [/rev-parse --short HEAD/, { stdout: "abc1234 main 0" }]]);
    const out = await tool("stack_doctor").handler(d, {});
    expect(out).toMatch(/✗ Containers: 0\/8 running — the stack is DOWN/);
    expect(out).toMatch(/re-run adpix_install/);
    expect(out).toMatch(/VERDICT: FAIL/);
  });

  it("PASSES a fully healthy server", async () => {
    const d = deps([
      HOST_OK,
      [/&& echo yes \|\| echo no/, { stdout: "yes" }],
      [/com\.docker\.compose\.project=.* -q/, { stdout: "8 8" }],
      [/rev-parse --short HEAD/, { stdout: "abc1234 main 0" }],
      [/ps --format/, { stdout: "api running\npostgres running\nclickhouse running" }],
      [/for i in \$\(seq/, { code: 0, stdout: "healthy after ~5s (HTTP 200)" }],
      [/pg_isready/, { stdout: "localhost:5432 - accepting connections" }],
      [/8123\/ping/, { stdout: "Ok." }],
      [/is-active adpix-watchdog/, { stdout: 'active\n{"status":"ok"}' }],
    ]);
    const out = await tool("stack_doctor").handler(d, {});
    expect(out).toMatch(/✓ Postgres/); expect(out).toMatch(/✓ ClickHouse/);
    expect(out).toMatch(/✓ Containers: 8\/8 up/);
    expect(out).toMatch(/VERDICT: (healthy|PASS)/);
  });
});
