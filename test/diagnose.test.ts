import { describe, expect, it } from "vitest";
import { classifyError } from "../src/panel/errors.js";
import { diagnoseServer } from "../src/panel/diagnose.js";
import type { Deps } from "../src/deps.js";
import type { ConnectOpts, ExecResult, Session } from "../src/ssh.js";

// fake deps that records connect opts and answers exec by regex
function diagDeps(answers: [RegExp, string][], opts: { throwOn?: string } = {}) {
  const seen: { opts?: ConnectOpts }[] = [];
  const deps: Deps = {
    resolve: () => ({ name: "x", host: "x", port: 22, username: "root", adpixDir: "/opt/adpix" }),
    connect: async (srv, o) => {
      seen.push({ opts: o });
      if (opts.throwOn && (srv as { host: string }).host === opts.throwOn) throw new Error("All configured authentication methods failed");
      const s: Session = { server: srv as never, authMethod: "publickey", close: () => {}, exec: async (cmd): Promise<ExecResult> => { for (const [re, out] of answers) if (re.test(cmd)) return { code: 0, stdout: out, stderr: "" }; return { code: 0, stdout: "", stderr: "" }; } };
      return s;
    },
    local: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  return { deps, seen };
}
const READY: [RegExp, string][] = [[/id -un/, "root\n===\nSUDO_OK"], [/os-release/, "Ubuntu 24.04 LTS"], [/docker --version/, "Docker version 27.1.1"], [/df -h/, "182G free, 18% used"]];

describe("classifyError", () => {
  it("buckets the common SSH/network failures", () => {
    expect(classifyError(new Error("All configured authentication methods failed")).kind).toBe("auth");
    expect(classifyError(new Error("connect ECONNREFUSED 1.2.3.4:22")).kind).toBe("refused");
    expect(classifyError(new Error("Timed out while waiting for handshake")).kind).toBe("timeout");
    expect(classifyError(new Error("getaddrinfo ENOTFOUND nope.invalid")).kind).toBe("dns");
    expect(classifyError(new Error("host key for 1.2.3.4 changed!")).kind).toBe("hostkey");
    expect(classifyError(new Error("weird")).kind).toBe("unknown");
  });
});

describe("diagnoseServer", () => {
  it("connect failure → not reachable, cannot add, friendly message", async () => {
    const { deps } = diagDeps([], { throwOn: "9.9.9.9" });
    const d = await diagnoseServer(deps, { host: "9.9.9.9" });
    expect(d.reachable).toBe(false);
    expect(d.canAdd).toBe(false);
    expect(d.checks[0].detail).toMatch(/authentication failed/i);
  });
  it("root + docker + disk ok → reachable + canAdd, all checks pass", async () => {
    const { deps } = diagDeps(READY);
    const d = await diagnoseServer(deps, { host: "10.0.0.5" });
    expect(d.reachable).toBe(true);
    expect(d.canAdd).toBe(true);
    expect(d.checks.every((c) => c.ok)).toBe(true);
    expect(d.checks.find((c) => c.name === "Operating system")!.detail).toMatch(/Ubuntu/);
  });
  it("no root / no sudo → hard fail blocks add", async () => {
    const { deps } = diagDeps([[/id -un/, "deploy\n===\nNO_SUDO"], ...READY.slice(1)]);
    const d = await diagnoseServer(deps, { host: "10.0.0.6" });
    expect(d.canAdd).toBe(false);
    expect(d.checks.find((c) => c.name === "Privilege")!.ok).toBe(false);
  });
  it("missing Docker is a SOFT warning, still addable", async () => {
    const { deps } = diagDeps([[/id -un/, "root\n===\nSUDO_OK"], [/os-release/, "Debian 12"], [/docker --version/, "NONE"], [/df -h/, "50G free, 40% used"]]);
    const d = await diagnoseServer(deps, { host: "10.0.0.7" });
    const docker = d.checks.find((c) => c.name === "Docker")!;
    expect(docker.ok).toBe(false); expect(docker.soft).toBe(true);
    expect(d.canAdd).toBe(true); // soft fail doesn't block
  });
  it("passes the password through as a connect opt (never a key)", async () => {
    const { deps, seen } = diagDeps(READY);
    await diagnoseServer(deps, { host: "10.0.0.8", password: "rootpw" });
    expect(seen[0].opts).toEqual({ password: "rootpw" });
  });
  it("passes an explicit key path through as a connect opt", async () => {
    const { deps, seen } = diagDeps(READY);
    await diagnoseServer(deps, { host: "10.0.0.9", privateKeyPath: "/keys/id" });
    expect(seen[0].opts).toEqual({ privateKeyPathOverride: "/keys/id" });
  });
  it("a failing exec does not crash the diagnosis", async () => {
    const deps: Deps = {
      resolve: () => ({ name: "x", host: "x", port: 22, username: "root", adpixDir: "/opt/adpix" }),
      connect: async (srv) => ({ server: srv as never, authMethod: "publickey", close: () => {}, exec: async (): Promise<ExecResult> => { throw new Error("exec blew up"); } }),
      local: async () => ({ code: 0, stdout: "", stderr: "" }),
    };
    const d = await diagnoseServer(deps, { host: "10.0.0.10" });
    expect(d.reachable).toBe(true); // connected, but probes errored
    expect(d.canAdd).toBe(false);
  });
});
