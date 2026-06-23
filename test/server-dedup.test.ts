import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { findServerByHost, loadRegistry, saveRegistry } from "../src/registry.js";
import { notInstalledMsg } from "../src/adpix.js";
import { allTools } from "../src/tools/index.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";

const tool = (n: string) => { const t = allTools.find((t) => t.name === n); if (!t) throw new Error(n); return t; };

let home: string;
beforeAll(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-reg-")); process.env.ADPIX_DEVOPS_HOME = home; });
afterAll(() => { delete process.env.ADPIX_DEVOPS_HOME; fs.rmSync(home, { recursive: true, force: true }); });

describe("findServerByHost", () => {
  const reg = { version: 1 as const, servers: { a: { host: "1.2.3.4", port: 22 }, b: { host: "5.6.7.8", port: 2222 } } };
  it("matches host:port, case-insensitive", () => {
    expect(findServerByHost(reg, "1.2.3.4")).toBe("a");
    expect(findServerByHost(reg, "5.6.7.8", 2222)).toBe("b");
    expect(findServerByHost(reg, "5.6.7.8", 22)).toBeUndefined(); // different port
    expect(findServerByHost(reg, "9.9.9.9")).toBeUndefined();
  });
  it("ignores the excepted name (so updating the same server is allowed)", () => {
    expect(findServerByHost(reg, "1.2.3.4", 22, "a")).toBeUndefined();
  });
});

describe("server_add host dedup", () => {
  it("refuses the same host under a different name", async () => {
    const reg = loadRegistry(); reg.servers["prod1"] = { host: "188.245.92.203", port: 22 }; saveRegistry(reg);
    const deps = { resolve: () => ({ name: "x", host: "x", port: 22, username: "root", adpixDir: "/opt/adpix" }), connect: async () => { throw new Error("should not connect"); }, local: async () => ({ code: 0, stdout: "", stderr: "" }) } as Deps;
    const out = await tool("server_add").handler(deps, { name: "witness1", host: "188.245.92.203", username: "root", port: 22, adpixDir: "/opt/adpix", setDefault: false, verify: false });
    expect(out).toMatch(/already registered as "prod1"/);
    expect(loadRegistry().servers["witness1"]).toBeUndefined(); // not saved
  });
  it("allows re-registering the SAME name (idempotent update)", async () => {
    const deps = { resolve: () => ({ name: "x", host: "x", port: 22, username: "root", adpixDir: "/opt/adpix" }), connect: async () => { throw new Error("no"); }, local: async () => ({ code: 0, stdout: "", stderr: "" }) } as Deps;
    const out = await tool("server_add").handler(deps, { name: "prod1", host: "188.245.92.203", username: "root", port: 22, adpixDir: "/opt/adpix", setDefault: false, verify: false });
    expect(out).toMatch(/saved/);
  });
});

describe("notInstalledMsg", () => {
  function s(installed: boolean): Session {
    return { server: { name: "prod3", host: "x", port: 22, username: "root", adpixDir: "/opt/adpix" }, authMethod: "publickey", close: () => {}, exec: async (): Promise<ExecResult> => ({ code: 0, stdout: installed ? "yes" : "no", stderr: "" }) };
  }
  it("returns a clear message when the checkout is absent", async () => {
    const m = await notInstalledMsg(s(false), "/opt/adpix", "prod3");
    expect(m).toMatch(/not installed at \/opt\/adpix on prod3/);
    expect(m).toMatch(/Install/);
  });
  it("returns null when installed", async () => {
    expect(await notInstalledMsg(s(true), "/opt/adpix", "prod3")).toBeNull();
  });
});
