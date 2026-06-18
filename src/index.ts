#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realDeps } from "./deps.js";
import { allTools } from "./tools/index.js";
import { serveHttp } from "./http.js";

export const VERSION = "0.4.0";

// stdout is the stdio protocol channel — all logging goes to stderr.
const log = (...a: unknown[]) => console.error("[adpix-devops-mcp]", ...a);

export function buildServer(): McpServer {
  const server = new McpServer({ name: "adpix-devops-mcp", version: VERSION });
  for (const tool of allTools) {
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
          const text = await tool.handler(realDeps, args ?? {});
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
    await serveHttp(buildServer, { port, host, token });
    log(`HTTP mode: ${allTools.length} tools on http://${host}:${port}/mcp (auth: ${token ? "Bearer token" : "none — loopback only"})`);
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
