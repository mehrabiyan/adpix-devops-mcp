import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSecurityView } from "../src/panel/aggregate/security.js";
import { saveRegistry, loadRegistry } from "../src/registry.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";

let tmp: string; const SAVED = process.env.ADPIX_DEVOPS_HOME;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-aggsec-")); process.env.ADPIX_DEVOPS_HOME = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

function deps(stdout = "", throwIt = false): Deps {
  const srv = { name: "node-a", host: "10.0.0.11", port: 22, username: "root", adpixDir: "/opt/adpix" };
  return {
    resolve: () => srv,
    connect: async () => { if (throwIt) throw new Error("connect ECONNREFUSED"); return { server: srv as never, authMethod: "publickey", close: () => {}, exec: async (): Promise<ExecResult> => ({ code: 0, stdout, stderr: "" }) } as Session; },
    local: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
}

describe("buildSecurityView", () => {
  it("aggregates findings into counts + score + verdict (FAIL sorted first)", async () => {
    const v = await buildSecurityView(deps());
    expect(v.error).toBeUndefined();
    expect(v.findings.length).toBeGreaterThan(0);
    expect(v.counts.pass + v.counts.warn + v.counts.fail).toBe(v.findings.length);
    expect(v.score).toBeGreaterThanOrEqual(0); expect(v.score).toBeLessThanOrEqual(100);
    expect(["ACTION REQUIRED", "ROOM TO HARDEN", "GOOD"]).toContain(v.verdict);
    // ordering: no PASS appears before a FAIL/WARN
    const levels = v.findings.map((f) => f.level);
    const lastBad = Math.max(levels.lastIndexOf("FAIL"), levels.lastIndexOf("WARN"));
    const firstPass = levels.indexOf("PASS");
    if (firstPass !== -1 && lastBad !== -1) expect(firstPass).toBeGreaterThan(lastBad);
  });
  it("launch gate: blocked by default with the P1 blockers listed", async () => {
    const v = await buildSecurityView(deps());
    expect(v.launchGate.cleared).toBe(false);
    expect(v.launchGate.blockers.length).toBeGreaterThan(0);
  });
  it("launch gate: cleared when the registry records it resolved", async () => {
    saveRegistry({ version: 1, servers: {} });
    const reg = loadRegistry(); reg.launchGate = { resolved: true, reference: "audit-123", at: "2026-06-22T00:00:00Z" }; saveRegistry(reg);
    const v = await buildSecurityView(deps());
    expect(v.launchGate.cleared).toBe(true);
    expect(v.launchGate.reference).toBe("audit-123");
    expect(v.launchGate.blockers).toEqual([]);
  });
  it("connect failure → typed error, gate still reported", async () => {
    const v = await buildSecurityView(deps("", true));
    expect(v.error).toBeTruthy();
    expect(v.findings).toEqual([]);
    expect(v.launchGate.cleared).toBe(false); // gate read from registry regardless
  });
});
