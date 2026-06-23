import { describe, expect, it } from "vitest";
import { allTools } from "../src/tools/index.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";

const SRV: ServerConfig = { name: "prod", host: "10.0.0.1", port: 22, username: "root", adpixDir: "/opt/adpix" };
const tool = (n: string) => { const t = allTools.find((t) => t.name === n); if (!t) throw new Error(n); return t; };

function deps(responses: [RegExp, Partial<ExecResult>][]) {
  const calls: string[] = [];
  const session: Session = {
    server: SRV, authMethod: "publickey", close: () => {},
    exec: async (cmd: string): Promise<ExecResult> => { calls.push(cmd); for (const [re, r] of responses) if (re.test(cmd)) return { code: 0, stdout: "", stderr: "", ...r }; return { code: 0, stdout: "", stderr: "" }; },
  };
  return { deps: { resolve: () => SRV, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) } as Deps, calls };
}

const steps = (s: object[]) => JSON.stringify({ steps: s });

describe("smtp_test", () => {
  it("formats a PASS report with a test send", async () => {
    const { deps: d, calls } = deps([
      [/command -v python3/, { stdout: "ok" }],
      [/python3 - <</, { stdout: steps([{ step: "DNS resolve", ok: true, detail: "smtp.x -> 1.2.3.4" }, { step: "STARTTLS", ok: true, detail: "upgraded" }, { step: "Authenticate", ok: true, detail: "login accepted" }, { step: "Send test email", ok: true, detail: "accepted for delivery to a@b.c" }]) }],
    ]);
    const out = await tool("smtp_test").handler(d, { host: "smtp.x", port: 587, security: "starttls", username: "u", password: "p", from: "f@x.com", to: "a@b.c" });
    expect(out).toContain("✓ DNS resolve");
    expect(out).toContain("✓ Send test email");
    expect(out).toMatch(/PASS — test email accepted/);
    // password is passed via env, not argv positional — and never echoed back
    expect(calls.some((c) => /SPW=/.test(c))).toBe(true);
    expect(out).not.toContain("p\n"); // no raw password leak
  });

  it("reports FAIL at the first failing step", async () => {
    const { deps: d } = deps([
      [/command -v python3/, { stdout: "ok" }],
      [/python3 - <</, { stdout: steps([{ step: "DNS resolve", ok: true, detail: "ok" }, { step: "Authenticate", ok: false, detail: "535 auth failed" }]) }],
    ]);
    const out = await tool("smtp_test").handler(d, { host: "smtp.x", port: 587, security: "starttls", username: "u", password: "bad", from: "f@x.com" });
    expect(out).toContain("✗ Authenticate");
    expect(out).toMatch(/FAIL at "Authenticate"/);
  });

  it("tells the user when python3 is missing", async () => {
    const { deps: d } = deps([[/command -v python3/, { stdout: "no" }]]);
    const out = await tool("smtp_test").handler(d, { host: "smtp.x", port: 587, security: "starttls", from: "f@x.com" });
    expect(out).toMatch(/python3 is not available/);
  });
});
