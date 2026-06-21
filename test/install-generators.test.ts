import { describe, expect, it } from "vitest";
import { buildDnsPlan, renderBindSnippet, digVerifyCommands, renderDnsPlan } from "../src/install/dns.js";
import { claudeCodeCmd, claudeDesktopJson, sshTunnelVariant, renderConnect } from "../src/install/connect.js";
import { verifyInstall } from "../src/install/verify.js";
import { DEFAULT_CLUSTER_HOSTS } from "../src/install/answers.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult } from "../src/ssh.js";

// ---------------------------------------------------------------- DNS plan
describe("DNS plan generator", () => {
  const recs = buildDnsPlan({ hosts: DEFAULT_CLUSTER_HOSTS, vip: "203.0.113.9", cdnOrigin: "cdn-origin.example", mcpDomain: "mcp.example.com", mcpHostIp: "203.0.113.7" });

  it("routes control-plane to the VIP (un-proxied) and data-plane to the CDN (proxied)", () => {
    const byName = Object.fromEntries(recs.map((r) => [r.name, r]));
    expect(byName["analytics.adpix.io"]).toMatchObject({ value: "203.0.113.9", proxied: false, zone: "adpix.io" });
    expect(byName["cdn.adpix.net"]).toMatchObject({ value: "cdn-origin.example", proxied: true, zone: "adpix.net" });
    expect(byName["mcp.example.com"]).toMatchObject({ value: "203.0.113.7", proxied: false });
  });

  it("renders a BIND snippet grouped by zone + dig verifiers", () => {
    const bind = renderBindSnippet(recs);
    expect(bind).toMatch(/\$ORIGIN adpix\.io\./);
    expect(bind).toMatch(/\$ORIGIN adpix\.net\./);
    expect(digVerifyCommands(recs)[0].cmd).toMatch(/^dig \+short /);
    expect(renderDnsPlan({ hosts: ["analytics.adpix.io"], vip: "1.2.3.4" })).toContain("DNS plan");
  });
});

// ---------------------------------------------------------------- connect
describe("client-connect generator", () => {
  const base = { name: "adpix-devops", port: 8930 };
  it("masks the token by default, reveals on demand", () => {
    const i = { ...base, url: "https://mcp.example.com/mcp", token: "abcdef1234567890", domain: "mcp.example.com" };
    expect(claudeCodeCmd(i)).toContain("abcd…7890");
    expect(claudeCodeCmd(i)).not.toContain("abcdef1234567890");
    expect(claudeCodeCmd(i, { reveal: true })).toContain("abcdef1234567890");
    expect(claudeDesktopJson(i)).toMatch(/"transport": "http"/);
  });
  it("offers an SSH tunnel only in HTTP (no domain) mode", () => {
    expect(sshTunnelVariant({ ...base, url: "http://10.0.0.1:8930/mcp", token: "t" }, { serverHost: "10.0.0.1" })).toMatch(/ssh -N -L 8930:127\.0\.0\.1:8930/);
    expect(sshTunnelVariant({ ...base, url: "https://m/mcp", token: "t", domain: "m" })).toBeNull();
    expect(renderConnect({ ...base, url: "http://10.0.0.1:8930/mcp", token: "t" }, ["claude-code", "generic"], { serverHost: "10.0.0.1" })).toMatch(/SSH tunnel/);
  });
});

// ---------------------------------------------------------------- verify
type Resp = [RegExp, Partial<ExecResult>];
function vDeps(local: Resp[], sshOk = true): Deps {
  return {
    resolve: (n) => ({ name: n!, host: "10.0.0.2", port: 22, username: "root", adpixDir: "/opt/adpix" } as never),
    connect: async () => {
      if (!sshOk) throw new Error("SSH host-key verification FAILED");
      return { server: {} as never, authMethod: "publickey", close: () => {}, exec: async () => ({ code: 0, stdout: "Linux", stderr: "" }) };
    },
    local: async (cmd) => { for (const [re, r] of local) if (re.test(cmd)) return { code: 0, stdout: "", stderr: "", ...r }; return { code: 0, stdout: "", stderr: "" }; },
  };
}

describe("end-to-end verify", () => {
  it("is READY when healthz, the MCP handshake, DNS, SSH and TLS all pass", async () => {
    const deps = vDeps([
      [/\/healthz/, { stdout: "ok" }],
      [/initialize/, { stdout: '{"result":{"serverInfo":{"name":"adpix-devops-mcp"}}}' }],
      [/dig \+short/, { stdout: "203.0.113.9" }],
      [/openssl s_client/, { stdout: "subject=CN = mcp.example.com" }],
    ]);
    const out = await verifyInstall(deps, { url: "https://mcp.example.com/mcp", token: "t", mcpDomain: "mcp.example.com", hosts: ["analytics.adpix.io"], fleet: [{ name: "prod" }] });
    expect(out.verdict).toBe("READY");
    expect(out.checks.every((c) => c.ok)).toBe(true);
  });

  it("FAILS when the token is rejected, DNS is missing and SSH is unreachable", async () => {
    const deps = vDeps([
      [/\/healthz/, { stdout: "ok" }],
      [/initialize/, { stdout: '{"error":{"code":-32001,"message":"Unauthorized"}}' }],
      [/dig \+short/, { stdout: "" }],
    ], false);
    const out = await verifyInstall(deps, { url: "https://mcp.example.com/mcp", token: "wrong", hosts: ["analytics.adpix.io"], fleet: [{ name: "prod" }] });
    expect(out.verdict).toMatch(/FAILED/);
    expect(out.checks.find((c) => c.name.includes("handshake"))!.ok).toBe(false);
    expect(out.checks.find((c) => c.name.startsWith("dns"))!.ok).toBe(false);
    expect(out.checks.find((c) => c.name.startsWith("ssh"))!.ok).toBe(false);
  });
});
