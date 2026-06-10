import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { serveHttp, tokenOk } from "../src/http.js";
import { buildServer } from "../src/index.js";

describe("tokenOk", () => {
  it("accepts the right bearer token", () => {
    expect(tokenOk("Bearer s3cret", "s3cret")).toBe(true);
  });
  it("rejects wrong/missing/malformed credentials", () => {
    expect(tokenOk("Bearer nope", "s3cret")).toBe(false);
    expect(tokenOk(undefined, "s3cret")).toBe(false);
    expect(tokenOk("Basic s3cret", "s3cret")).toBe(false);
    expect(tokenOk("Bearer s3cret-but-longer", "s3cret")).toBe(false);
  });
  it("token-less config (loopback mode) allows through", () => {
    expect(tokenOk(undefined, "")).toBe(true);
  });
});

describe("HTTP transport (integration)", () => {
  let server: Server;
  let base: string;
  const TOKEN = "test-token-123";

  beforeAll(async () => {
    server = await serveHttp(buildServer, { port: 0, host: "127.0.0.1", token: TOKEN });
    const addr = server.address();
    if (typeof addr === "object" && addr) base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => server.close());

  it("serves /healthz without auth", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
  });

  it("rejects /mcp without the token", async () => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(r.status).toBe(401);
  });

  it("404s everything but /mcp and /healthz", async () => {
    const r = await fetch(`${base}/other`, { method: "POST" });
    expect(r.status).toBe(404);
  });

  it("completes initialize and tools/list with the token", async () => {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
    };
    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    });
    expect(init.status).toBe(200);
    const initBody = await init.text();
    expect(initBody).toContain("adpix-devops-mcp");

    const list = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(list.status).toBe(200);
    const listBody = await list.text();
    for (const name of ["adpix_install", "cicd_enable", "ai_fix", "mcp_self_update", "watchdog_install"]) {
      expect(listBody).toContain(name);
    }
  });
});
