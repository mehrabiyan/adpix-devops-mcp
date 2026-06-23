import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { runChat } from "../src/panel/chat.js";
import type { Deps } from "../src/deps.js";

const ACTOR = { role: "owner" as const, scopes: ["*"], username: "admin" };

let home: string;
beforeAll(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-chat-")); });
afterAll(() => { fs.rmSync(home, { recursive: true, force: true }); });
// pin a fresh empty registry home (no stored secret) + no env key, before every test (other test files
// mutate the shared process.env) — so the no-key path is deterministic.
beforeEach(() => { process.env.ADPIX_DEVOPS_HOME = home; delete process.env.ANTHROPIC_API_KEY; });
afterEach(() => { vi.unstubAllGlobals(); delete process.env.ANTHROPIC_API_KEY; });

function fakeDeps() {
  let connectCalled = false;
  const srv = { name: "x", host: "h", port: 22, username: "root", adpixDir: "/opt/adpix" };
  const deps = { resolve: () => srv, connect: async () => { connectCalled = true; return { server: srv, authMethod: "publickey", close: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }) }; }, local: async () => ({ code: 0, stdout: "", stderr: "" }) } as Deps;
  return { deps, connected: () => connectCalled };
}

// Mock the Anthropic API: return the queued responses in order.
function stubAnthropic(responses: { content: any[] }[]) {
  let i = 0;
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => responses[Math.min(i++, responses.length - 1)] }));
}

describe("runChat", () => {
  it("is graceful without an API key", async () => {
    const { deps } = fakeDeps();
    const r = await runChat(deps, { messages: [{ role: "user", content: "hi" }], actor: ACTOR });
    expect(r.error).toBe("no-api-key");
    expect(r.reply).toMatch(/Settings|Anthropic API key/);
  });

  it("runs a read-only tool then returns the model's reply", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    stubAnthropic([
      { content: [{ type: "tool_use", id: "t1", name: "server_list", input: {} }] },
      { content: [{ type: "text", text: "You have no servers registered yet." }] },
    ]);
    const { deps } = fakeDeps();
    const r = await runChat(deps, { messages: [{ role: "user", content: "how many servers?" }], actor: ACTOR });
    expect(r.reply).toContain("no servers");
    expect(r.steps.some((s) => s.tool === "server_list")).toBe(true);
  });

  it("never executes a destructive tool (read-only only)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    stubAnthropic([
      { content: [{ type: "tool_use", id: "t1", name: "adpix_restart", input: { server: "prod" } }] },
      { content: [{ type: "text", text: "I cannot restart from chat — run it from Servers → Restart all." }] },
    ]);
    const { deps, connected } = fakeDeps();
    const r = await runChat(deps, { messages: [{ role: "user", content: "restart prod" }], actor: ACTOR });
    expect(connected()).toBe(false); // adpix_restart was rejected, never opened a session
    expect(r.reply).toMatch(/run it from/i);
  });
});
