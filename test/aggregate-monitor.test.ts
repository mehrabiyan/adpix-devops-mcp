import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildMonitorView } from "../src/panel/aggregate/monitor.js";
import { saveRegistry, loadRegistry } from "../src/registry.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";

let tmp: string; const SAVED = process.env.ADPIX_DEVOPS_HOME;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-aggmon-")); process.env.ADPIX_DEVOPS_HOME = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

function deps(answers: [RegExp, string][], throwIt = false): Deps {
  const srv = { name: "node-a", host: "10.0.0.11", port: 22, username: "root", adpixDir: "/opt/adpix" };
  return {
    resolve: () => srv,
    connect: async () => { if (throwIt) throw new Error("timed out"); return { server: srv as never, authMethod: "publickey", close: () => {}, exec: async (cmd): Promise<ExecResult> => { for (const [re, out] of answers) if (re.test(cmd)) return { code: 0, stdout: out, stderr: "" }; return { code: 0, stdout: "", stderr: "" }; } } as Session; },
    local: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
}
function clusterHosts(hosts: string[]) { saveRegistry({ version: 1, servers: {} }); const r = loadRegistry(); r.clusters = { prod: { nodes: [], hosts, idpIssuer: "x" } }; saveRegistry(r); }

describe("buildMonitorView", () => {
  it("returns a probe row per health route + TLS certs with days/level", async () => {
    clusterHosts(["app.adpix.io"]);
    const v = await buildMonitorView(deps([[/curl/, "200 0.012"], [/openssl/, "notAfter=Dec 31 23:59:59 2099 GMT"]]), undefined, "prod");
    expect(v.error).toBeUndefined();
    expect(v.probes.length).toBe(4); // HEALTH_ROUTES
    expect(v.probes.every((p) => p.ok && p.http === "200")).toBe(true);
    expect(v.probes[0].ms).toBe(12);
    expect(v.certs.length).toBe(1);
    expect(v.certs[0].host).toBe("app.adpix.io");
    expect(v.certs[0].days).toBeGreaterThan(0); expect(v.certs[0].level).toBe("pos");
  });
  it("marks a failed probe (000) not ok, and an expiring cert warn/neg", async () => {
    clusterHosts(["app.adpix.io", "api.adpix.io"]);
    const future = new Date(Date.now() + 5 * 86400000).toUTCString().replace("GMT", "GMT"); // ~5 days → warn
    const v = await buildMonitorView(deps([[/curl/, "000 0"], [/openssl/, `notAfter=${future}`]]), undefined, "prod");
    expect(v.probes.every((p) => !p.ok)).toBe(true);
    expect(v.certs.every((cert) => cert.level === "warn")).toBe(true); // <14 days
  });
  it("no cert served → neg", async () => {
    clusterHosts(["app.adpix.io"]);
    const v = await buildMonitorView(deps([[/curl/, "200 0.01"], [/openssl/, ""]]), undefined, "prod");
    expect(v.certs[0].level).toBe("neg");
  });
  it("connect failure → typed error", async () => {
    const v = await buildMonitorView(deps([], true));
    expect(v.error).toBeTruthy(); expect(v.probes).toEqual([]);
  });
});
