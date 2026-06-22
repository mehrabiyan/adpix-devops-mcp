import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import { servePanel } from "../src/panel/server.js";
import { totpCode } from "../src/panel/auth.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";

/**
 * End-to-end panel lifecycle through the real HTTP server: first-run setup → login (password +
 * TOTP) → session → read tool → async job → SSE stream → destructive preview→nonce→job → audit
 * chain → kill-switch. The SSH seam is faked so jobs run instantly with no network.
 */

const SRV: ServerConfig = { name: "prod", host: "10.0.0.1", port: 22, username: "root", adpixDir: "/opt/adpix" };
function benignDeps(): Deps {
  const session: Session = { server: SRV, authMethod: "publickey", close: () => {}, exec: async (): Promise<ExecResult> => ({ code: 0, stdout: "ok", stderr: "" }) };
  return { resolve: () => SRV, connect: async () => session, local: async () => ({ code: 0, stdout: "ok", stderr: "" }) };
}

let tmp: string; const SAVED = process.env.ADPIX_DEVOPS_HOME;
let server: Server; let base: string;
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-e2e-")); process.env.ADPIX_DEVOPS_HOME = tmp;
  server = await servePanel({ port: 0, host: "127.0.0.1", token: "t".repeat(64), deps: benignDeps() });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

const TOK = { "x-adpix-token": "t".repeat(64) };
const J = (h: Record<string, string> = {}) => ({ "content-type": "application/json", ...h });

describe("panel end-to-end lifecycle", () => {
  it("setup → login(TOTP) → session → job → SSE → nonce-gated destructive → audit → kill", async () => {
    // 1. fresh: token mode, no admins
    expect((await (await fetch(`${base}/api/status`)).json()).adminsExist).toBe(false);
    expect((await fetch(`${base}/api/me`, { headers: TOK })).status).toBe(200);

    // 2. first-run owner via the bootstrap token
    const setup = await (await fetch(`${base}/api/setup`, { method: "POST", headers: J(TOK), body: JSON.stringify({ username: "ali", password: "pw" }) })).json();
    expect(setup.totpSecret).toBeTruthy();
    // token now disabled
    expect((await fetch(`${base}/api/me`, { headers: TOK })).status).toBe(401);

    // 3. login with password + TOTP
    const lr = await fetch(`${base}/api/login`, { method: "POST", headers: J(), body: JSON.stringify({ username: "ali", password: "pw", totp: totpCode(setup.totpSecret) }) });
    expect(lr.status).toBe(200);
    const cookie = (lr.headers.get("set-cookie") || "").split(";")[0];
    const { csrf } = await lr.json();
    const S = (mut = false) => ({ cookie, ...(mut ? { "content-type": "application/json", "x-adpix-csrf": csrf } : {}) });
    const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    expect(me.actor.role).toBe("owner"); expect(me.mode).toBe("session");

    // 4. catalog + read-only tool inline
    expect((await (await fetch(`${base}/api/catalog`, { headers: { cookie } })).json()).tools.length).toBeGreaterThan(70);
    const ro = await (await fetch(`${base}/api/tools/health_check`, { method: "POST", headers: S(true), body: JSON.stringify({ args: {} }) })).json();
    expect(ro.result.length).toBeGreaterThan(0);

    // 5. async job → poll terminal
    const jr = await fetch(`${base}/api/jobs`, { method: "POST", headers: S(true), body: JSON.stringify({ tool: "adpix_status", args: {} }) });
    expect(jr.status).toBe(202);
    const jid = (await jr.json()).job.id;
    let status = "queued";
    for (let i = 0; i < 60 && status !== "succeeded" && status !== "failed"; i++) { await new Promise((r) => setTimeout(r, 20)); status = (await (await fetch(`${base}/api/jobs/${jid}`, { headers: { cookie } })).json()).job.status; }
    expect(["succeeded", "failed"]).toContain(status);

    // 6. SSE stream replays + sends a terminal event
    const ac = new AbortController();
    const evs: string[] = [];
    const res = await fetch(`${base}/api/jobs/${jid}/stream`, { headers: { cookie }, signal: ac.signal });
    const reader = res.body!.getReader(); const dec = new TextDecoder();
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read(); if (done) break;
      const chunk = dec.decode(value);
      for (const line of chunk.split("\n")) if (line.startsWith("data: ")) evs.push(line.slice(6));
      if (evs.some((e) => e.includes('"done"'))) break;
    }
    ac.abort();
    expect(evs.some((e) => e.includes('"done"'))).toBe(true);

    // 7. destructive needs a nonce: blocked without, allowed with preview nonce
    expect((await fetch(`${base}/api/jobs`, { method: "POST", headers: S(true), body: JSON.stringify({ tool: "pg_restore_db", args: { dumpPath: "x" } }) })).status).toBe(428);
    const pv = await (await fetch(`${base}/api/preview`, { method: "POST", headers: S(true), body: JSON.stringify({ tool: "pg_restore_db", args: { dumpPath: "x" } }) })).json();
    expect((await fetch(`${base}/api/jobs`, { method: "POST", headers: S(true), body: JSON.stringify({ tool: "pg_restore_db", args: { dumpPath: "x" }, nonce: pv.nonce }) })).status).toBe(202);

    // 8. audit chain intact + records the actor's actions
    const audit = await (await fetch(`${base}/api/admin/audit`, { headers: { cookie } })).json();
    expect(audit.chain.ok).toBe(true);
    expect(audit.entries.some((e: { tool: string }) => e.tool === "panel.login")).toBe(true);
    expect(audit.entries.some((e: { tool: string }) => e.tool === "pg_restore_db")).toBe(true);

    // 9. fleet model + db view + wizard verify drive the design screens
    const fleet = await (await fetch(`${base}/api/fleet`, { headers: { cookie } })).json();
    expect(fleet.counts).toBeTruthy();
    expect(Array.isArray(fleet.nodes)).toBe(true);
    const dbv = await (await fetch(`${base}/api/db?engine=ch`, { headers: { cookie } })).json();
    expect(dbv.engine).toBe("ch");
    expect("tuneRows" in dbv).toBe(true);
    const ver = await (await fetch(`${base}/api/wizard/verify-server`, { method: "POST", headers: S(true), body: JSON.stringify({ host: "10.0.0.9", port: 22, username: "root" }) })).json();
    expect(ver.reachable).toBe(true); // benign deps connect succeeds

    // 10. kill-switch revokes the session
    const k = await fetch(`${base}/api/admin/kill`, { method: "POST", headers: S(true), body: JSON.stringify({ on: true }) });
    expect((await k.json()).killed).toBe(true);
    expect((await fetch(`${base}/api/admin/audit`, { headers: { cookie } })).status).toBe(401);
  });

  it("serves the SPA shell + assets", async () => {
    const idx = await fetch(`${base}/`); expect(idx.status).toBe(200);
    expect(await idx.text()).toContain("AdPix Cloud");
    expect((await fetch(`${base}/app.js`)).status).toBe(200);
    expect((await fetch(`${base}/tokens.css`)).status).toBe(200);
  });
});
