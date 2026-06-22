import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { JobEngine, type JobEvent } from "../src/panel/engine.js";
import { loadJobs, saveJobs, redactArgs, jobsPath, type JobRecord } from "../src/panel/store.js";
import { observedDeps } from "../src/panel/observed-deps.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ToolDef } from "../src/tools/types.js";

let tmp: string; const SAVED = process.env.ADPIX_DEVOPS_HOME;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-eng-")); process.env.ADPIX_DEVOPS_HOME = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakeDeps = (): Deps => {
  const s: Session = { server: { name: "x", host: "1.1.1.1", port: 22, username: "root", adpixDir: "/opt/adpix" }, authMethod: "publickey", close: () => {}, exec: async (): Promise<ExecResult> => ({ code: 0, stdout: "ok", stderr: "" }) };
  return { resolve: () => s.server, connect: async () => s, local: async () => ({ code: 0, stdout: "ok", stderr: "" }) };
};
const tool = (over: Partial<ToolDef> = {}): ToolDef => ({ name: "fake", title: "Fake", description: "d", schema: { server: z.string().optional() }, handler: async () => "ok", ...over });
const waitDone = (e: JobEngine, id: string) => new Promise<JobRecord>((res) => e.subscribe(id, (ev) => { if (ev.type === "done" && ev.job) res(ev.job); }));

describe("engine — crash isolation", () => {
  it("a throwing handler fails the job and is ERROR-wrapped, engine keeps running", async () => {
    const e = new JobEngine(fakeDeps());
    const bad = e.enqueue(tool({ name: "boom", handler: async () => { throw new Error("kaboom"); } }), {}) as JobRecord;
    const d1 = await waitDone(e, bad.id);
    expect(d1.status).toBe("failed");
    expect(d1.error).toContain("ERROR (boom): kaboom");
    // engine still accepts + runs the next job
    const ok = e.enqueue(tool({ name: "ok" }), {}) as JobRecord;
    expect((await waitDone(e, ok.id)).status).toBe("succeeded");
  });
  it("a non-Error throw is still handled", async () => {
    const e = new JobEngine(fakeDeps());
    const j = e.enqueue(tool({ handler: async () => { throw "string-error"; } }), {}) as JobRecord;
    expect((await waitDone(e, j.id)).status).toBe("failed");
  });
});

describe("engine — cancellation", () => {
  it("cancels a queued job before it runs", async () => {
    const e = new JobEngine(fakeDeps(), 1);
    let gate: () => void; const block = new Promise<void>((r) => (gate = r));
    const a = e.enqueue(tool({ name: "a", handler: async () => { await block; return "a"; } }), { server: "s1" }) as JobRecord;
    const b = e.enqueue(tool({ name: "b" }), { server: "s2" }) as JobRecord; // queued behind concurrency 1
    await sleep(20);
    expect(e.cancel(b.id)).toBe(true);
    expect(e.get(b.id)!.status).toBe("canceled");
    gate!(); await waitDone(e, a.id);
  });
  it("aborts a running job mid-exec (observed-deps signal)", async () => {
    const e = new JobEngine(fakeDeps());
    let gate: () => void; const block = new Promise<void>((r) => (gate = r));
    const j = e.enqueue(tool({ handler: async (deps) => { await block; await deps.local("after-cancel"); return "done"; } }), {}) as JobRecord;
    await sleep(20);
    expect(e.cancel(j.id)).toBe(true); // running → abort
    gate!();
    expect((await waitDone(e, j.id)).status).toBe("canceled");
  });
  it("cancel of unknown / terminal job returns false", async () => {
    const e = new JobEngine(fakeDeps());
    expect(e.cancel("nope")).toBe(false);
    const j = e.enqueue(tool(), {}) as JobRecord;
    await waitDone(e, j.id);
    expect(e.cancel(j.id)).toBe(false);
  });
});

describe("engine — concurrency + mutex", () => {
  it("serializes same-target jobs, parallelizes different targets", async () => {
    const e = new JobEngine(fakeDeps(), 2);
    let active = 0, maxActive = 0; const gates: (() => void)[] = [];
    const t = (n: string) => tool({ name: n, handler: async () => { active++; maxActive = Math.max(maxActive, active); await new Promise<void>((r) => gates.push(r)); active--; return n; } });
    // same target → mutex → only 1 at a time despite concurrency 2
    const a = e.enqueue(t("a"), { server: "same" }) as JobRecord;
    const b = e.enqueue(t("b"), { server: "same" }) as JobRecord;
    await sleep(30);
    expect(gates.length).toBe(1); // only one running
    gates.forEach((g) => g()); gates.length = 0; await sleep(20); gates.forEach((g) => g());
    await Promise.all([waitDone(e, a.id), waitDone(e, b.id)]);
    expect(maxActive).toBe(1);
    // different targets → run in parallel
    active = 0; maxActive = 0; gates.length = 0;
    const c = e.enqueue(t("c"), { server: "x" }) as JobRecord;
    const d = e.enqueue(t("d"), { server: "y" }) as JobRecord;
    await sleep(30);
    expect(gates.length).toBe(2);
    gates.forEach((g) => g());
    await Promise.all([waitDone(e, c.id), waitDone(e, d.id)]);
    expect(maxActive).toBe(2);
  });
  it("dedupes by idempotency key while in flight", async () => {
    const e = new JobEngine(fakeDeps(), 1);
    let gate: () => void; const block = new Promise<void>((r) => (gate = r));
    const a = e.enqueue(tool({ handler: async () => { await block; return "a"; } }), {}, { idempotencyKey: "k" }) as JobRecord;
    const b = e.enqueue(tool(), {}, { idempotencyKey: "k" }) as JobRecord;
    expect(b.id).toBe(a.id);
    gate!(); await waitDone(e, a.id);
  });
  it("validation + confirm gates reject before enqueue", () => {
    const e = new JobEngine(fakeDeps());
    expect(e.enqueue(tool({ schema: { name: z.string() } }), {})).toHaveProperty("error"); // missing required
    expect(e.enqueue(tool({ annotations: { destructiveHint: true } }), {})).toHaveProperty("error"); // no confirm
  });
});

describe("engine — persistence + recovery", () => {
  it("reconciles in-flight jobs to interrupted on boot", () => {
    saveJobs([{ id: "z", tool: "x", args: {}, status: "running", key: "_", createdAt: "t", logTail: [] }, { id: "q", tool: "x", args: {}, status: "queued", key: "_", createdAt: "t", logTail: [] }]);
    const e = new JobEngine(fakeDeps());
    expect(e.get("z")!.status).toBe("interrupted");
    expect(e.get("q")!.status).toBe("interrupted");
  });
  it("caps the in-memory log tail under a flood", async () => {
    const e = new JobEngine(fakeDeps());
    const j = e.enqueue(tool({ handler: async (deps) => { for (let i = 0; i < 5000; i++) await deps.local(`line ${i}`); return "ok"; } }), {}) as JobRecord;
    const done = await waitDone(e, j.id);
    expect(done.logTail.length).toBeLessThanOrEqual(2000);
  });
});

describe("observed-deps", () => {
  it("redacts secrets in streamed log lines", async () => {
    const lines: string[] = [];
    const obs = observedDeps(fakeDeps(), (l) => lines.push(l), new AbortController().signal);
    await obs.local("echo MCP_AUTH_TOKEN=supersecret123");
    expect(lines.join("\n")).not.toContain("supersecret123");
    expect(lines.join("\n")).toContain("[redacted]");
  });
  it("throws 'canceled' once the signal is aborted", async () => {
    const ac = new AbortController(); ac.abort();
    const obs = observedDeps(fakeDeps(), () => {}, ac.signal);
    await expect(obs.local("anything")).rejects.toThrow(/canceled/);
  });
});

describe("store — corruption + secrets", () => {
  it("returns [] for a corrupt or missing jobs.json", () => {
    expect(loadJobs()).toEqual([]); // missing
    fs.writeFileSync(jobsPath(), "{ this is not json");
    expect(loadJobs()).toEqual([]);
    fs.writeFileSync(jobsPath(), JSON.stringify({ version: 2, jobs: "x" }));
    expect(loadJobs()).toEqual([]); // wrong shape
  });
  it("redactArgs masks secret-keyed values only", () => {
    const r = redactArgs({ host: "1.2.3.4", purgeToken: "abc", s3SecretKey: "x", privateKeyPath: "/k", port: 22 });
    expect(r.host).toBe("1.2.3.4"); expect(r.port).toBe(22);
    expect(r.purgeToken).toBe("[redacted]"); expect(r.s3SecretKey).toBe("[redacted]");
  });
  it("persists mode 600 and caps history", () => {
    const many: JobRecord[] = Array.from({ length: 300 }, (_, i) => ({ id: String(i), tool: "t", args: {}, status: "succeeded", key: "_", createdAt: "t", logTail: Array.from({ length: 500 }, (_, j) => `l${j}`) }));
    saveJobs(many);
    expect((fs.statSync(jobsPath()).mode & 0o777)).toBe(0o600);
    const back = loadJobs();
    expect(back.length).toBe(200); // capped
    expect(back[0].logTail.length).toBeLessThanOrEqual(120);
  });
});
