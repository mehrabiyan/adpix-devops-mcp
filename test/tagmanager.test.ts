import { describe, expect, it } from "vitest";
import type { Deps } from "../src/deps.js";
import type { ServerConfig } from "../src/registry.js";
import type { ExecResult, Session } from "../src/ssh.js";
import { allTools } from "../src/tools/index.js";

const tool = (name: string) => {
  const t = allTools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};

type Resp = [RegExp, Partial<ExecResult> | ((c: string) => Partial<ExecResult>)];
function fakeDeps(responses: Resp[]) {
  const calls: string[] = [];
  const server: ServerConfig = { name: "tm1", host: "10.0.0.3", port: 22, username: "root", adpixDir: "/opt/adpix" };
  const session: Session = {
    server, authMethod: "publickey", close: () => {},
    exec: async (cmd: string) => {
      calls.push(cmd);
      for (const [re, res] of responses) if (re.test(cmd)) return { code: 0, stdout: "", stderr: "", ...(typeof res === "function" ? res(cmd) : res) };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { deps: { resolve: () => server, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) } as Deps, calls };
}

const INSTALLED: Resp = [/test -d .*\.git.* && echo yes/, { stdout: "yes" }];

// ---------------------------------------------------------------- registration
describe("tagmanager + observability registered", () => {
  it("exposes the TM lifecycle + observability + bluegreen tools", () => {
    const names = allTools.map((t) => t.name);
    for (const n of ["tm_install", "tm_status", "tm_health", "tm_logs", "tm_restart", "tm_update", "obs_deploy", "obs_status", "bluegreen_deploy"])
      expect(names).toContain(n);
  });
});

// ---------------------------------------------------------------- tm_install
describe("tm_install", () => {
  it("refuses when Docker is absent", async () => {
    const { deps } = fakeDeps([[/docker compose version/, { stdout: "no" }]]);
    expect(await tool("tm_install").handler(deps, { dir: "/opt/adpix-tagmanager", repoUrl: "x", branch: "main", s3Bucket: "adpix-tags", timeoutSeconds: 1800 })).toContain("Docker");
  });

  it("clones, writes deploy/.env, builds, brings up and health-gates", async () => {
    const { deps, calls } = fakeDeps([
      [/docker compose version/, { stdout: "ok" }],
      [/command -v git/, { code: 0 }],
      [/git clone -b/, { code: 0 }],
      [/deploy\/\.env.* && echo yes/, { stdout: "no" }],
      [/base64 -d/, { code: 0 }],
      [/--env-file deploy\/\.env build/, { code: 0 }],
      [/--env-file deploy\/\.env up -d/, { code: 0 }],
      [/8686\/healthz/, { code: 0, stdout: "healthy after ~5s (api+edge 200)" }],
    ]);
    const out = await tool("tm_install").handler(deps, {
      dir: "/opt/adpix-tagmanager", repoUrl: "https://github.com/mehrabiyan/AdpixTagManager.git", branch: "main",
      databaseUrl: "postgres://x", authIssuer: "https://account.adpix.io", s3AccessKey: "k", s3SecretKey: "s", purgeToken: "p",
      s3Bucket: "adpix-tags", timeoutSeconds: 1800,
    });
    expect(out).toContain("Wrote deploy/.env");
    expect(out).toContain("healthy");
    expect(out).toContain("Done");
    expect(calls.filter((c) => c.includes("base64 -d")).length).toBe(1); // .env written once, never echoed
  });

  it("asks for secrets when .env is missing and none provided", async () => {
    const { deps } = fakeDeps([
      [/docker compose version/, { stdout: "ok" }],
      [/command -v git/, { code: 0 }],
      [/git clone -b/, { code: 0 }],
      [/deploy\/\.env.* && echo yes/, { stdout: "no" }],
    ]);
    const out = await tool("tm_install").handler(deps, { dir: "/opt/adpix-tagmanager", repoUrl: "x", branch: "main", s3Bucket: "adpix-tags", timeoutSeconds: 1800 });
    expect(out).toContain("deploy/.env is missing");
  });
});

// ---------------------------------------------------------------- tm_health
describe("tm_health", () => {
  it("renders HEALTHY when containers run and probes return 200", async () => {
    const { deps } = fakeDeps([
      INSTALLED,
      [/ps -a --format json/, { stdout: '{"Service":"api","State":"running","Health":"healthy"}\n{"Service":"edge","State":"running","Health":""}\n{"Service":"varnish","State":"running","Health":""}' }],
      [/for p in 8686/, { stdout: "8686 200\n8585 200\n8080 200" }],
    ]);
    const out = await tool("tm_health").handler(deps, { dir: "/opt/adpix-tagmanager" });
    expect(out).toContain("HEALTHY");
    expect(out).toContain("api");
  });

  it("flags a down edge probe", async () => {
    const { deps } = fakeDeps([
      INSTALLED,
      [/ps -a --format json/, { stdout: '{"Service":"api","State":"running","Health":"healthy"}\n{"Service":"edge","State":"running","Health":""}' }],
      [/for p in 8686/, { stdout: "8686 200\n8585 000\n8080 200" }],
    ]);
    const out = await tool("tm_health").handler(deps, { dir: "/opt/adpix-tagmanager" });
    expect(out).toMatch(/DEGRADED|DOWN/);
    expect(out).toMatch(/edge.*000/);
  });
});

// ---------------------------------------------------------------- tm_update
describe("tm_update", () => {
  it("rolls back when the new build doesn't come back healthy", async () => {
    let rev = 0;
    const { deps, calls } = fakeDeps([
      INSTALLED,
      [/rev-parse HEAD/, () => ({ stdout: rev++ === 0 ? "aaaaaaaa" : "bbbbbbbb" })],
      [/rev-parse --abbrev-ref HEAD/, { stdout: "main" }],
      [/git fetch origin .* && git checkout/, { code: 0, stdout: "bbbbbbbb" }],
      [/--env-file deploy\/\.env build/, { code: 0 }],
      [/--env-file deploy\/\.env up -d/, { code: 0 }],
      [/8686\/healthz/, { code: 1, stdout: "NOT healthy after 150s (api=000 edge=000)" }], // gate fails → rollback
      [/git checkout 'aaaaaaaa'|git checkout aaaaaaaa/, { code: 0 }],
    ]);
    const out = await tool("tm_update").handler(deps, { dir: "/opt/adpix-tagmanager", rollbackOnFailure: true, force: false, timeoutSeconds: 1800 });
    expect(out).toContain("ROLLBACK");
    expect(calls.some((c) => /git checkout 'aaaaaaaa'/.test(c))).toBe(true);
  });
});

// ---------------------------------------------------------------- observability
describe("obs_deploy / obs_status", () => {
  it("obs_deploy brings up the extras profile", async () => {
    const { deps, calls } = fakeDeps([INSTALLED, [/profile extras up -d/, { code: 0, stdout: "Started" }]]);
    const out = await tool("obs_deploy").handler(deps, {});
    expect(out).toContain("Observability stack up");
    expect(calls.some((c) => /--profile extras up -d prometheus alertmanager grafana/.test(c))).toBe(true);
  });

  it("obs_status is HEALTHY when all up and targets healthy", async () => {
    const { deps } = fakeDeps([
      INSTALLED,
      [/ps --format json prometheus/, { stdout: '{"Service":"prometheus","State":"running"}\n{"Service":"alertmanager","State":"running"}\n{"Service":"grafana","State":"running"}' }],
      [/9090\/-\/ready/, { stdout: "Prometheus Server is Ready." }],
      [/api\/v1\/targets/, { stdout: '{"data":{"activeTargets":[{"health":"up"},{"health":"up"}]}}' }],
      [/9093\/-\/ready/, { stdout: "" }],
      [/3000\/api\/health/, { stdout: '{"database": "ok"}' }],
    ]);
    const out = await tool("obs_status").handler(deps, {});
    expect(out).toContain("HEALTHY");
    expect(out).toMatch(/2 up \/ 0 down/);
  });

  it("obs_status flags a down scrape target", async () => {
    const { deps } = fakeDeps([
      INSTALLED,
      [/ps --format json prometheus/, { stdout: '{"Service":"prometheus","State":"running"}\n{"Service":"alertmanager","State":"running"}\n{"Service":"grafana","State":"running"}' }],
      [/9090\/-\/ready/, { stdout: "Prometheus Server is Ready." }],
      [/api\/v1\/targets/, { stdout: '{"data":{"activeTargets":[{"health":"up"},{"health":"down"}]}}' }],
      [/9093\/-\/ready/, { stdout: "" }],
      [/3000\/api\/health/, { stdout: '{"database": "ok"}' }],
    ]);
    const out = await tool("obs_status").handler(deps, {});
    expect(out).toContain("NEEDS ATTENTION");
    expect(out).toMatch(/1 Prometheus scrape target.*DOWN/);
  });
});
