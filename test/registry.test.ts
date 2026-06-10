import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadRegistry, saveRegistry, resolveServer, registryPath } from "../src/registry.js";

let tmp: string;
const ENV_KEYS = ["ADPIX_DEVOPS_HOME", "ADPIX_SSH_HOST", "ADPIX_SSH_USER", "ADPIX_SSH_PORT", "ADPIX_SSH_KEY", "ADPIX_DIR"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-devops-test-"));
  process.env.ADPIX_DEVOPS_HOME = tmp;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("registry", () => {
  it("round-trips servers and sets tight file permissions", () => {
    saveRegistry({
      version: 1,
      defaultServer: "prod",
      servers: { prod: { host: "1.2.3.4", port: 22, username: "root", adpixDir: "/opt/adpix" } },
    });
    const reg = loadRegistry();
    expect(reg.servers.prod.host).toBe("1.2.3.4");
    const mode = fs.statSync(registryPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("resolves by name, filling defaults", () => {
    saveRegistry({ version: 1, servers: { a: { host: "h", username: "root" } as never } });
    const s = resolveServer("a");
    expect(s.port).toBe(22);
    expect(s.adpixDir).toBe("/opt/adpix");
  });

  it("resolves the default server when no name given", () => {
    saveRegistry({
      version: 1,
      defaultServer: "b",
      servers: {
        a: { host: "ha", port: 22, username: "root", adpixDir: "/opt/adpix" },
        b: { host: "hb", port: 22, username: "root", adpixDir: "/opt/adpix" },
      },
    });
    expect(resolveServer().host).toBe("hb");
  });

  it("resolves a single registered server without a default", () => {
    saveRegistry({ version: 1, servers: { only: { host: "x", port: 22, username: "root", adpixDir: "/opt/adpix" } } });
    expect(resolveServer().name).toBe("only");
  });

  it("falls back to ADPIX_SSH_* env vars when the registry is empty", () => {
    process.env.ADPIX_SSH_HOST = "9.9.9.9";
    process.env.ADPIX_SSH_USER = "ops";
    const s = resolveServer();
    expect(s.host).toBe("9.9.9.9");
    expect(s.username).toBe("ops");
    expect(s.name).toBe("env");
  });

  it("throws a helpful error for unknown names", () => {
    saveRegistry({ version: 1, servers: { prod: { host: "h", port: 22, username: "root", adpixDir: "/opt/adpix" } } });
    expect(() => resolveServer("staging")).toThrow(/Unknown server "staging".*prod/s);
  });

  it("throws when nothing is configured at all", () => {
    expect(() => resolveServer()).toThrow(/No servers configured/);
  });
});
