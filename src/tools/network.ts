import { z } from "zod";
import { withSession } from "../deps.js";
import { openReverseProxy, activeTunnel, closeTunnel } from "../ssh.js";
import { lastLines } from "../util.js";
import type { ToolDef } from "./types.js";

const serverParam = z.string().optional().describe("Target server name. Omit to use the default.");

/** Point the target's apt + docker daemon + git + shell env at the reverse-proxy port (the MCP's internet). */
export function proxyConfigScript(port: number): string {
  const P = `http://127.0.0.1:${port}`;
  return [
    `mkdir -p /etc/apt/apt.conf.d /etc/systemd/system/docker.service.d`,
    `printf 'Acquire::http::Proxy "${P}";\\nAcquire::https::Proxy "${P}";\\n' > /etc/apt/apt.conf.d/01adpix-proxy`,
    `printf '[Service]\\nEnvironment="HTTP_PROXY=${P}" "HTTPS_PROXY=${P}" "NO_PROXY=localhost,127.0.0.1,::1"\\n' > /etc/systemd/system/docker.service.d/adpix-proxy.conf`,
    `printf 'export HTTP_PROXY=${P} HTTPS_PROXY=${P} http_proxy=${P} https_proxy=${P} NO_PROXY=localhost,127.0.0.1\\n' > /etc/profile.d/adpix-proxy.sh`,
    `git config --system http.proxy ${P} 2>/dev/null || true`,
    `command -v docker >/dev/null 2>&1 && { systemctl daemon-reload 2>/dev/null; systemctl restart docker 2>/dev/null; } || true`,
  ].join("; ");
}
/** Remove every proxy hook the bridge installed + restart docker back to direct. */
export function proxyTeardownScript(): string {
  return [
    `rm -f /etc/apt/apt.conf.d/01adpix-proxy /etc/systemd/system/docker.service.d/adpix-proxy.conf /etc/profile.d/adpix-proxy.sh`,
    `git config --system --unset http.proxy 2>/dev/null || true`,
    `command -v docker >/dev/null 2>&1 && { systemctl daemon-reload 2>/dev/null; systemctl restart docker 2>/dev/null; } || true`,
  ].join("; ");
}

/**
 * Connectivity probe for the air-gap / intranet-only case. From the TARGET, tests reachability to the
 * things an install needs (the internet, GitHub, container registries, the apt + npm mirrors) plus
 * whether Docker/git are present — so the control plane knows whether to install normally, bridge the
 * target's egress through the MCP host (net_bridge), or fall back to an offline bundle. Read-only.
 */
export interface ProbeResult { name: string; target: string; ok: boolean }

const TARGETS: { name: string; host: string; port: number; why: string }[] = [
  { name: "internet", host: "1.1.1.1", port: 443, why: "raw internet egress" },
  { name: "dns", host: "github.com", port: 443, why: "DNS + GitHub (git clone)" },
  { name: "dockerhub", host: "registry-1.docker.io", port: 443, why: "Docker Hub (base images)" },
  { name: "ghcr", host: "ghcr.io", port: 443, why: "GitHub Container Registry" },
  { name: "apt", host: "archive.ubuntu.com", port: 80, why: "Ubuntu apt mirror (Docker/git packages)" },
  { name: "npm", host: "registry.npmjs.org", port: 443, why: "npm registry (build deps)" },
];

export function summarizeProbe(rows: ProbeResult[], docker: boolean): { verdict: "online" | "filtered" | "offline"; recommend: string } {
  const ok = (n: string) => rows.find((r) => r.name === n)?.ok;
  const internet = ok("internet") || ok("dns");
  const supply = ok("dns") && (ok("dockerhub") || ok("ghcr")) && ok("npm"); // can clone + pull + build
  if (internet && supply) return { verdict: "online", recommend: "Install normally — the target can reach GitHub + the registries directly." };
  if (internet) return { verdict: "filtered", recommend: "The target has some egress but GitHub/registries/npm are blocked. Bridge them through the MCP host: net_bridge action:up, then install. (Fallback: an offline bundle.)" };
  return { verdict: "offline", recommend: `No internet egress from the target. ${docker ? "Bridge its egress through the MCP host (net_bridge action:up) and install" : "Bridge via net_bridge (it can also deliver Docker), or use an offline bundle"} — the MCP host carries the internet.` };
}

export const networkTools: ToolDef[] = [
  {
    name: "net_probe",
    title: "Probe the target's internet connectivity",
    description:
      "From the TARGET server, test what an install needs to reach: the internet, GitHub, Docker Hub/GHCR, " +
      "the apt + npm mirrors — plus whether Docker + git are installed. Returns a verdict (online / filtered / " +
      "offline) and what to do (install normally, bridge egress via net_bridge, or use an offline bundle). Read-only.",
    schema: { server: serverParam, timeoutSeconds: z.number().int().min(2).max(30).default(6) },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; timeoutSeconds: number };
      return withSession(deps, a.server, async (s, srv) => {
        const probes = TARGETS.map((t) => `n=${t.name}; if timeout ${a.timeoutSeconds} bash -c 'exec 3<>/dev/tcp/${t.host}/${t.port}' 2>/dev/null; then echo "$n OK"; else echo "$n NO"; fi`).join("; ");
        const r = await s.exec(`${probes}; command -v docker >/dev/null 2>&1 && echo 'docker yes' || echo 'docker no'; command -v git >/dev/null 2>&1 && echo 'git yes' || echo 'git no'`, { timeoutMs: (a.timeoutSeconds * TARGETS.length + 10) * 1000 });
        const lines = r.stdout.trim().split("\n").map((l) => l.trim());
        const rows: ProbeResult[] = TARGETS.map((t) => ({ name: t.name, target: `${t.host}:${t.port}`, ok: lines.includes(`${t.name} OK`) }));
        const docker = lines.includes("docker yes");
        const git = lines.includes("git yes");
        const { verdict, recommend } = summarizeProbe(rows, docker);
        const table = TARGETS.map((t) => `  ${rows.find((x) => x.name === t.name)!.ok ? "✓" : "✗"} ${t.name.padEnd(10)} ${t.host}:${t.port}  (${t.why})`).join("\n");
        return [
          `# Connectivity — ${srv.name}  → ${verdict.toUpperCase()}`,
          table,
          `  ${docker ? "✓" : "✗"} docker installed   ·   ${git ? "✓" : "✗"} git installed`,
          ``,
          `→ ${recommend}`,
        ].join("\n");
      });
    },
  },

  {
    name: "net_bridge",
    title: "Bridge the target's internet through the MCP host",
    description:
      "Give an intranet-only target egress by tunnelling it through the MCP host's internet: opens a reverse SSH " +
      "proxy and points the target's apt + docker daemon + git + shell env at it, so a normal install reaches " +
      "GitHub/registries/mirrors. action:up sets it up + verifies GitHub/Docker reachability; action:down tears it " +
      "all down (restores direct); action:status reports it. Run up → install → down. The MCP must have internet.",
    schema: {
      server: serverParam,
      action: z.enum(["up", "down", "status"]).describe("up = open + configure; down = tear down + restore; status = report"),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; action: "up" | "down" | "status" };
      const srv = deps.resolve(a.server);

      if (a.action === "status") {
        const t = activeTunnel(srv.name);
        if (!t) return `No bridge active for ${srv.name}. Open one with net_bridge action:up (then install, then action:down).`;
        return withSession(deps, a.server, async (s) => {
          const v = await s.exec(`https_proxy=http://127.0.0.1:${t.proxyPort} curl -fsS -o /dev/null -m 12 https://github.com 2>/dev/null && echo gh-ok || echo gh-no`, { timeoutMs: 20_000 });
          return `Bridge ACTIVE for ${srv.name} — target apt/docker/git proxy → 127.0.0.1:${t.proxyPort} (MCP internet). GitHub via proxy: ${v.stdout.trim()}.`;
        });
      }

      if (a.action === "down") {
        const had = activeTunnel(srv.name);
        const out = await withSession(deps, a.server, async (s) => {
          const r = await s.exec(proxyTeardownScript(), { timeoutMs: 120_000 });
          return `Removed the proxy config + restarted docker (exit ${r.code}).`;
        });
        closeTunnel(srv.name);
        return `# Bridge DOWN — ${srv.name}\n${out}\n${had ? "Tunnel closed." : "(no tunnel was open — config cleaned anyway.)"}`;
      }

      // up: open the reverse proxy (dedicated SSH connection from the MCP), then point the target at it
      let proxyPort: number;
      try { ({ proxyPort } = await openReverseProxy(srv)); }
      catch (e) { return `# Bridge FAILED to open for ${srv.name}\n${(e as Error).message}\n\nThe MCP host must reach the internet, and the target's sshd must allow remote port-forwarding (AllowTcpForwarding yes). Fallback: an offline bundle.`; }

      return withSession(deps, a.server, async (s) => {
        const cfg = await s.exec(proxyConfigScript(proxyPort), { timeoutMs: 120_000 });
        const verify = await s.exec(
          `gh=$(https_proxy=http://127.0.0.1:${proxyPort} curl -fsS -o /dev/null -m 15 https://github.com 2>/dev/null && echo ok || echo no); ` +
          `dk=$(HTTPS_PROXY=http://127.0.0.1:${proxyPort} curl -fsS -o /dev/null -m 15 https://registry-1.docker.io/v2/ 2>/dev/null && echo ok || echo no); echo "github=$gh docker=$dk"`,
          { timeoutMs: 40_000 }
        );
        const ok = /github=ok/.test(verify.stdout);
        return [
          `# Bridge ${ok ? "UP" : "PARTIAL"} — ${srv.name}`,
          `Reverse proxy on the MCP → target 127.0.0.1:${proxyPort}. Pointed apt + docker daemon + git + /etc/profile.d at it (config exit ${cfg.code}).`,
          `Reachability through the bridge: ${verify.stdout.trim()}`,
          ``,
          ok
            ? `→ The target now reaches the internet via the MCP. Install normally (adpix_install / tm_install / account_install), then run net_bridge action:down to restore direct egress.`
            : `→ GitHub still not reachable through the bridge. Check the MCP host's own internet + the target's sshd AllowTcpForwarding. Details:\n${lastLines(cfg.stdout || cfg.stderr, 8)}`,
        ].join("\n");
      });
    },
  },
];
