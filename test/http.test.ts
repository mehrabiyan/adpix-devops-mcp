import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { serveHttp } from "../src/http.js";
import { buildServer } from "../src/index.js";

const build = (scope?: "mcp:read" | "mcp:full") => buildServer(undefined, { scope });

describe("HTTP transport (integration)", () => {
  let server: Server;
  let base: string;
  const TOKEN = "test-token-123";

  beforeAll(async () => {
    server = await serveHttp((scope) => build(scope), { port: 0, host: "127.0.0.1", token: TOKEN });
    const addr = server.address();
    if (typeof addr === "object" && addr) base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => server.close());

  const rpc = (body: unknown, token?: string) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it("serves /healthz without auth", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
  });

  it("rejects /mcp without the token", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(r.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, "nope");
    expect(r.status).toBe(401);
  });

  it("404s everything but /mcp and /healthz (OAuth off)", async () => {
    expect((await fetch(`${base}/authorize`)).status).toBe(404);
    expect((await fetch(`${base}/.well-known/oauth-authorization-server`)).status).toBe(404);
  });

  it("completes initialize + tools/list with the static token (full scope)", async () => {
    const init = await rpc(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      TOKEN
    );
    expect(init.status).toBe(200);
    expect(await init.text()).toContain("adpix-devops-mcp");

    const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, TOKEN);
    const body = await list.text();
    for (const name of ["adpix_install", "cicd_enable", "ai_fix", "pg_health", "capacity_plan"]) {
      expect(body).toContain(name);
    }
  });
});
