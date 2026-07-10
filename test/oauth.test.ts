import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import { OAuthProvider, b64url, safeEqual, verifyPkceS256, scopeAllows } from "../src/oauth.js";
import { serveHttp } from "../src/http.js";
import { buildServer } from "../src/index.js";

const ADMIN = "admin-token-xyz";
const tmpStore = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oauth-")), "oauth.json");
const pkce = () => {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
};

describe("oauth primitives", () => {
  it("safeEqual compares in constant time", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
  it("verifyPkceS256 matches the spec vector", () => {
    const { verifier, challenge } = pkce();
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256("wrong", challenge)).toBe(false);
    expect(verifyPkceS256("", challenge)).toBe(false);
  });
  it("scopeAllows gates by read-only", () => {
    expect(scopeAllows("mcp:read", true)).toBe(true);
    expect(scopeAllows("mcp:read", false)).toBe(false);
    expect(scopeAllows("mcp:full", false)).toBe(true);
  });
});

describe("OAuthProvider (unit)", () => {
  let p: OAuthProvider;
  let store: string;
  beforeAll(() => {
    store = tmpStore();
    p = new OAuthProvider({ issuer: "https://mcp.test/", adminToken: ADMIN, storePath: store });
  });

  it("advertises metadata with S256 + none auth", () => {
    const md = p.authServerMetadata().json as Record<string, unknown>;
    expect(md.authorization_endpoint).toBe("https://mcp.test/authorize");
    expect(md.token_endpoint).toBe("https://mcp.test/token");
    expect(md.registration_endpoint).toBe("https://mcp.test/register");
    expect(md.code_challenge_methods_supported).toEqual(["S256"]);
    expect(md.token_endpoint_auth_methods_supported).toEqual(["none"]);
    const pr = p.protectedResourceMetadata().json as Record<string, unknown>;
    expect(pr.resource).toBe("https://mcp.test/mcp");
  });

  it("registers a public client and rejects bad redirect URIs", () => {
    expect(p.register({ redirect_uris: [] }).status).toBe(400);
    expect(p.register({ redirect_uris: ["http://evil.example/cb"] }).status).toBe(400); // non-https, non-local
    const ok = p.register({ redirect_uris: ["https://app.example/cb"], client_name: "Bot" });
    expect(ok.status).toBe(201);
    expect((ok.json as { client_id: string }).client_id).toMatch(/^mcp_/);
    expect(p.register({ redirect_uris: ["http://localhost:1234/cb"] }).status).toBe(201); // localhost ok
  });

  it("runs the full authorize→token→verify flow with PKCE + scope", () => {
    const client = (p.register({ redirect_uris: ["https://app.example/cb"] }).json as { client_id: string }).client_id;
    const { verifier, challenge } = pkce();
    const q = { response_type: "code", client_id: client, redirect_uri: "https://app.example/cb", code_challenge: challenge, code_challenge_method: "S256", state: "s1", scope: "mcp:read" };

    // consent screen renders
    const cg = p.authorizeGet(q);
    expect(cg.status).toBe(200);
    expect(cg.html).toContain("admin token");
    expect(cg.html).toContain("Read-only");

    // wrong admin token → re-prompt, no code
    const bad = p.authorizePost({ ...q, admin_token: "nope", decision: "approve" });
    expect(bad.status).toBe(401);
    expect(bad.location).toBeUndefined();

    // approve with the admin token + full scope
    const good = p.authorizePost({ ...q, scope: "mcp:full", admin_token: ADMIN, decision: "approve" });
    expect(good.status).toBe(302);
    const code = new URL(good.location!).searchParams.get("code")!;
    expect(new URL(good.location!).searchParams.get("state")).toBe("s1");

    // wrong PKCE verifier fails
    expect(p.token({ grant_type: "authorization_code", code, redirect_uri: "https://app.example/cb", client_id: client, code_verifier: "wrong" }).status).toBe(400);
    // (code is single-use — that failed attempt consumed it) a fresh code:
    const g2 = p.authorizePost({ ...q, scope: "mcp:full", admin_token: ADMIN, decision: "approve" });
    const code2 = new URL(g2.location!).searchParams.get("code")!;
    const tok = p.token({ grant_type: "authorization_code", code: code2, redirect_uri: "https://app.example/cb", client_id: client, code_verifier: verifier });
    expect(tok.status).toBe(200);
    const body = tok.json as { access_token: string; refresh_token: string; scope: string; token_type: string };
    expect(body.token_type).toBe("Bearer");
    expect(body.scope).toBe("mcp:full");
    expect(p.verifyAccessToken(body.access_token)).toBe("mcp:full");
    expect(p.verifyAccessToken("garbage")).toBeNull();

    // reusing code2 now fails (single-use)
    expect(p.token({ grant_type: "authorization_code", code: code2, redirect_uri: "https://app.example/cb", client_id: client, code_verifier: verifier }).status).toBe(400);

    // refresh rotates
    const refreshed = p.token({ grant_type: "refresh_token", refresh_token: body.refresh_token, client_id: client });
    expect(refreshed.status).toBe(200);
    expect(p.verifyAccessToken((refreshed.json as { access_token: string }).access_token)).toBe("mcp:full");

    // deny → error redirect, no code
    const denied = p.authorizePost({ ...q, admin_token: ADMIN, decision: "deny" });
    expect(denied.status).toBe(302);
    expect(new URL(denied.location!).searchParams.get("error")).toBe("access_denied");
  });

  it("persists registered clients across instances", () => {
    const s = tmpStore();
    const a = new OAuthProvider({ issuer: "https://mcp.test", adminToken: ADMIN, storePath: s });
    const id = (a.register({ redirect_uris: ["https://x.example/cb"] }).json as { client_id: string }).client_id;
    const b = new OAuthProvider({ issuer: "https://mcp.test", adminToken: ADMIN, storePath: s });
    expect(b.getClient(id)).toBeTruthy();
  });
});

describe("OAuth over HTTP (integration)", () => {
  let server: Server;
  let base: string;
  const stores: string[] = [];

  beforeAll(async () => {
    const store = tmpStore();
    stores.push(store);
    const oauth = new OAuthProvider({ issuer: "https://mcp.test", adminToken: ADMIN, storePath: store });
    server = await serveHttp((scope) => buildServer(undefined, { scope }), { port: 0, host: "127.0.0.1", token: ADMIN, oauth });
    const addr = server.address();
    if (typeof addr === "object" && addr) base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => server.close());

  async function connect(scope: "mcp:read" | "mcp:full"): Promise<string> {
    const reg = await (await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://127.0.0.1/cb"], client_name: "IT" }) })).json();
    const clientId = (reg as { client_id: string }).client_id;
    const { verifier, challenge } = pkce();
    const form = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "http://127.0.0.1/cb", code_challenge: challenge, code_challenge_method: "S256", state: "z", scope, admin_token: ADMIN, decision: "approve" });
    const authz = await fetch(`${base}/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual" });
    expect(authz.status).toBe(302);
    const code = new URL(authz.headers.get("location")!).searchParams.get("code")!;
    const tok = await (await fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "http://127.0.0.1/cb", client_id: clientId, code_verifier: verifier }) })).json();
    return (tok as { access_token: string }).access_token;
  }

  const toolsList = async (accessToken: string) => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    return r.text();
  };

  it("serves discovery metadata + a 401 that points at it", async () => {
    expect((await fetch(`${base}/.well-known/oauth-protected-resource`)).status).toBe(200);
    const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect((asm as { authorization_endpoint: string }).authorization_endpoint).toContain("/authorize");
    const unauth = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("read-scope token sees only read-only tools", async () => {
    const body = await toolsList(await connect("mcp:read"));
    expect(body).toContain("pg_health"); // read-only
    expect(body).toContain("capacity_plan"); // read-only
    expect(body).not.toContain("run_command"); // destructive — hidden
    expect(body).not.toContain("adpix_install"); // mutating — hidden
  });

  it("full-scope token sees every tool", async () => {
    const body = await toolsList(await connect("mcp:full"));
    expect(body).toContain("run_command");
    expect(body).toContain("adpix_install");
    expect(body).toContain("pg_health");
  });

  it("the static admin token still works (full scope, header clients)", async () => {
    const body = await toolsList(ADMIN);
    expect(body).toContain("run_command");
  });
});
