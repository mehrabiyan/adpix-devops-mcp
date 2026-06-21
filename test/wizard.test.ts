import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { guard, constTimeEq, newToken, isLoopback } from "../src/wizard/guard.js";
import { serveWizard, type WizardDeps, type WizardHandle } from "../src/wizard/server.js";

// ---------------------------------------------------------------- guard (pure)
describe("wizard guard (security controls)", () => {
  const T = "a".repeat(64);
  const base = (over: Partial<{ method: string; path: string; headers: Record<string, string | undefined> }> = {}) =>
    guard({ method: "POST", path: "/api/finish", headers: { host: "127.0.0.1:8931", "x-adpix-token": T, "content-type": "application/json", ...over.headers }, ...over }, T, 8931);

  it("rejects a non-allowlisted Host (DNS-rebind guard)", () => {
    expect(base({ headers: { host: "evil.com:8931", "x-adpix-token": T, "content-type": "application/json" } }).status).toBe(421);
    expect(base({ headers: { host: "127.0.0.1:9999", "x-adpix-token": T, "content-type": "application/json" } }).status).toBe(421);
  });
  it("allows GET / without a token but requires it for /api/*", () => {
    expect(guard({ method: "GET", path: "/", headers: { host: "localhost:8931" } }, T, 8931).ok).toBe(true);
    expect(guard({ method: "POST", path: "/api/finish", headers: { host: "127.0.0.1:8931", "content-type": "application/json" } }, T, 8931).status).toBe(401);
  });
  it("rejects a wrong token (constant-time)", () => {
    expect(base({ headers: { host: "127.0.0.1:8931", "x-adpix-token": "b".repeat(64), "content-type": "application/json" } }).status).toBe(401);
  });
  it("rejects a cross-origin request + a cross-site Sec-Fetch", () => {
    expect(base({ headers: { host: "127.0.0.1:8931", "x-adpix-token": T, "content-type": "application/json", origin: "http://evil.com" } }).status).toBe(403);
    expect(base({ headers: { host: "127.0.0.1:8931", "x-adpix-token": T, "content-type": "application/json", "sec-fetch-site": "cross-site" } }).status).toBe(403);
  });
  it("rejects a non-JSON mutation", () => {
    expect(base({ headers: { host: "127.0.0.1:8931", "x-adpix-token": T, "content-type": "text/plain" } }).status).toBe(415);
  });
  it("accepts a well-formed same-origin JSON API call", () => {
    expect(base({ headers: { host: "127.0.0.1:8931", "x-adpix-token": T, "content-type": "application/json", origin: "http://127.0.0.1:8931", "sec-fetch-site": "same-origin" } }).ok).toBe(true);
  });
  it("constTimeEq + isLoopback basics", () => {
    expect(constTimeEq("x", "x")).toBe(true);
    expect(constTimeEq("x", "y")).toBe(false);
    expect(constTimeEq("", "")).toBe(false);
    expect(newToken()).toHaveLength(64);
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
  });
});

// ---------------------------------------------------------------- server (integration)
describe("wizard server", () => {
  let handle: WizardHandle | undefined;
  afterEach(() => handle?.close());

  const fakeDeps: WizardDeps = {
    sshTest: async () => ({ reachable: true, fingerprint: "SHA256:abc", detail: "Linux" }),
    finish: async () => ({ verdict: "READY", dns: "dns", connect: "connect", verify: "verify" }),
  };

  async function start(): Promise<{ port: number; token: string }> {
    handle = serveWizard({ port: 0, deps: fakeDeps, idleMs: 60_000, maxLifeMs: 60_000 });
    await once(handle.server, "listening");
    return { port: (handle.server.address() as AddressInfo).port, token: handle.token };
  }

  function req(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d, headers: res.headers }));
      });
      r.on("error", reject);
      if (body) r.write(body);
      r.end();
    });
  }

  it("refuses a non-loopback bind without TLS", () => {
    expect(() => serveWizard({ host: "0.0.0.0", deps: fakeDeps })).toThrow(/refusing to bind/);
  });

  it("serves the SPA with security headers, no token needed to load", async () => {
    const { port } = await start();
    const r = await req(port, "GET", "/", { host: `127.0.0.1:${port}` });
    expect(r.status).toBe(200);
    expect(r.body).toContain("AdPix DevOps MCP");
    expect(r.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["cache-control"]).toMatch(/no-store/);
  });

  it("rejects an API call with a bad Host (421) and without the token (401)", async () => {
    const { port, token } = await start();
    expect((await req(port, "POST", "/api/finish", { host: "evil.com:1234", "content-type": "application/json" }, "{}")).status).toBe(421);
    expect((await req(port, "POST", "/api/finish", { host: `127.0.0.1:${port}`, "content-type": "application/json" }, "{}")).status).toBe(401);
    expect((await req(port, "POST", "/api/finish", { host: `127.0.0.1:${port}`, "content-type": "application/json", "x-adpix-token": "b".repeat(64) }, "{}")).status).toBe(401);
  });

  it("runs ssh-test + finish with a valid token", async () => {
    const { port, token } = await start();
    const h = { host: `127.0.0.1:${port}`, "content-type": "application/json", "x-adpix-token": token };
    const t = await req(port, "POST", "/api/ssh-test", h, JSON.stringify({ host: "h", port: 22, username: "root", bootstrapAuth: "agent" }));
    expect(t.status).toBe(200);
    expect(JSON.parse(t.body).reachable).toBe(true);
    const f = await req(port, "POST", "/api/finish", h, JSON.stringify({ answers: {} }));
    expect(f.status).toBe(200);
    expect(JSON.parse(f.body).verdict).toBe("READY");
  });
});
