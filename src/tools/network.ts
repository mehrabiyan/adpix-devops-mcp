import { z } from "zod";
import { withSession } from "../deps.js";
import type { ToolDef } from "./types.js";

const serverParam = z.string().optional().describe("Target server name. Omit to use the default.");

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
];
