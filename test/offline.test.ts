import { describe, expect, it } from "vitest";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";
import { allTools } from "../src/tools/index.js";

const tool = (n: string) => { const t = allTools.find((t) => t.name === n); if (!t) throw new Error(n); return t; };
const SRV: ServerConfig = { name: "prod", host: "10.0.0.1", port: 22, username: "root", adpixDir: "/opt/adpix" };
type Resp = [RegExp, Partial<ExecResult> | ((c: string) => Partial<ExecResult>)];
const pick = (rs: Resp[], cmd: string): ExecResult => { for (const [re, r] of rs) if (re.test(cmd)) return { code: 0, stdout: "", stderr: "", ...(typeof r === "function" ? r(cmd) : r) }; return { code: 0, stdout: "", stderr: "" }; };

// offline_bundle runs on the MCP (deps.local); offline_install runs on the target (session, incl. putFile)
function bundleDeps(local: Resp[]) {
  const localCalls: string[] = [];
  const deps: Deps = { resolve: () => SRV, connect: async () => ({ server: SRV, authMethod: "publickey", close: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }) }), local: async (cmd) => { localCalls.push(cmd); return pick(local, cmd); } };
  return { deps, localCalls };
}
function targetDeps(responses: Resp[]) {
  const calls: string[] = []; const puts: string[] = [];
  const session: Session = { server: SRV, authMethod: "publickey", close: () => {}, exec: async (cmd) => { calls.push(cmd); return pick(responses, cmd); }, putFile: async (l, r) => { puts.push(`${l}=>${r}`); } };
  const deps: Deps = { resolve: () => SRV, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) };
  return { deps, calls, puts };
}

describe("offline_bundle (MCP-side prepare)", () => {
  it("clones + builds + docker-saves images + packs a tarball", async () => {
    const { deps, localCalls } = bundleDeps([
      [/command -v docker/, { stdout: "yes" }],
      [/git clone/, { code: 0, stdout: "Cloning..." }],
      [/docker compose .*build/, { code: 0 }],
      [/docker save/, { code: 0, stdout: "images: adpix-tm-api\n12M\t/tmp/adpix-offline-tagmanager/images.tar.gz" }],
      [/tar czf/, { code: 0, stdout: "48M" }],
    ]);
    const out = await tool("offline_bundle").handler(deps, { app: "tagmanager", branch: "main", buildImages: true, platform: "linux/amd64", outDir: "/tmp", timeoutSeconds: 3600 });
    expect(localCalls.some((c) => /git clone --depth 1/.test(c))).toBe(true);
    expect(localCalls.some((c) => /docker compose .*-f deploy\/docker-compose\.yml.*build/.test(c))).toBe(true);
    expect(localCalls.some((c) => /docker save/.test(c))).toBe(true);
    expect(localCalls.some((c) => /tar czf .*adpix-offline-tagmanager\.tar\.gz/.test(c))).toBe(true);
    expect(out).toMatch(/offline_install server=<target> app=tagmanager/);
  });

  it("refuses to build images without Docker on the MCP", async () => {
    const { deps } = bundleDeps([[/command -v docker/, { stdout: "no" }]]);
    expect(await tool("offline_bundle").handler(deps, { app: "analytics", branch: "main", buildImages: true, platform: "linux/amd64", outDir: "/tmp", timeoutSeconds: 3600 })).toMatch(/Docker isn't available on the MCP/);
  });
});

describe("offline_install (target-side, no internet)", () => {
  it("streams the bundle, loads images, brings up with --no-build, migrates", async () => {
    const { deps, calls, puts } = targetDeps([
      [/command -v docker .*compose version/, { stdout: "ok" }],
      [/tar xzf/, { code: 0 }],
      [/gunzip -c .*docker load/, { code: 0, stdout: "Loaded image: adanalytics-api:latest" }],
      [/up -d --no-build/, { code: 0, stdout: "Started" }],
      [/run --rm migrate/, { code: 0, stdout: "migrated" }],
    ]);
    const out = await tool("offline_install").handler(deps, { server: "prod", app: "analytics", bundlePath: "/tmp/adpix-offline-analytics.tar.gz", timeoutSeconds: 2400 });
    expect(puts.some((p) => /adpix-offline-analytics\.tar\.gz=>.*\/tmp\/adpix-offline-analytics\.tar\.gz/.test(p))).toBe(true);
    expect(calls.some((c) => /gunzip .*images\.tar\.gz.* docker load/.test(c))).toBe(true);
    expect(calls.some((c) => /up -d --no-build/.test(c))).toBe(true);                 // images loaded → no build
    expect(calls.some((c) => /run --rm migrate/.test(c))).toBe(true);
    expect(out).toMatch(/installed offline at \/opt\/adpix/);
  });

  it("errors clearly when the session can't stream files", async () => {
    const noPut: Session = { server: SRV, authMethod: "publickey", close: () => {}, exec: async () => ({ code: 0, stdout: "ok", stderr: "" }) };
    const deps: Deps = { resolve: () => SRV, connect: async () => noPut, local: async () => ({ code: 0, stdout: "", stderr: "" }) };
    expect(await tool("offline_install").handler(deps, { server: "prod", app: "tagmanager", bundlePath: "/tmp/x", timeoutSeconds: 2400 })).toMatch(/can't stream files/);
  });
});
