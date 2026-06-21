import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyHost,
  parseHeaders,
  certDaysFromEnddate,
  DEFAULT_LAUNCH_HOSTS,
} from "../src/launch/hosts.js";
import { saveRegistry, loadRegistry } from "../src/registry.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";
import { allTools } from "../src/tools/index.js";

const tool = (name: string) => {
  const t = allTools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};

type Resp = [RegExp, Partial<ExecResult> | ((c: string) => Partial<ExecResult>)];
const pick = (rs: Resp[], cmd: string): ExecResult => {
  for (const [re, res] of rs) if (re.test(cmd)) return { code: 0, stdout: "", stderr: "", ...(typeof res === "function" ? res(cmd) : res) };
  return { code: 0, stdout: "", stderr: "" };
};
function fakeDeps(local: Resp[] = [], exec: Resp[] = []) {
  const calls: string[] = [];
  const server: ServerConfig = { name: "prod", host: "10.0.0.2", port: 22, username: "root", adpixDir: "/opt/adpix" };
  const session: Session = { server, authMethod: "publickey", close: () => {}, exec: async (c: string) => { calls.push(c); return pick(exec, c); } };
  return {
    deps: { resolve: () => server, connect: async () => session, local: async (c: string) => { calls.push(c); return pick(local, c); } } as Deps,
    calls,
  };
}

// temp registry home for the tools that read/write the registry
let tmp: string;
const SAVED: Record<string, string | undefined> = {};
beforeEach(() => {
  SAVED.ADPIX_DEVOPS_HOME = process.env.ADPIX_DEVOPS_HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-launch-test-"));
  process.env.ADPIX_DEVOPS_HOME = tmp;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (SAVED.ADPIX_DEVOPS_HOME === undefined) delete process.env.ADPIX_DEVOPS_HOME;
  else process.env.ADPIX_DEVOPS_HOME = SAVED.ADPIX_DEVOPS_HOME;
});

// ---------------------------------------------------------------- pure helpers
describe("launch host helpers", () => {
  it("classifies the Set-Cookie carve-out correctly", () => {
    expect(classifyHost("cdn.adpix.net").setCookieAllowed).toBe(false);
    expect(classifyHost("collect.adpix.net").setCookieAllowed).toBe(false);
    expect(classifyHost("config.adpix.net").setCookieAllowed).toBe(false);
    expect(classifyHost("gateway.adpix.net").setCookieAllowed).toBe(true); // ADR-0033 exception
    expect(classifyHost("account.adpix.io").plane).toBe("control");
    expect(classifyHost("collect.adpix.net").cache).toBe("no-store");
    expect(classifyHost("api.adpix.io").product).toBe("shared-api");
  });

  it("parses curl -D - headers, merging Set-Cookie across redirect blocks", () => {
    const raw = "HTTP/2 301\r\nlocation: /x\r\nset-cookie: a=1\r\n\r\nHTTP/2 200\r\ncache-control: max-age=60\r\n\r\n";
    const p = parseHeaders(raw);
    expect(p.status).toBe(200); // last status wins
    expect(p.headers["set-cookie"]).toEqual(["a=1"]); // caught on the redirect hop
    expect(p.headers["cache-control"]).toEqual(["max-age=60"]);
  });

  it("computes cert days from an openssl enddate", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(certDaysFromEnddate("notAfter=Jan 31 00:00:00 2026 GMT", now)).toBe(30);
    expect(certDaysFromEnddate("garbage", now)).toBeNull();
  });

  it("ships the 8 default hosts", () => {
    expect(DEFAULT_LAUNCH_HOSTS).toHaveLength(8);
    expect(DEFAULT_LAUNCH_HOSTS).toContain("gateway.adpix.net");
  });
});

// ---------------------------------------------------------------- launch_gate
describe("launch_gate", () => {
  it("starts BLOCKED and lists the P1 blockers", async () => {
    const { deps } = fakeDeps();
    const out = await tool("launch_gate").handler(deps, { mode: "status", confirm: false });
    expect(out).toContain("BLOCKED");
    expect(out).toMatch(/consent fails OPEN/);
  });

  it("refuses ack without confirm, then clears with a reference", async () => {
    const { deps } = fakeDeps();
    expect(await tool("launch_gate").handler(deps, { mode: "ack", confirm: false })).toContain("REFUSED");
    const ok = await tool("launch_gate").handler(deps, { mode: "ack", confirm: true, reference: "audit-2026-06-25 abc123" });
    expect(ok).toContain("CLEARED");
    expect(loadRegistry().launchGate?.resolved).toBe(true);
    expect(await tool("launch_gate").handler(deps, { mode: "status", confirm: false })).toContain("CLEARED");
  });
});

// ---------------------------------------------------------------- secrets_preflight
describe("secrets_preflight", () => {
  const envFile: Resp = [/test -f .*\.env.* && echo yes/, { stdout: "yes" }];
  const present = (v: string): Resp[] => [
    [/\^SESSION_SECRET=/, { stdout: v }],
    [/\^S2S_ENC_KEY=/, { stdout: v }],
    [/\^ADMIN_PASSWORD=/, { stdout: v }],
    [/\^SERVER_API_KEY=/, { stdout: v }],
    [/\^CLICKHOUSE_PASSWORD=/, { stdout: v }],
    [/\^OIDC_ISSUER=/, { stdout: "https://account.adpix.io" }],
    [/\^SITE_ADDRESS=/, { stdout: "account.adpix.io, analytics.adpix.io" }],
  ];

  it("passes when every analytics secret is set and non-default", async () => {
    const { deps } = fakeDeps([], [envFile, ...present("strong-random-value")]);
    const out = await tool("secrets_preflight").handler(deps, { stack: "analytics" });
    expect(out).toContain("ALL PRESENT");
    expect(out).not.toMatch(/FAIL/);
  });

  it("flags a demo-default and an empty required secret", async () => {
    const { deps } = fakeDeps([], [
      envFile,
      [/\^SESSION_SECRET=/, { stdout: "dev-insecure-change-me" }], // demo default
      [/\^S2S_ENC_KEY=/, { stdout: "strong" }],
      [/\^ADMIN_PASSWORD=/, { stdout: "strong" }],
      [/\^SERVER_API_KEY=/, { stdout: "strong" }],
      [/\^CLICKHOUSE_PASSWORD=/, { stdout: "" }], // empty → fail
      [/\^OIDC_ISSUER=/, { stdout: "https://account.adpix.io" }],
      [/\^SITE_ADDRESS=/, { stdout: "x" }],
    ]);
    const out = await tool("secrets_preflight").handler(deps, { stack: "analytics" });
    expect(out).toContain("BLOCKER");
    expect(out).toMatch(/SESSION_SECRET.*demo-default/);
    expect(out).toMatch(/CLICKHOUSE_PASSWORD.*empty/);
  });
});

// ---------------------------------------------------------------- oidc_health
describe("oidc_health", () => {
  const disc = JSON.stringify({
    issuer: "https://account.adpix.io",
    authorization_endpoint: "https://account.adpix.io/authorize",
    token_endpoint: "https://account.adpix.io/token",
    jwks_uri: "https://account.adpix.io/jwks",
  });
  it("reports HEALTHY when discovery, issuer, JWKS and TLS are good", async () => {
    const { deps } = fakeDeps([
      [/openid-configuration/, { stdout: disc }],
      [/account\.adpix\.io\/jwks/, { stdout: JSON.stringify({ keys: [{ kid: "a" }, { kid: "b" }] }) }],
      [/s_client/, { stdout: "notAfter=Dec 31 23:59:59 2027 GMT" }],
    ]);
    const out = await tool("oidc_health").handler(deps, {});
    expect(out).toContain("HEALTHY");
    expect(out).toContain("JWKS keys: 2");
  });

  it("flags a mismatched issuer (split-horizon misconfig)", async () => {
    const { deps } = fakeDeps([
      [/openid-configuration/, { stdout: JSON.stringify({ issuer: "https://internal:9700", authorization_endpoint: "a", token_endpoint: "t", jwks_uri: "https://account.adpix.io/jwks" }) }],
      [/account\.adpix\.io\/jwks/, { stdout: JSON.stringify({ keys: [{ kid: "a" }] }) }],
      [/s_client/, { stdout: "notAfter=Dec 31 23:59:59 2027 GMT" }],
    ]);
    const out = await tool("oidc_health").handler(deps, {});
    expect(out).toContain("DEGRADED");
    expect(out).toMatch(/advertised issuer/);
  });
});

// ---------------------------------------------------------------- edge_validate
describe("edge_validate", () => {
  it("passes a clean data-plane host and flags a Set-Cookie leak", async () => {
    const { deps } = fakeDeps([
      [/https:\/\/cdn\.adpix\.net\//, { stdout: "HTTP/2 200\r\ncache-control: max-age=31536000\r\nset-cookie: track=1\r\n\r\n" }],
      [/https:\/\/gateway\.adpix\.net\//, { stdout: "HTTP/2 200\r\nset-cookie: __sov=1\r\n\r\n" }],
      [/s_client/, { stdout: "notAfter=Dec 31 23:59:59 2027 GMT" }],
    ]);
    const out = await tool("edge_validate").handler(deps, { hosts: ["cdn.adpix.net", "gateway.adpix.net"], expiryWarnDays: 14 });
    expect(out).toContain("NEEDS ATTENTION");
    expect(out).toMatch(/cdn\.adpix\.net: Set-Cookie/); // cdn leaks → fail
    expect(out).not.toMatch(/gateway\.adpix\.net: Set-Cookie/); // gateway exempt
  });

  it("warns on a near-expiry cert", async () => {
    const { deps } = fakeDeps([
      [/https:\/\/account\.adpix\.io\//, { stdout: "HTTP/2 200\r\n\r\n" }],
      [/s_client/, { stdout: "notAfter=Jan 05 00:00:00 2026 GMT" }],
    ]);
    const out = await tool("edge_validate").handler(deps, { hosts: ["account.adpix.io"], expiryWarnDays: 9999 });
    expect(out).toMatch(/expires in -?\d+d|EXPIRED/);
  });
});

// ---------------------------------------------------------------- launch_smoke
describe("launch_smoke", () => {
  it("passes the unauthenticated subset and lists the manual checks", async () => {
    const { deps } = fakeDeps([
      [/openid-configuration/, { stdout: "200" }],
      [/https:\/\/analytics\.adpix\.io\//, { stdout: "HTTP/2 200\r\n\r\n" }],
      [/https:\/\/tagmanager\.adpix\.io\//, { stdout: "HTTP/2 200\r\n\r\n" }],
      [/https:\/\/api\.adpix\.io\/tm\/accounts/, { stdout: "HTTP/2 401\r\n\r\n" }],
      [/https:\/\/cdn\.adpix\.net\/t\.js/, { stdout: "HTTP/2 200\r\n\r\n" }],
      [/https:\/\/collect\.adpix\.net\//, { stdout: "HTTP/2 204\r\n\r\n" }],
      [/https:\/\/config\.adpix\.net\//, { stdout: "HTTP/2 200\r\n\r\n" }],
    ]);
    const out = await tool("launch_smoke").handler(deps, {});
    expect(out).toContain("PASS");
    expect(out).toMatch(/auth enforced/);
    expect(out).toContain("Single Logout");
  });

  it("flags unauthenticated access to the TM api as a security failure", async () => {
    const { deps } = fakeDeps([
      [/openid-configuration/, { stdout: "200" }],
      [/https:\/\/api\.adpix\.io\/tm\/accounts/, { stdout: "HTTP/2 200\r\n\r\n" }],
    ]);
    const out = await tool("launch_smoke").handler(deps, {});
    expect(out).toContain("FAIL (security)");
    expect(out).toMatch(/UNAUTHENTICATED ACCESS/);
  });
});

// ---------------------------------------------------------------- predeploy_gate
describe("predeploy_gate", () => {
  it("is GO when checks pass and Gate 0 is cleared", async () => {
    saveRegistry({ version: 1, servers: {}, launchGate: { resolved: true, reference: "x", at: "t" } });
    const { deps } = fakeDeps([
      [/run typecheck/, { code: 0 }],
      [/run test/, { code: 0 }],
    ]);
    const out = await tool("predeploy_gate").handler(deps, { stack: "tagmanager", repoPath: "/repo" });
    expect(out).toContain("GO");
    expect(out).toMatch(/\[PASS\] typecheck/);
  });

  it("is NO-GO when typecheck fails", async () => {
    saveRegistry({ version: 1, servers: {}, launchGate: { resolved: true } });
    const { deps } = fakeDeps([
      [/run typecheck/, { code: 1, stdout: "error TS2322" }],
      [/run test/, { code: 0 }],
    ]);
    const out = await tool("predeploy_gate").handler(deps, { stack: "tagmanager", repoPath: "/repo" });
    expect(out).toContain("NO-GO");
    expect(out).toMatch(/\[FAIL\] typecheck/);
  });

  it("refuses when given no target", async () => {
    const { deps } = fakeDeps();
    expect(await tool("predeploy_gate").handler(deps, { stack: "tagmanager" })).toContain("needs either repoPath");
  });
});
