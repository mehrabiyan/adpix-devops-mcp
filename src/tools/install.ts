import { z } from "zod";
import { resolveCluster } from "../registry.js";
import { renderDnsPlan } from "../install/dns.js";
import { renderConnect } from "../install/connect.js";
import { DEFAULT_LAUNCH_HOSTS } from "../launch/hosts.js";
import type { ToolDef } from "./types.js";

/**
 * Installer generators surfaced as MCP tools, so an operator can regenerate the DNS plan
 * or the client-connect configs from any connected client (not only at install time).
 */
export const installTools: ToolDef[] = [
  {
    name: "dns_plan",
    title: "DNS plan for the platform",
    description:
      "Produce the exact DNS records for the platform: control-plane *.adpix.io → the VIP (un-proxied), " +
      "data-plane *.adpix.net → the CDN origin (proxied), and mcp.<domain> → the MCP host. Renders a record " +
      "table + a copy-paste BIND snippet + provider notes + dig verification commands. Reads the cluster's hosts/" +
      "VIP from the registry when a cluster exists. Plan-only — never touches a DNS provider.",
    schema: {
      cluster: z.string().optional().describe("Cluster name (for its host list + VIP). Omit to use the single cluster or the default 8 hosts."),
      mcpDomain: z.string().optional().describe("The MCP's own domain, e.g. mcp.example.com"),
      mcpHostIp: z.string().optional().describe("Public IP of the MCP host (and the control-plane fallback)"),
      vip: z.string().optional().describe("Override the cluster VIP"),
      hosts: z.array(z.string()).optional().describe("Override the host list"),
    },
    annotations: { readOnlyHint: true },
    handler: async (_deps, args) => {
      const a = args as { cluster?: string; mcpDomain?: string; mcpHostIp?: string; vip?: string; hosts?: string[] };
      let hosts = a.hosts;
      let vip = a.vip;
      if (!hosts) {
        try {
          const cl = resolveCluster(a.cluster);
          hosts = cl.hosts.length ? cl.hosts : DEFAULT_LAUNCH_HOSTS;
          vip ??= cl.vip;
        } catch {
          hosts = DEFAULT_LAUNCH_HOSTS;
        }
      }
      return renderDnsPlan({ hosts, vip, mcpDomain: a.mcpDomain, mcpHostIp: a.mcpHostIp });
    },
  },

  {
    name: "connect_configs",
    title: "Client connect configs",
    description:
      "Emit ready-to-use MCP client configs (Claude Code one-liner, Claude Desktop JSON, generic JSON, and an " +
      "SSH-tunnel variant for HTTP mode). The Bearer token is masked by default (shown as a placeholder); pass " +
      "reveal:true to inline the running service's real token — only do that into a mode-600 file, never a shared log.",
    schema: {
      url: z.string().optional().describe("Full MCP URL, e.g. https://mcp.example.com/mcp. Derived from domain+port if omitted."),
      domain: z.string().optional(),
      port: z.number().int().optional(),
      clients: z.array(z.enum(["claude-code", "claude-desktop", "generic"])).optional(),
      reveal: z.boolean().default(false).describe("Inline the real MCP_AUTH_TOKEN (default: placeholder only)"),
    },
    handler: async (_deps, args) => {
      const a = args as { url?: string; domain?: string; port?: number; clients?: ("claude-code" | "claude-desktop" | "generic")[]; reveal: boolean };
      const port = a.port ?? Number(process.env.MCP_HTTP_PORT ?? 8930);
      const url = a.url ?? (a.domain ? `https://${a.domain}/mcp` : `http://127.0.0.1:${port}/mcp`);
      const token = a.reveal ? process.env.MCP_AUTH_TOKEN : undefined;
      const body = renderConnect({ name: "adpix-devops", url, token, domain: a.domain, port }, a.clients ?? ["claude-code"], { reveal: a.reveal });
      return a.reveal ? body : body + `\n\n(token masked — the real token lives in /etc/adpix-devops-mcp/env; pass reveal:true to inline it into a mode-600 file.)`;
    },
  },
];
