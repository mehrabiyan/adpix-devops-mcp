import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/index.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";

/**
 * Security E2E through the REAL MCP protocol: drive the ADPIX-IR-2026-06-26 incident-response chain on a
 * single STATEFUL fake host (audit → hunt → contain → rotate → harden → re-hunt → re-audit), asserting the
 * state actually transitions COMPROMISED→CLEAN and unhardened→hardened. Plus crash-safety (adversarial deps
 * never crash the server) and the destructive-guard (no mutation without confirm) — all over the protocol.
 */
const SERVER: ServerConfig = { name: "prod1", host: "188.121.120.36", port: 22, username: "root", adpixDir: "/opt/adpix" };

async function connectClient(deps: Deps): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "e2e-sec", version: "0" });
  await Promise.all([client.connect(ct), buildServer(deps).connect(st)]);
  return client;
}
const text = (r: { content?: unknown }) => ((r.content as { type: string; text: string }[])?.[0]?.text ?? "");
const call = (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: { server: "prod1", ...args } }).then(text);

// ── the stateful compromised host ──
function incidentHost() {
  const state = { compromised: true, hardened: false, rotated: 0, stopped: false, blocked: false, snapshot: false };
  const seen: string[] = [];
  const exec = async (cmd: string): Promise<ExecResult> => {
    seen.push(cmd);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    // threat_scan: single delimited probe
    if (/ps -eo pcpu,pid,user,comm/.test(cmd)) {
      return ok(state.compromised
        ? "===PROCS\n287 4242 root dashboard /tmp/dashboard\n===MINER\ndashboard /tmp/dashboard gulf.moneroocean.stream:10128\n===TMP\n/tmp/dashboard\n/tmp/v.json\n===CONNS\n77.90.13.20:10128\n===LISTEN\n0.0.0.0:9696\n===CTN\nadanalytics-web-1|user=|net=/usr/bin/wget,|miner="
        : "===PROCS\n2.0 10 root next-server /app\n===MINER\n\n===TMP\n\n===CONNS\n\n===LISTEN\n0.0.0.0:443\n0.0.0.0:22\n===CTN\n");
    }
    // security_audit: single delimited probe
    if (/sshd -T/.test(cmd)) {
      return ok(state.hardened
        ? `===SSHD\npasswordauthentication no\npermitrootlogin prohibit-password\n===UFW\nStatus: active\n===PORTS\n\n===F2B\nactive\n===AUTOUPD\n"1"\n===UPD\n0\n0\n===REBOOT\nno\n===DOCKERPORTS\nnone\n===ENVPERM\n600 root\n===CTNROOT\n\n===BRUTE\n0`
        : `===SSHD\npasswordauthentication yes\npermitrootlogin yes\n===UFW\ninactive\n===PORTS\n9696 6379 8123\n===F2B\ninactive\n===AUTOUPD\nmissing\n===UPD\n5\n2\n===REBOOT\nno\n===DOCKERPORTS\nadanalytics-web-1 -> 0.0.0.0:9696->9696/tcp\n===ENVPERM\n600 root\n===CTNROOT\nadanalytics-web-1 ships /usr/bin/wget as root\n===BRUTE\n3298`);
    }
    // quarantine
    if (/mkdir -p \$D/.test(cmd)) { state.snapshot = true; return ok("/root/ir-20260626-101500"); }
    if (/iptables/.test(cmd)) { state.blocked = true; return ok("blocked"); }
    if (/docker stop/.test(cmd)) { state.stopped = true; state.compromised = false; return ok("adanalytics-web-1"); }
    // secret_rotate
    if (/while IFS=/.test(cmd)) return ok("POSTGRES_USER|9\nPOSTGRES_PASSWORD|44\nDATABASE_URL|88\nREDIS_PASSWORD|44\nSERVER_API_KEY|48\nCLICKHOUSE_PASSWORD|0");
    if (/grep \^POSTGRES_USER=/.test(cmd)) return ok("sovereign");
    if (/cp .*\.env.* "\$B"|\.env.*\.bak-/.test(cmd)) return ok("/opt/adpix/.env.bak-20260626-101500");
    if (/echo ROTATED/.test(cmd)) { state.rotated++; return ok("ROTATED"); }
    // harden_server (apply)
    if (/ufw --force enable/.test(cmd)) { state.hardened = true; return ok("Status: active"); }
    if (/fail2ban/.test(cmd)) return ok("active");
    if (/up -d --no-deps/.test(cmd)) return ok("Recreated");
    if (/healthz|HTTP 200|curl/.test(cmd)) return ok("front door HTTP 200");
    return ok();
  };
  const session: Session = { server: SERVER, authMethod: "publickey", close: () => {}, exec };
  const deps: Deps = { resolve: () => SERVER, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) };
  return { deps, state, seen };
}

describe("Security E2E — incident response lifecycle through the MCP protocol", () => {
  let tmpHome: string; const saved = process.env.ADPIX_DEVOPS_HOME;
  beforeAll(() => { tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-sec-e2e-")); process.env.ADPIX_DEVOPS_HOME = tmpHome; });
  afterAll(() => { fs.rmSync(tmpHome, { recursive: true, force: true }); if (saved === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = saved; });

  it("audit→threat→quarantine→rotate→harden→re-scan→re-audit drives COMPROMISED→CLEAN + unhardened→hardened", async () => {
    const { deps, state } = incidentHost();
    const c = await connectClient(deps);

    // 1) audit finds the gaps (exposed IdP port, no firewall, root+wget container, brute force)
    const audit0 = await call(c, "security_audit");
    expect(audit0).toMatch(/ACTION REQUIRED|FAIL/);
    expect(audit0).toMatch(/9696|datastore|publicly/i);
    expect(audit0).toMatch(/ROOT and ship|wget/);

    // 2) threat hunt → COMPROMISED (miner proc + mining-pool egress + /tmp dropper)
    const scan0 = await call(c, "threat_scan");
    expect(scan0).toMatch(/COMPROMISED/);
    expect(scan0).toMatch(/mining-pool|miner/i);

    // 3) contain: snapshot evidence + stop + block egress (confirm-gated)
    const q = await call(c, "quarantine", { container: "adanalytics-web-1", stop: true, blockIp: "77.90.13.20", confirm: true });
    expect(q).toMatch(/Snapshotted to \/root\/ir-2026/);
    expect(q).toMatch(/Egress block/);
    expect(q).toMatch(/Stopped/);
    expect(state.snapshot && state.blocked && state.stopped).toBe(true);
    expect(state.compromised).toBe(false);   // payload killed

    // 4) rotate the exfiltrated secrets — never leaks a value
    const rot = await call(c, "secret_rotate", { stack: "analytics", scope: "all", confirm: true });
    expect(rot).toMatch(/Rotated/);
    expect(rot).toMatch(/POSTGRES_PASSWORD/);
    expect(rot).not.toMatch(/[0-9a-f]{32}/);  // no generated secret in the output
    expect(state.rotated).toBeGreaterThan(0);

    // 5) harden the host
    const harden = await call(c, "harden_server", { apply: true });
    expect(harden).toMatch(/firewall|ufw|fail2ban/i);
    expect(state.hardened).toBe(true);

    // 6) re-hunt → CLEAN (miner gone)
    const scan1 = await call(c, "threat_scan");
    expect(scan1).toMatch(/→ CLEAN/);

    // 7) re-audit → hardened (firewall active, password auth off, no root+wget)
    const audit1 = await call(c, "security_audit");
    expect(audit1).toMatch(/GOOD|ROOM TO HARDEN/);
    expect(audit1).toMatch(/ufw firewall active|password authentication disabled/i);

    await c.close();
  });
});

describe("Crash-safety — adversarial deps never crash the MCP server", () => {
  const SEC = [
    ["threat_scan", {}],
    ["quarantine", { container: "web", stop: true, confirm: true }],
    ["secret_rotate", { stack: "analytics", scope: "all", confirm: true }],
    ["security_audit", {}],
    ["harden_server", { apply: true }],
  ] as const;

  it("connect throwing → every tool resolves to an error result, server stays responsive", async () => {
    const deps: Deps = { resolve: () => SERVER, connect: async () => { throw new Error("ssh: connect ECONNREFUSED 188.121.120.36:22"); }, local: async () => ({ code: 0, stdout: "", stderr: "" }) };
    const c = await connectClient(deps);
    for (const [name, args] of SEC) {
      const res = await c.callTool({ name, arguments: { server: "prod1", ...args } });
      expect((res as { isError?: boolean }).isError).toBe(true);          // mapped to isError, not a crash
      expect(text(res)).toMatch(/ECONNREFUSED|connect|ssh/i);
    }
    // server still alive: a follow-up call resolves with content
    const after = await c.callTool({ name: "threat_scan", arguments: { server: "prod1" } });
    expect((after as { isError?: boolean }).isError).toBe(true);
    await c.close();
  });

  it("nonzero exit + garbage/binary output → tools return text, never throw at the protocol", async () => {
    const session: Session = { server: SERVER, authMethod: "publickey", close: () => {}, exec: async (): Promise<ExecResult> => ({ code: 1, stdout: " garbage\nrandom", stderr: "boom" }) };
    const deps: Deps = { resolve: () => SERVER, connect: async () => session, local: async () => ({ code: 1, stdout: "x", stderr: "y" }) };
    const c = await connectClient(deps);
    for (const [name, args] of SEC) {
      const res = await c.callTool({ name, arguments: { server: "prod1", ...args } });
      expect(text(res).length).toBeGreaterThan(0);   // resolved with content (no unhandled crash)
    }
    await c.close();
  });
});

describe("Destructive guard — no mutation without confirm (through the protocol)", () => {
  function trackHost() {
    const seen: string[] = [];
    const session: Session = { server: SERVER, authMethod: "publickey", close: () => {}, exec: async (cmd: string): Promise<ExecResult> => { seen.push(cmd); return { code: 0, stdout: /reboot-required/.test(cmd) ? "yes" : "", stderr: "" }; } };
    const deps: Deps = { resolve: () => SERVER, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) };
    return { deps, seen };
  }

  it("quarantine stop without confirm → REFUSED, issues no docker stop / iptables", async () => {
    const { deps, seen } = trackHost();
    const c = await connectClient(deps);
    const out = await call(c, "quarantine", { container: "web", stop: true, blockIp: "1.2.3.4" });
    expect(out).toMatch(/REFUSED/);
    expect(seen.some((s) => /docker stop|iptables/.test(s))).toBe(false);
    await c.close();
  });

  it("secret_rotate confirm without a selection → REFUSED, writes no .env / ALTER ROLE", async () => {
    const { deps, seen } = trackHost();
    const c = await connectClient(deps);
    const out = await call(c, "secret_rotate", { stack: "analytics", confirm: true });
    expect(out).toMatch(/REFUSED/);
    expect(seen.some((s) => /ALTER ROLE|\.bak-|ROTATED/.test(s))).toBe(false);
    await c.close();
  });

  it("harden_server preview + container_control refuse without confirm; patch_system gates the REBOOT", async () => {
    const { deps, seen } = trackHost();
    const c = await connectClient(deps);
    // harden_server apply:false → plan only, no ufw enable
    expect(await call(c, "harden_server", { apply: false })).toMatch(/apply:true to execute/);
    // container_control restart confirm:false → refused, no docker restart
    expect(await call(c, "container_control", { service: "api", action: "restart", confirm: false })).toMatch(/REFUSED|confirm|preview/i);
    expect(seen.some((s) => /ufw --force enable|docker .* restart/.test(s))).toBe(false);
    // patch_system: reboot needed + autoReboot but confirm:false → must NOT reboot (the risky bit is gated)
    const patch = await call(c, "patch_system", { autoReboot: true, confirm: false });
    expect(patch).toMatch(/confirm:true to reboot/i);
    expect(seen.some((s) => /shutdown -r|systemctl reboot/.test(s))).toBe(false);  // the actual reboot action, not the reboot-required probe
    await c.close();
  });
});
