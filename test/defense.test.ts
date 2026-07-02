import { describe, expect, it } from "vitest";
import { honeypotTools } from "../src/tools/honeypot.js";
import { egressTools } from "../src/tools/egress.js";
import { networkTools } from "../src/tools/network.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";

const SRV: ServerConfig = { name: "prod1", host: "188.121.120.36", port: 22, username: "root", adpixDir: "/opt/adpix" };
const honeypot = honeypotTools.find((t) => t.name === "honeypot")!;
const egress = egressTools.find((t) => t.name === "egress_lockdown")!;
const netDiag = networkTools.find((t) => t.name === "net_diag")!;

function deps(respond: (cmd: string) => string | ExecResult) {
  const seen: string[] = [];
  const session: Session = {
    server: SRV, authMethod: "publickey", close: () => {},
    exec: async (cmd: string): Promise<ExecResult> => { seen.push(cmd); const r = respond(cmd); return typeof r === "string" ? { code: 0, stdout: r, stderr: "" } : r; },
  };
  const d: Deps = { resolve: () => SRV, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) };
  return { d, seen };
}

describe("honeypot — isolated decoy", () => {
  // ss listeners: 22/80/443 used → 5432 (postgres) is a real service too
  const usedPorts = "22\n80\n443\n5432";
  it("plan only traps FREE attacker-magnet ports, never a real service's port, and states isolation", async () => {
    const { d } = deps((cmd) => (/ss -ltnH/.test(cmd) ? usedPorts : ""));
    const out = await honeypot.handler(d, { server: "prod1", action: "plan", block: false, confirm: false });
    expect(out).toMatch(/Honeypot plan/);
    expect(out).toMatch(/23\s+telnet/);            // free port trapped
    expect(out).toMatch(/5432\/postgres/);         // 5432 in use → skipped
    expect(out).toMatch(/internal:true → no egress/);
    expect(out).toMatch(/nobody|read-only|caps dropped/);
  });

  it("deploy refuses without confirm", async () => {
    const { d } = deps(() => "");
    const out = await honeypot.handler(d, { server: "prod1", action: "deploy", block: false, confirm: false });
    expect(out).toMatch(/REFUSED/);
  });

  it("deploy writes a hardened isolated compose (internal net, non-root, read-only, cap-drop) + brings it up", async () => {
    const { d, seen } = deps((cmd) => {
      if (/ss -ltnH/.test(cmd)) return "22\n80\n443";
      if (/docker compose .* up -d/.test(cmd)) return "Started";
      return "";
    });
    const out = await honeypot.handler(d, { server: "prod1", action: "deploy", block: false, confirm: true });
    expect(out).toMatch(/deployed/);
    const composeWrite = seen.find((c) => /docker-compose\.yml/.test(c) && /base64 -d/.test(c))!;
    expect(composeWrite).toBeTruthy();
    // the compose (base64) must carry every isolation guarantee
    const b64 = composeWrite.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/)?.[1];
    const yaml = Buffer.from(b64!, "base64").toString("utf8");
    expect(yaml).toMatch(/internal: true/);
    expect(yaml).toMatch(/user: "65534:65534"/);
    expect(yaml).toMatch(/read_only: true/);
    expect(yaml).toMatch(/cap_drop: \["ALL"\]/);
    expect(yaml).toMatch(/no-new-privileges:true/);
    // the honeypot script never authenticates + tarpits
    const pyWrite = seen.find((c) => /honeypot\.py/.test(c) && /base64 -d/.test(c))!;
    const py = Buffer.from(pyWrite.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/)![1], "base64").toString("utf8");
    expect(py).toMatch(/tarpit/);
    expect(py).toMatch(/Access denied|Login incorrect/);
  });

  it("report summarizes attacker IPs and can block them", async () => {
    const log = ['{"event": "connect", "svc": "ssh-alt", "src_ip": "45.9.1.2"}', '{"event": "connect", "svc": "ssh-alt", "src_ip": "45.9.1.2"}', '{"event": "data", "svc": "ssh-alt", "src_ip": "45.9.1.2", "sample": "root:admin123"}'].join("\n");
    const { d, seen } = deps((cmd) => {
      if (/grep -c '"event": "connect"'/.test(cmd)) return "===HITS\n2\n===IPS\n   2 45.9.1.2\n===SVC\n   3 ssh-alt\n===SAMPLES\n" + log.split("\n")[2];
      if (/iptables/.test(cmd)) return "";
      return "";
    });
    const out = await honeypot.handler(d, { server: "prod1", action: "report", block: true, confirm: false });
    expect(out).toMatch(/45\.9\.1\.2/);
    expect(out).toMatch(/Blocked 1 attacker/);
    expect(seen.some((c) => /iptables .* -s '?45\.9\.1\.2'? -j DROP/.test(c))).toBe(true);
  });
});

describe("egress_lockdown — default-deny container egress (IR 3.4)", () => {
  it("report is read-only and flags open egress", async () => {
    const { d, seen } = deps((cmd) => (/iptables -C DOCKER-USER/.test(cmd) ? { code: 1, stdout: "===HOOK\nabsent\n===RULES\n(no ADPIX_EGRESS chain)\n===EXT\neth0\n===DOCKERNET\nbridge", stderr: "" } : "===HOOK\nabsent\n===RULES\n(no ADPIX_EGRESS chain)\n===EXT\neth0"));
    const out = await egress.handler(d, { server: "prod1", action: "report", allowHosts: [], confirm: false });
    expect(out).toMatch(/NOT installed|whole internet/);
    expect(seen.some((c) => /iptables -I|iptables -A .* -j DROP/.test(c))).toBe(false);  // no mutation
  });

  it("apply refuses without confirm", async () => {
    const { d } = deps(() => "");
    expect(await egress.handler(d, { server: "prod1", action: "apply", allowHosts: [], confirm: false })).toMatch(/REFUSED/);
  });

  it("apply installs a default-deny chain that still allows established/DNS/private + allowHosts", async () => {
    const { d, seen } = deps((cmd) => (/ip route show default/.test(cmd) ? "EXT=eth0\n5" : ""));
    const out = await egress.handler(d, { server: "prod1", action: "apply", allowHosts: ["api.stripe.com"], confirm: true });
    expect(out).toMatch(/ACTIVE/);
    const apply = seen.find((c) => /ADPIX_EGRESS/.test(c) && /DROP/.test(c))!;
    expect(apply).toMatch(/ESTABLISHED,RELATED -j RETURN/);
    expect(apply).toMatch(/--dport 53 -j RETURN/);
    expect(apply).toMatch(/172\.16\.0\.0\/12 -j RETURN/);
    expect(apply).toMatch(/api\.stripe\.com/);
    expect(apply).toMatch(/-o "\$EXT" -j DROP/);            // only drops traffic leaving the box
    expect(apply).toMatch(/DOCKER-USER -j ADPIX_EGRESS/);   // hooked
  });

  it("aborts if there is no default route (won't risk cutting the box off)", async () => {
    const { d } = deps((cmd) => (/ip route show default/.test(cmd) ? { code: 3, stdout: "no default route — aborting (would risk cutting the box off)", stderr: "" } : ""));
    const out = await egress.handler(d, { server: "prod1", action: "apply", allowHosts: [], confirm: true });
    expect(out).toMatch(/FAILED/);
  });
});

describe("net_diag — advanced network read-out", () => {
  it("reports route, MTU, DNS, reachability + latency, and public surface", async () => {
    const { d } = deps(() =>
      "===ROUTE\ndefault via 10.0.0.1 dev eth0\n===IFACE\nmtu 1500\n10.0.0.9/24\n===DNS\n12ms 140.82.121.4\n===REACH\nR0|ok|8\nR1|FAIL|-\n===PUBSURFACE\n22 443 9200 \n===TRACE\nskipped"
    );
    const out = await netDiag.handler(d, { server: "prod1", hosts: ["1.1.1.1:443", "github.com:443"], trace: false });
    expect(out).toMatch(/Default route: default via 10\.0\.0\.1/);
    expect(out).toMatch(/mtu 1500/);
    expect(out).toMatch(/1\.1\.1\.1:443\s+reachable \(8ms\)/);
    expect(out).toMatch(/github\.com:443\s+UNREACHABLE/);
    expect(out).toMatch(/9200/);
    expect(out).toMatch(/more than SSH\/80\/443 exposed/);  // 9200 flagged
  });
});
