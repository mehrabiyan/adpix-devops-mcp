import { describe, expect, it } from "vitest";
import { allTools } from "../src/tools/index.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";

const SRV: ServerConfig = { name: "prod", host: "10.0.0.1", port: 22, username: "root", adpixDir: "/opt/adpix" };
const tool = (n: string) => { const t = allTools.find((t) => t.name === n); if (!t) throw new Error(n); return t; };

function deps(responses: [RegExp, Partial<ExecResult>][]) {
  const calls: string[] = [];
  const session: Session = {
    server: SRV, authMethod: "publickey", close: () => {},
    exec: async (cmd: string): Promise<ExecResult> => { calls.push(cmd); for (const [re, r] of responses) if (re.test(cmd)) return { code: 0, stdout: "", stderr: "", ...r }; return { code: 0, stdout: "", stderr: "" }; },
  };
  return { deps: { resolve: () => SRV, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) } as Deps, calls };
}
const UP: [RegExp, Partial<ExecResult>][] = [[/&& echo yes \|\| echo no/, { stdout: "yes" }], [/com\.docker\.compose\.project=.* -q/, { stdout: "8 8" }]];

describe("scale_ingest", () => {
  it("refuses without confirm", async () => {
    const { deps: d } = deps(UP);
    expect(await tool("scale_ingest").handler(d, { replicas: 3, confirm: false })).toMatch(/REFUSED/);
  });
  it("refuses to scale >1 without a shared REDIS_URL", async () => {
    const { deps: d } = deps([...UP, [/grep \^REDIS_URL=/, { stdout: "" }]]);
    const out = await tool("scale_ingest").handler(d, { replicas: 3, confirm: true });
    expect(out).toMatch(/REDIS_URL is unset/);
    expect(out).toMatch(/independently/);
  });
  it("scales when confirmed + Redis is shared", async () => {
    const { deps: d, calls } = deps([...UP, [/grep \^REDIS_URL=/, { stdout: "redis://redis:6379" }], [/up -d --no-recreate --scale ingest=3/, { code: 0, stdout: "ok" }], [/service=ingest -q/, { stdout: "3" }]]);
    const out = await tool("scale_ingest").handler(d, { replicas: 3, confirm: true });
    expect(out).toMatch(/Scaled ingest to 3/);
    expect(calls.some((c) => /--scale ingest=3/.test(c))).toBe(true);
  });
});

describe("launch_readiness", () => {
  it("NO-GO when not deployed (stops early with the deploy blocker)", async () => {
    const { deps: d } = deps([[/nproc/, { stdout: "4 8000 40000" }], [/&& echo yes \|\| echo no/, { stdout: "no" }]]);
    const out = await tool("launch_readiness").handler(d, { sites: 200000 });
    expect(out).toMatch(/Recommended topology/);
    expect(out).toMatch(/✗ Deployment/);
    expect(out).toMatch(/VERDICT: NO-GO/);
  });

  it("NO-GO with blockers on a deployed-but-unhardened 200k target", async () => {
    const { deps: d } = deps([
      [/nproc/, { stdout: "8 20000 300000" }],
      ...UP,
      [/service=ingest -q/, { stdout: "1" }],
      [/grep \^APP_ENV=/, { stdout: "" }],          // FAIL
      [/grep \^CH_REPLICATED=/, { stdout: "0" }],    // WARN at scale
      [/grep \^REDIS_URL=/, { stdout: "" }],         // FAIL at scale
      [/grep \^POSTGRES_PASSWORD=/, { stdout: "password" }], // weak
      [/grep \^CLICKHOUSE_PASSWORD=/, { stdout: "x" }],
      [/grep \^SESSION_SECRET=/, { stdout: "dev-insecure-change-me" }],
      [/grep \^ADMIN_PASSWORD=/, { stdout: "admin" }],
      [/grep \^SITE_ADDRESS=/, { stdout: "" }],
    ]);
    const out = await tool("launch_readiness").handler(d, { sites: 200000 });
    expect(out).toMatch(/VERDICT: NO-GO/);
    expect(out).toMatch(/✗ APP_ENV/);
    expect(out).toMatch(/✗ Shared Redis/);
    expect(out).toMatch(/✗ Secrets/);
    expect(out).toMatch(/BLOCKERS/);
  });
});
