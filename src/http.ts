import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Remote-hosting mode: Streamable HTTP transport on /mcp, guarded by a Bearer
 * token, stateless (a fresh McpServer per request — fine for a tools-only
 * server and immune to session bookkeeping bugs). TLS is terminated by Caddy
 * in front (scripts/install-server.sh sets that up), so the default bind is
 * loopback.
 */

export interface HttpOpts {
  port: number;
  host: string;
  /** Required unless binding loopback. Compared in constant time. */
  token: string;
}

/** Constant-time Bearer-token check (hash both sides to erase length signal). */
export function tokenOk(authHeader: string | undefined, token: string): boolean {
  if (!token) return true; // loopback-only deployments may run tokenless
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  const presented = createHash("sha256").update(authHeader.slice(7)).digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(presented, expected);
}

const MAX_BODY = 8 * 1024 * 1024;

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function deny(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    "content-type": "application/json",
    ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
  });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export function serveHttp(buildServer: () => McpServer, opts: HttpOpts): Promise<Server> {
  const httpServer = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];

    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (path !== "/mcp") {
      deny(res, 404, "not found — the MCP endpoint is /mcp");
      return;
    }
    if (!tokenOk(req.headers.authorization, opts.token)) {
      deny(res, 401, "unauthorized: send Authorization: Bearer <MCP_AUTH_TOKEN>");
      return;
    }
    if (req.method !== "POST") {
      // Stateless mode: no SSE notification stream, no sessions to delete.
      deny(res, 405, "method not allowed — POST JSON-RPC messages to /mcp");
      return;
    }

    try {
      const body = await readJson(req);
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        deny(res, 400, err instanceof Error ? err.message : "bad request");
      }
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, () => resolve(httpServer));
  });
}
