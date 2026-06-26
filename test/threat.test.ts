import { describe, expect, it } from "vitest";
import { threatTools } from "../src/tools/threat.js";
import { authComposeYaml, consoleComposeYaml } from "../src/tools/tagmanager.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";

const SRV: ServerConfig = { name: "prod1", host: "188.121.120.36", port: 22, username: "root", adpixDir: "/opt/adpix" };
const scan = threatTools.find((t) => t.name === "threat_scan")!;
const quar = threatTools.find((t) => t.name === "quarantine")!;

// route every exec through a responder so we can simulate ps/ss/docker output
function deps(respond: (cmd: string) => string): Deps {
  const session: Session = {
    server: SRV, authMethod: "publickey", close: () => {},
    exec: async (cmd: string): Promise<ExecResult> => ({ code: 0, stdout: respond(cmd), stderr: "" }),
  };
  return { resolve: () => SRV, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) };
}

// a single probe string is sent; build the section payload it should return
function probeOut(sections: Partial<Record<"PROCS" | "MINER" | "TMP" | "CONNS" | "LISTEN" | "CTN", string>>): string {
  const order = ["PROCS", "MINER", "TMP", "CONNS", "LISTEN", "CTN"] as const;
  return order.map((k) => `===${k}\n${sections[k] ?? ""}`).join("\n");
}

describe("threat_scan", () => {
  it("CLEAN when nothing suspicious", async () => {
    const d = deps(() => probeOut({ PROCS: "%CPU PID USER COMMAND\n2.0 10 root next-server /app", LISTEN: "0.0.0.0:443\n0.0.0.0:22" }));
    const out = await scan.handler(d, { server: "prod1", cpuThreshold: 80 });
    expect(out).toContain("→ CLEAN");
  });

  it("COMPROMISED on a miner process + mining-pool egress (the IR-2026-06-26 shape)", async () => {
    const d = deps(() => probeOut({
      MINER: "dashboard /tmp/dashboard --url gulf.moneroocean.stream:10128",
      PROCS: "287 4242 root dashboard /tmp/dashboard",
      CONNS: "77.90.13.20:10128",
      TMP: "/tmp/dashboard\n/tmp/v.json",
    }));
    const out = await scan.handler(d, { server: "prod1", cpuThreshold: 80 });
    expect(out).toContain("→ COMPROMISED");
    expect(out).toMatch(/mining-pool|miner/i);
    expect(out).toContain("quarantine");
  });

  it("SUSPICIOUS on a root container shipping wget (IR 2.2) with no active miner", async () => {
    const d = deps(() => probeOut({
      PROCS: "1.0 10 root next-server /app",
      CTN: "adanalytics-web-1|user=|net=/usr/bin/wget,|miner=",
    }));
    const out = await scan.handler(d, { server: "prod1", cpuThreshold: 80 });
    expect(out).toContain("→ SUSPICIOUS");
    expect(out).toMatch(/runs as ROOT and ships/);
  });
});

describe("quarantine", () => {
  it("refuses stop/blockIp without confirm", async () => {
    const out = await quar.handler(deps(() => ""), { server: "prod1", container: "web", stop: true, confirm: false });
    expect(out).toMatch(/REFUSED/);
  });

  it("snapshots evidence then stops + blocks egress with confirm", async () => {
    const seen: string[] = [];
    const d = deps((cmd) => { seen.push(cmd); return cmd.includes("mkdir") ? "/root/ir-20260626-101500" : "stopped"; });
    const out = await quar.handler(d, { server: "prod1", container: "adanalytics-web-1", stop: true, blockIp: "77.90.13.20", confirm: true });
    expect(out).toContain("/root/ir-20260626-101500");
    expect(out).toMatch(/Egress block/);
    expect(out).toMatch(/Stopped/);
    expect(seen.some((c) => c.includes("docker inspect"))).toBe(true);
    expect(seen.some((c) => c.includes("iptables") && c.includes("77.90.13.20"))).toBe(true);
    expect(seen.some((c) => c.includes("docker stop"))).toBe(true);
  });
});

describe("port-exposure fix (IR 1.2 / 3.1) — bind internal ports to loopback when Caddy fronts them", () => {
  it("auth (IdP) binds 9696 to 127.0.0.1 when a domain (Caddy) is set", () => {
    expect(authComposeYaml("PEM", { domain: "account.adpix.io" })).toContain(`127.0.0.1:${"${AUTH_PORT:-9696}"}:9696`);
  });
  it("auth publishes 9696 on all interfaces only when there is NO domain (direct http access)", () => {
    const yaml = authComposeYaml("PEM", {});
    expect(yaml).toContain(`- "${"${AUTH_PORT:-9696}"}:9696"`);
    expect(yaml).not.toContain("127.0.0.1:${AUTH_PORT");
  });
  it("console binds 3000 to loopback when its Caddy is bundled", () => {
    expect(consoleComposeYaml({ dir: "/opt/x", bundleCaddy: true })).toContain(`127.0.0.1:${"${CONSOLE_PORT:-3000}"}:3000`);
    expect(consoleComposeYaml({ dir: "/opt/x", bundleCaddy: false })).not.toContain("127.0.0.1:${CONSOLE_PORT");
  });
});
