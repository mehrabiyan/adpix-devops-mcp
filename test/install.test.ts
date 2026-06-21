import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inspect } from "node:util";
import { defaultAnswers, validateAnswers, Secret, secretsFromEnv, type InstallAnswers } from "../src/install/answers.js";
import { buildFromEnv } from "../src/install/answers-build.js";
import { emptyJournal, loadJournal, saveJournal, setStep, setTarget, journalPath } from "../src/install/journal.js";
import { runStep, runPlan, planDryRun, type InstallStep, type InstallContext } from "../src/install/core.js";
import type { Deps } from "../src/deps.js";

let tmp: string;
const SAVED = process.env.ADPIX_DEVOPS_HOME;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-install-test-")); process.env.ADPIX_DEVOPS_HOME = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

const fakeDeps: Deps = { resolve: () => ({ name: "x" } as never), connect: async () => ({} as never), local: async () => ({ code: 0, stdout: "", stderr: "" }) };
function ctx(over: Partial<InstallContext> = {}): InstallContext {
  return { answers: defaultAnswers(), secrets: { perTarget: {} }, deps: fakeDeps, journal: emptyJournal(), log: () => {}, force: false, runtime: {}, ...over };
}
const goodAnswers = (): InstallAnswers => ({
  mcp: { domain: "mcp.example.com", port: 8930, bindHost: "127.0.0.1", tokenMode: "preserve", apiKeyMode: "preserve" },
  fleet: [{ name: "prod", host: "10.0.0.2", port: 22, username: "root", role: "standalone", adpixDir: "/opt/adpix", authorizeKey: true, bootstrapAuth: "agent" }],
  emit: { clients: ["claude-code"], dnsPlan: true },
});

// ---------------------------------------------------------------- answers
describe("install answers", () => {
  it("defaults are valid", () => expect(validateAnswers({ ...defaultAnswers(), fleet: [] }).ok).toBe(true));
  it("accepts a well-formed answers object", () => expect(validateAnswers(goodAnswers())).toEqual({ ok: true, errors: [] }));

  it("flags bad port, bad domain, duplicate + bad fleet names", () => {
    const a = goodAnswers();
    a.mcp.port = 99999;
    a.mcp.domain = "not a domain";
    a.fleet = [
      { name: "bad name", host: "", port: 0, username: "", role: "standalone", adpixDir: "/opt/adpix", authorizeKey: true, bootstrapAuth: "agent" },
      { name: "dup", host: "h", port: 22, username: "root", role: "standalone", adpixDir: "/opt/adpix", authorizeKey: true, bootstrapAuth: "agent" },
      { name: "dup", host: "h", port: 22, username: "root", role: "standalone", adpixDir: "/opt/adpix", authorizeKey: true, bootstrapAuth: "agent" },
    ];
    const r = validateAnswers(a);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/not a valid port/);
    expect(r.errors.join("\n")).toMatch(/not a valid FQDN/);
    expect(r.errors.join("\n")).toMatch(/must match/);
    expect(r.errors.join("\n")).toMatch(/duplicate fleet member name "dup"/);
  });

  it("requires a token when binding 0.0.0.0", () => {
    const a = goodAnswers();
    a.mcp.bindHost = "0.0.0.0";
    a.mcp.tokenMode = "none" as never;
    expect(validateAnswers(a).errors.join()).toMatch(/requires an auth token/);
  });

  it("launchGate ack needs a reference", () => {
    const a = goodAnswers();
    a.launchGate = { ack: true };
    expect(validateAnswers(a).errors.join()).toMatch(/requires a reference/);
  });
});

// ---------------------------------------------------------------- answers-build (wizard env -> answers)
describe("buildFromEnv (shell wizard)", () => {
  it("builds valid answers from TAB-delimited fleet records + cluster env", () => {
    const a = buildFromEnv({
      DOMAIN: "mcp.example.com", PORT: "8930",
      FLEET_RECORDS: "witness\t10.0.0.1\t22\troot\twitness\t/opt/adpix\tagent\nnode1\t10.0.0.2\t22\troot\tnode\t/opt/adpix\tpassword",
      CLUSTER_NAME: "prod", CLUSTER_VIP: "10.0.0.9",
    } as never);
    expect(a.mcp.domain).toBe("mcp.example.com");
    expect(a.mcp.bindHost).toBe("127.0.0.1");
    expect(a.fleet).toHaveLength(2);
    expect(a.fleet[0]).toMatchObject({ name: "witness", role: "witness", authorizeKey: true });
    expect(a.fleet[1]).toMatchObject({ name: "node1", role: "node", bootstrapAuth: "password" });
    expect(a.cluster).toMatchObject({ name: "prod", vip: "10.0.0.9" });
    expect(a.cluster!.hosts.length).toBeGreaterThan(0);
    expect(validateAnswers(a).ok).toBe(true);
  });
  it("HTTP mode (no domain) binds 0.0.0.0", () => {
    expect(buildFromEnv({ PORT: "8930", FLEET_RECORDS: "" } as never).mcp.bindHost).toBe("0.0.0.0");
  });
});

// ---------------------------------------------------------------- secrets
describe("Secret redaction", () => {
  it("never reveals itself except via reveal()", () => {
    const s = new Secret("super-secret-token");
    expect(s.reveal()).toBe("super-secret-token");
    expect(String(s)).toBe("***");
    expect(JSON.stringify({ token: s })).toBe('{"token":"***"}');
    expect(inspect(s)).toContain("***");
    expect(inspect({ token: s })).not.toContain("super-secret");
  });
  it("secretsFromEnv reads the known keys", () => {
    const bag = secretsFromEnv({ MCP_AUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" } as never);
    expect(bag.mcpAuthToken?.reveal()).toBe("t");
    expect(bag.anthropicApiKey?.reveal()).toBe("k");
  });
});

// ---------------------------------------------------------------- journal
describe("install journal", () => {
  it("round-trips with mode 600 and never carries secrets", () => {
    const j = emptyJournal();
    setStep(j, "host-install", "done", "healthz ok");
    setTarget(j, "prod", { verified: true, authorized: false });
    saveJournal(j);
    const loaded = loadJournal();
    expect(loaded.steps["host-install"].status).toBe("done");
    expect(loaded.targets["prod"].verified).toBe(true);
    expect((fs.statSync(journalPath()).mode & 0o777)).toBe(0o600);
    expect(JSON.stringify(loaded)).not.toMatch(/password|secret|token=/i);
  });
});

// ---------------------------------------------------------------- engine
const step = (id: string, o: Partial<InstallStep> & { done?: boolean; applyOk?: boolean; verifyOk?: boolean; soft?: boolean } = {}): InstallStep => ({
  id, title: id,
  isDone: async () => o.done ?? false,
  apply: async () => ({ ok: o.applyOk ?? true, detail: "applied", soft: o.soft }),
  verify: async () => ({ ok: o.verifyOk ?? true, detail: "verified", soft: o.soft }),
});

describe("reconcile engine", () => {
  it("skips an already-satisfied step (no apply)", async () => {
    let applied = false;
    const s: InstallStep = { id: "s", title: "s", isDone: async () => true, apply: async () => { applied = true; return { ok: true, detail: "x" }; }, verify: async () => ({ ok: true, detail: "x" }) };
    const c = ctx();
    const r = await runStep(s, c);
    expect(r.detail).toBe("already satisfied");
    expect(applied).toBe(false);
    expect(c.journal.steps["s"].status).toBe("done");
  });

  it("force re-applies even when done", async () => {
    let applied = false;
    const s: InstallStep = { id: "s", title: "s", isDone: async () => true, apply: async () => { applied = true; return { ok: true, detail: "x" }; }, verify: async () => ({ ok: true, detail: "x" }) };
    await runStep(s, ctx({ force: true }));
    expect(applied).toBe(true);
  });

  it("marks failed + aborts the plan on a hard apply failure", async () => {
    const c = ctx();
    const out = await runPlan([step("a"), step("b", { applyOk: false }), step("c")], c);
    expect(out.aborted).toBe(true);
    expect(out.results.map((r) => r.id)).toEqual(["a", "b"]); // c never ran
    expect(c.journal.steps["b"].status).toBe("failed");
    expect(loadJournal().steps["a"].status).toBe("done"); // persisted
  });

  it("continues past a SOFT (per-target) failure", async () => {
    const out = await runPlan([step("a"), step("b", { verifyOk: false, soft: true }), step("c")], ctx());
    expect(out.aborted).toBe(false);
    expect(out.results.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("dry-run reports done vs would-apply without mutating", async () => {
    const c = ctx();
    const plan = await planDryRun([step("a", { done: true }), step("b", { done: false })], c);
    expect(plan).toEqual([{ id: "a", title: "a", done: true }, { id: "b", title: "b", done: false }]);
    expect(Object.keys(c.journal.steps)).toHaveLength(0); // nothing journaled
  });
});
