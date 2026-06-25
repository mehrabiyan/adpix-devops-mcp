import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import { buildServerMetrics, buildServerInventory } from "../src/panel/aggregate/server.js";
import { servePanel } from "../src/panel/server.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";

const SRV: ServerConfig = { name: "prod", host: "10.0.0.1", port: 22, username: "root", adpixDir: "/opt/adpix" };
function deps(stdout: string, fail = false): Deps {
  const session: Session = { server: SRV, authMethod: "publickey", close: () => {}, exec: async (): Promise<ExecResult> => ({ code: 0, stdout, stderr: "" }) };
  return { resolve: () => SRV, connect: async () => { if (fail) throw new Error("ssh refused"); return session; }, local: async () => ({ code: 0, stdout: "", stderr: "" }) };
}

describe("buildServerMetrics", () => {
  const PROBE = "CORES=4\nLOAD=0.50 1.00 1.50\nMEM=8000 3000 4500\nDISK=60000 20000 38000\nUP=123456\nKERN=6.8.0-generic";
  it("parses cores, load, RAM, disk, uptime, kernel", async () => {
    const m = await buildServerMetrics(deps(PROBE));
    expect(m.reachable).toBe(true);
    expect(m.cores).toBe(4);
    expect(m.load).toEqual([0.5, 1.0, 1.5]);
    expect(m.mem).toEqual({ totalMB: 8000, usedMB: 3000, availMB: 4500 });
    expect(m.disk).toEqual({ totalMB: 60000, usedMB: 20000, availMB: 38000 });
    expect(m.uptimeSec).toBe(123456);
    expect(m.kernel).toBe("6.8.0-generic");
  });
  it("never throws — connect failure → unreachable + error", async () => {
    const m = await buildServerMetrics(deps("", true));
    expect(m.reachable).toBe(false);
    expect(m.error).toMatch(/ssh refused/);
  });
});

describe("buildServerInventory (detects setups not done via this panel)", () => {
  // project \t working_dir \t state
  const PS = [
    "adanalytics\t/opt/adpix\trunning",
    "adanalytics\t/opt/adpix\trunning",
    "adpix-tm\t/srv/custom/tm\trunning",          // non-standard dir → external
    "adpix-account\t/opt/adpix-tagmanager\texited",
    "some-other-app\t/srv/x\trunning",
  ].join("\n");
  it("maps compose projects to products + flags off-standard dirs as external", async () => {
    const v = await buildServerInventory(deps(PS));
    const by = Object.fromEntries(v.products.map((p) => [p.project, p]));
    expect(by.adanalytics.product).toBe("AdPix Analytics");
    expect(by.adanalytics.up).toBe(true);
    expect(by.adanalytics.total).toBe(2);
    expect(by.adanalytics.external).toBe(false);          // standard dir
    expect(by["adpix-tm"].external).toBe(true);            // /srv/custom/tm ≠ standard
    expect(by["adpix-account"].up).toBe(false);           // exited
    expect(v.unknown.map((u) => u.project)).toContain("some-other-app");
  });
  it("empty + error on connect failure", async () => {
    const v = await buildServerInventory(deps("", true));
    expect(v.products).toEqual([]);
    expect(v.error).toMatch(/ssh refused/);
  });
});

describe("edit-server endpoint", () => {
  let tmp: string; const SAVED = process.env.ADPIX_DEVOPS_HOME;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-edit-")); process.env.ADPIX_DEVOPS_HOME = tmp; fs.writeFileSync(path.join(tmp, "servers.json"), JSON.stringify({ version: 1, servers: { prod: { host: "10.0.0.5", port: 22, username: "root", adpixDir: "/opt/adpix" } } })); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

  function benign(): Deps {
    const session: Session = { server: SRV, authMethod: "publickey", close: () => {}, exec: async (): Promise<ExecResult> => ({ code: 0, stdout: "ok", stderr: "" }) };
    return { resolve: () => SRV, connect: async () => session, local: async () => ({ code: 0, stdout: "ok", stderr: "" }) };
  }
  async function withPanel(fn: (base: string, H: Record<string, string>) => Promise<void>) {
    const token = "a".repeat(64);
    const server: Server = await servePanel({ port: 0, host: "127.0.0.1", token, deps: benign() });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try { await fn(base, { "x-adpix-token": token, "content-type": "application/json" }); } finally { server.close(); }
  }

  it("GET /api/server-config returns the entry; POST edit-server updates the registry + re-verifies", async () => {
    await withPanel(async (base, H) => {
      const cfg = await (await fetch(`${base}/api/server-config?name=prod`, { headers: H })).json();
      expect(cfg.host).toBe("10.0.0.5"); expect(cfg.port).toBe(22);
      const r = await (await fetch(`${base}/api/wizard/edit-server`, { method: "POST", headers: H, body: JSON.stringify({ name: "prod", port: 2222, username: "deploy" }) })).json();
      expect(r.ok).toBe(true);
      // persisted before re-test
      const saved = JSON.parse(fs.readFileSync(path.join(tmp, "servers.json"), "utf8"));
      expect(saved.servers.prod.port).toBe(2222);
      expect(saved.servers.prod.username).toBe("deploy");
    });
  });
});
