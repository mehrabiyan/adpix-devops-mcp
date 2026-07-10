#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realDeps, type Deps } from "./deps.js";
import { allTools } from "./tools/index.js";
import { serveHttp } from "./http.js";
import { OAuthProvider, scopeAllows, type Scope } from "./oauth.js";

export const VERSION = "0.5.0";

// stdout is the stdio protocol channel — all logging goes to stderr.
const log = (...a: unknown[]) => console.error("[adpix-devops-mcp]", ...a);

/**
 * Build the MCP server with tools registered. `deps` is the dependency seam
 * (SSH/registry/local exec) — defaults to the real implementation; integration
 * tests pass a fake. `scope` filters the exposed tools: mcp:read exposes only
 * read-only tools (for a least-privilege OAuth client); omitted/mcp:full exposes all.
 */
export function buildServer(deps: Deps = realDeps, opts: { scope?: Scope } = {}): McpServer {
  const server = new McpServer({ name: "adpix-devops-mcp", version: VERSION });
  for (const tool of allTools) {
    if (opts.scope && !scopeAllows(opts.scope, tool.annotations?.readOnlyHint === true)) continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema,
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>) => {
        try {
          const text = await tool.handler(deps, args ?? {});
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `ERROR (${tool.name}): ${msg}` }],
            isError: true,
          };
        }
      }
    );
  }
  return server;
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);

  // Web setup wizard (loopback-only; reached via an SSH tunnel). Dynamic import keeps it off the hot path.
  if (args.includes("--wizard")) {
    const { launchWizard } = await import("./wizard/launch.js");
    launchWizard();
    return;
  }

  // Web control panel (loopback-first; reached via an SSH tunnel). Phase 1 of docs/control-panel.md.
  if (args.includes("--panel")) {
    const { launchPanel } = await import("./panel/launch.js");
    const port = Number(argValue(args, "--port") ?? process.env.ADPIX_PANEL_PORT ?? 8931);
    const host = argValue(args, "--host") ?? process.env.ADPIX_PANEL_HOST ?? "127.0.0.1";
    await launchPanel({ port, host });
    return;
  }

  const httpMode = args.includes("--http") || process.env.MCP_TRANSPORT === "http";

  if (httpMode) {
    const port = Number(argValue(args, "--port") ?? process.env.MCP_HTTP_PORT ?? 8930);
    const host = argValue(args, "--host") ?? process.env.MCP_HTTP_HOST ?? "127.0.0.1";
    const token = process.env.MCP_AUTH_TOKEN ?? "";
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
    if (!token && !loopback) {
      log(`FATAL: refusing to bind ${host}:${port} without MCP_AUTH_TOKEN — that would expose root `);
      log(`access to your servers to the whole network. Set MCP_AUTH_TOKEN, or bind 127.0.0.1.`);
      process.exit(1);
    }

    // OAuth 2.1 authorization server — opt-in, for clients that require OAuth
    // (e.g. web chatbots doing dynamic client registration). Needs the public
    // URL (for absolute metadata/redirects) and the admin token (consent gate).
    let oauth: OAuthProvider | undefined;
    if (args.includes("--oauth") || process.env.MCP_OAUTH_ENABLED === "true") {
      const issuer = process.env.MCP_PUBLIC_URL ?? "";
      if (!issuer) {
        log("FATAL: OAuth needs MCP_PUBLIC_URL (e.g. https://dev.adpix.io) to form its endpoints.");
        process.exit(1);
      }
      if (!token) {
        log("FATAL: OAuth needs MCP_AUTH_TOKEN — it's the admin secret that gates the consent screen.");
        process.exit(1);
      }
      oauth = new OAuthProvider({ issuer, adminToken: token });
    }

    await serveHttp((scope) => buildServer(realDeps, { scope }), { port, host, token, oauth });
    log(
      `HTTP mode: ${allTools.length} tools on http://${host}:${port}/mcp ` +
        `(auth: ${oauth ? "OAuth + " : ""}${token ? "Bearer token" : "none — loopback only"})`
    );
    return;
  }

  const server = buildServer();
  await server.connect(new StdioServerTransport());
  log(`ready — ${allTools.length} tools registered (stdio)`);
}

// Only start when executed as the entry script (resolving the bin symlink),
// so tests can import buildServer without booting a transport.
const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === entry) {
  main().catch((err) => {
    log("fatal:", err);
    process.exit(1);
  });
}
