#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realDeps } from "./deps.js";
import { allTools } from "./tools/index.js";

// stdio transport: stdout is the protocol channel — all logging goes to stderr.
const log = (...a: unknown[]) => console.error("[adpix-devops-mcp]", ...a);

async function main() {
  const server = new McpServer({
    name: "adpix-devops-mcp",
    version: "0.1.0",
  });

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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready — ${allTools.length} tools registered`);
}

main().catch((err) => {
  log("fatal:", err);
  process.exit(1);
});
