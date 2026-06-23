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
function pick(responses: Resp[], cmd: string): ExecResult {
  for (const [re, res] of responses) if (re.test(cmd)) return { code: 0, stdout: "", stderr: "", ...(typeof res === "function" ? res(cmd) : res) };
  return { code: 0, stdout: "", stderr: "" };
}
// `responses` answer the prod SESSION; `localResponses` answer the MCP (deps.local) — the shared
// deploy key is generated + authorized there, then distributed to the server.
function fakeDeps(responses: Resp[], localResponses: Resp[] = []) {
  const calls: string[] = []; const localCalls: string[] = [];
  const server: ServerConfig = { name: "tm1", host: "10.0.0.3", port: 22, username: "root", adpixDir: "/opt/adpix" };
  const session: Session = {
    server, authMethod: "publickey", close: () => {},
    exec: async (cmd: string) => { calls.push(cmd); return pick(responses, cmd); },
  };
  return { deps: { resolve: () => server, connect: async () => session, local: async (cmd: string) => { localCalls.push(cmd); return pick(localResponses, cmd); } } as Deps, calls, localCalls };
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

  it("private repo over HTTPS: auto-switches to the shared MCP key and prints it (unauthorized)", async () => {
    const { deps } = fakeDeps(
      [
        [/docker compose version/, { stdout: "ok" }],
        [/command -v git/, { code: 0 }],
        [/git clone -b 'main' 'https:/, { code: 128, stderr: "fatal: could not read Username for 'https://github.com': No such device or address" }],
      ],
      [[/adpix_tm_deploy_ed25519\.pub/, { stdout: "ssh-ed25519 AAAAKEY mcp" }], [/git ls-remote/, { stdout: "NO" }]]
    );
    const out = await tool("tm_install").handler(deps, { dir: "/opt/adpix-tagmanager", repoUrl: "https://github.com/mehrabiyan/AdpixTagManager.git", branch: "main", s3Bucket: "adpix-tags", timeoutSeconds: 1800 });
    expect(out).toMatch(/reused for every server/i);
    expect(out).toContain("ssh-ed25519 AAAAKEY");
    expect(out).toMatch(/Nothing installed yet/);
  });

  it("private repo: distributes the shared key + clones over SSH once authorized", async () => {
    const { deps, calls } = fakeDeps(
      [
        [/docker compose version/, { stdout: "ok" }],
        [/command -v git/, { code: 0 }],
        [/git clone -b 'main' 'https:/, { code: 128, stderr: "could not read Username for 'https://github.com'" }],
        [/git clone -b 'main' 'git@github/, { code: 0 }], // SSH clone succeeds
        [/deploy\/\.env.* && echo yes/, { stdout: "no" }],
        [/base64 -d/, { code: 0 }],
        [/--env-file deploy\/\.env build/, { code: 0 }],
        [/--env-file deploy\/\.env up -d/, { code: 0 }],
        [/8686\/healthz/, { code: 0, stdout: "healthy after ~5s (api+edge 200)" }],
      ],
      [[/adpix_tm_deploy_ed25519\.pub/, { stdout: "ssh-ed25519 KEY mcp" }], [/git ls-remote/, { stdout: "OK" }], [/base64 </, { stdout: "QkFTRTY0" }]]
    );
    const out = await tool("tm_install").handler(deps, { dir: "/opt/adpix-tagmanager", repoUrl: "https://github.com/mehrabiyan/AdpixTagManager.git", branch: "main", databaseUrl: "postgres://x", authIssuer: "https://account.adpix.io", s3AccessKey: "k", s3SecretKey: "s", purgeToken: "p", s3Bucket: "adpix-tags", timeoutSeconds: 1800 });
    expect(out).toContain("Done");
    expect(calls.some((c) => /base64 -d > '\/root\/\.ssh\/adpix_tm_deploy_ed25519'/.test(c))).toBe(true); // key pushed to the server
    expect(calls.some((c) => /git clone -b 'main' 'git@github\.com:mehrabiyan\/AdpixTagManager\.git'/.test(c))).toBe(true);
  });

  it("dbContainer: provisions a Postgres container + auto DATABASE_URL (no external DB required)", async () => {
    const { deps, calls } = fakeDeps([
      [/docker compose version/, { stdout: "ok" }],
      [/command -v git/, { code: 0 }],
      [/git clone/, { code: 0 }],
      [/grep -h '\^TM_DB_PASSWORD='/, { stdout: "" }],     // no existing password
      [/openssl rand/, { stdout: "deadbeefcafe" }],         // mint one
      [/deploy\/\.env.* && echo yes/, { stdout: "no" }],
      [/base64 -d/, { code: 0 }],                            // db.yml + .env writes
      [/docker-compose\.db\.yml --env-file deploy\/\.env build/, { code: 0 }],
      [/up -d/, { code: 0 }],
      [/8686\/healthz/, { code: 0, stdout: "healthy after ~5s (api+edge 200)" }],
    ]);
    const out = await tool("tm_install").handler(deps, {
      dir: "/opt/adpix-tagmanager", repoUrl: "https://github.com/mehrabiyan/AdpixTagManager.git", branch: "main",
      dbContainer: true, authIssuer: "https://account.adpix.io", s3AccessKey: "k", s3SecretKey: "s", purgeToken: "p",
      s3Bucket: "adpix-tags", timeoutSeconds: 1800,
    });
    expect(out).toContain("Provisioning a Postgres container");
    expect(out).toContain("Done");
    expect(calls.some((c) => /docker-compose\.db\.yml/.test(c))).toBe(true);      // override uploaded
    expect(calls.some((c) => /-f deploy\/docker-compose\.db\.yml --env-file deploy\/\.env build/.test(c))).toBe(true); // build uses it
  });

  it("dbContainer:false still requires databaseUrl", async () => {
    const { deps } = fakeDeps([[/docker compose version/, { stdout: "ok" }], [/command -v git/, { code: 0 }], [/git clone/, { code: 0 }], [/deploy\/\.env.* && echo yes/, { stdout: "no" }]]);
    const out = await tool("tm_install").handler(deps, { dir: "/opt/adpix-tagmanager", repoUrl: "https://github.com/mehrabiyan/AdpixTagManager.git", branch: "main", dbContainer: false, authIssuer: "https://a", s3AccessKey: "k", s3SecretKey: "s", purgeToken: "p", s3Bucket: "adpix-tags", timeoutSeconds: 1800 });
    expect(out).toMatch(/databaseUrl/);
  });

  it("account_install: deploys apps/auth as a self-contained container (PGlite, :9696)", async () => {
    const { deps, calls } = fakeDeps([
      [/docker compose version/, { stdout: "ok" }],
      [/command -v git/, { code: 0 }],
      [/git clone -b/, { code: 0 }],
      [/BOOTSTRAP_ADMIN_PASSWORD=/, { stdout: "" }],
      [/openssl rand/, { stdout: "adminpw" }],
      [/base64 -d/, { code: 0 }],
      [/-p adpix-account .*build/, { code: 0 }],
      [/-p adpix-account .*up -d/, { code: 0 }],
      [/9696\/healthz/, { code: 0, stdout: "healthy after ~5s" }],
    ]);
    const out = await tool("account_install").handler(deps, { dir: "/opt/adpix-tagmanager", repoUrl: "https://github.com/mehrabiyan/AdpixTagManager.git", branch: "main", port: 9696, timeoutSeconds: 2400 });
    expect(out).toContain("embedded PGlite");
    expect(out).toMatch(/Account\/IdP up at http:\/\/10\.0\.0\.3:9696/);
    expect(calls.some((c) => /Dockerfile\.auth/.test(c))).toBe(true);              // wrote the Dockerfile
    expect(calls.some((c) => /-p adpix-account .*up -d/.test(c))).toBe(true);      // own compose project
  });

  it("asks for secrets when .env is missing and none provided", async () => {
    const { deps } = fakeDeps([
      [/docker compose version/, { stdout: "ok" }],
      [/command -v git/, { code: 0 }],
      [/git clone -b/, { code: 0 }],
      [/deploy\/\.env.* && echo yes/, { stdout: "no" }],
    ]);
    const out = await tool("tm_install").handler(deps, { dir: "/opt/adpix-tagmanager", repoUrl: "x", branch: "main", s3Bucket: "adpix-tags", timeoutSeconds: 1800 });
    expect(out).toMatch(/action needed/); expect(out).toMatch(/authIssuer/);
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

// ---------------------------------------------------------------- pop_add
describe("pop_add", () => {
  it("deploys the PoP, verifies the redis replica link, and prints DNS steps", async () => {
    const { deps, calls } = fakeDeps([
      [/docker compose version/, { stdout: "ok" }],
      [/command -v git/, { code: 0 }],
      [/git clone -b/, { code: 0 }],
      [/base64 -d/, { code: 0 }],
      [/up -d redis edge varnish/, { code: 0, stdout: "Started" }],
      [/redis-cli info replication/, { stdout: "role:slave\nmaster_link_status:up\nmaster_host:10.0.0.2\n" }],
      [/8585\/healthz/, { code: 0, stdout: "healthy after ~5s (edge=200 varnish=200)" }],
    ]);
    const out = await tool("pop_add").handler(deps, {
      dir: "/opt/adpix-tagmanager", coreRedisHost: "10.0.0.2", objectStore: "http://10.0.0.2:9000",
      s3AccessKey: "k", s3SecretKey: "s", purgeToken: "p", s3Bucket: "adpix-tags",
      repoUrl: "https://github.com/mehrabiyan/AdpixTagManager.git", branch: "main", timeoutSeconds: 1800,
    });
    expect(out).toContain("PoP config");
    expect(out).toMatch(/replicating the core/);
    expect(out).toContain("DNS / CDN");
    expect(calls.filter((c) => c.includes("base64 -d")).length).toBe(2); // .env + pop override
  });

  it("flags a broken redis replication link", async () => {
    const { deps } = fakeDeps([
      [/docker compose version/, { stdout: "ok" }],
      [/command -v git/, { code: 0 }],
      [/git clone -b/, { code: 0 }],
      [/base64 -d/, { code: 0 }],
      [/up -d redis edge varnish/, { code: 0 }],
      [/redis-cli info replication/, { stdout: "role:slave\nmaster_link_status:down\n" }],
      [/8585\/healthz/, { code: 1, stdout: "NOT healthy" }],
    ]);
    const out = await tool("pop_add").handler(deps, {
      dir: "/opt/adpix-tagmanager", coreRedisHost: "10.0.0.2", objectStore: "http://x:9000",
      s3AccessKey: "k", s3SecretKey: "s", purgeToken: "p", s3Bucket: "adpix-tags",
      repoUrl: "x", branch: "main", timeoutSeconds: 1800,
    });
    expect(out).toMatch(/NOT linked/);
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
