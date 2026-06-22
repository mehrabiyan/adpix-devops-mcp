import { describe, expect, it } from "vitest";
import { allTools } from "../src/tools/index.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";

const SRV: ServerConfig = { name: "node-a", host: "10.0.0.11", port: 22, username: "root", adpixDir: "/opt/adpix" };
const tool = (n: string) => { const t = allTools.find((t) => t.name === n); if (!t) throw new Error(n); return t; };

// fake deps; `head` controls the two `rev-parse --short HEAD` answers (before, after); `fail` forces a command to exit 1
function stackDeps(opts: { before?: string; after?: string; fail?: RegExp } = {}) {
  const calls: string[] = []; let shortHead = 0;
  const session: Session = {
    server: SRV, authMethod: "publickey", close: () => {},
    exec: async (cmd): Promise<ExecResult> => {
      calls.push(cmd);
      const fail = opts.fail && opts.fail.test(cmd);
      if (/test -d .*\.git/.test(cmd)) return { code: 0, stdout: "yes", stderr: "" };
      if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return { code: 0, stdout: "main", stderr: "" };
      if (/rev-parse --short HEAD/.test(cmd)) return { code: 0, stdout: (shortHead++ === 0 ? (opts.before ?? "aaa1111") : (opts.after ?? "bbb2222")), stderr: "" };
      return { code: fail ? 1 : 0, stdout: fail ? "boom" : "ok", stderr: "" };
    },
  };
  const deps: Deps = { resolve: () => SRV, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) };
  return { deps, calls };
}

describe("stack_update", () => {
  it("refuses without confirm", async () => {
    const { deps, calls } = stackDeps();
    const out = await tool("stack_update").handler(deps, { stack: "analytics", statelessOnly: true, rollbackOnFailure: true, force: false, confirm: false, timeoutSeconds: 600 });
    expect(out).toMatch(/REFUSED/);
    expect(calls).toHaveLength(0);
  });

  it("recreates ONLY stateless services (--no-deps), never the datastores", async () => {
    const { deps, calls } = stackDeps();
    const out = await tool("stack_update").handler(deps, { stack: "analytics", statelessOnly: true, rollbackOnFailure: true, force: false, confirm: true, timeoutSeconds: 600 });
    const up = calls.find((c) => /up -d/.test(c))!;
    expect(up).toMatch(/--no-deps/);
    expect(up).toMatch(/\bingest\b/); expect(up).toMatch(/\bweb\b/);
    expect(up).not.toMatch(/\bpostgres\b/); expect(up).not.toMatch(/\bclickhouse\b/);
    // no destructive volume teardown anywhere
    expect(calls.some((c) => /down\s+-v|down --volumes/.test(c))).toBe(false);
    expect(out).toMatch(/preserved/i);
    expect(out).toMatch(/postgres, clickhouse, redis/);
    expect(out).toMatch(/migrations applied/);
  });

  it("runs the migrate one-shot for analytics", async () => {
    const { deps, calls } = stackDeps();
    await tool("stack_update").handler(deps, { stack: "analytics", statelessOnly: true, rollbackOnFailure: true, force: false, confirm: true, timeoutSeconds: 600 });
    expect(calls.some((c) => /run --rm migrate/.test(c))).toBe(true);
  });

  it("rolls back the code when migrations fail (datastores untouched)", async () => {
    const { deps, calls } = stackDeps({ fail: /run --rm migrate/ });
    const out = await tool("stack_update").handler(deps, { stack: "analytics", statelessOnly: true, rollbackOnFailure: true, force: false, confirm: true, timeoutSeconds: 600 });
    expect(out).toMatch(/Migrations FAILED/);
    expect(calls.some((c) => /checkout 'aaa1111'/.test(c))).toBe(true); // reverted to `before`
  });

  it("no-ops when already up to date", async () => {
    const { deps } = stackDeps({ before: "same", after: "same" });
    const out = await tool("stack_update").handler(deps, { stack: "analytics", statelessOnly: true, rollbackOnFailure: true, force: false, confirm: true, timeoutSeconds: 600 });
    expect(out).toMatch(/already up to date/);
  });

  it("idp: recreates only the auth service, no migrate by default, DB preserved (external)", async () => {
    const { deps, calls } = stackDeps();
    const out = await tool("stack_update").handler(deps, { stack: "idp", statelessOnly: true, rollbackOnFailure: true, force: false, confirm: true, timeoutSeconds: 600, service: "auth" });
    const up = calls.find((c) => /up -d/.test(c))!;
    expect(up).toMatch(/--no-deps/); expect(up).toMatch(/\bauth\b/);
    expect(calls.some((c) => /run --rm migrate/.test(c))).toBe(false); // no migrate unless migrateCmd given
    expect(calls.some((c) => /down\s+-v/.test(c))).toBe(false);
    expect(out).toMatch(/control DB is external/);
  });

  it("idp: honors composeFile / project / service overrides + optional migrateCmd", async () => {
    const { deps, calls } = stackDeps();
    await tool("stack_update").handler(deps, { stack: "idp", statelessOnly: true, rollbackOnFailure: true, force: false, confirm: true, timeoutSeconds: 600, composeFile: "deploy/auth.yml", project: "acct", service: "account", migrateCmd: "run --rm dbmigrate" });
    expect(calls.some((c) => /-p 'acct' -f 'deploy\/auth\.yml'/.test(c))).toBe(true);
    const up = calls.find((c) => /up -d/.test(c))!;
    expect(up).toMatch(/\baccount\b/);
    expect(calls.some((c) => /run --rm dbmigrate/.test(c))).toBe(true);
  });

  it("tagmanager: stateless = api/edge/varnish/purge-bridge; no migrate; redis/minio preserved", async () => {
    const { deps, calls } = stackDeps();
    const out = await tool("stack_update").handler(deps, { stack: "tagmanager", statelessOnly: true, rollbackOnFailure: true, force: false, confirm: true, timeoutSeconds: 600 });
    const up = calls.find((c) => /up -d/.test(c))!;
    expect(up).toMatch(/--no-deps/);
    expect(up).toMatch(/\bedge\b/); expect(up).not.toMatch(/\bminio\b/); expect(up).not.toMatch(/\bredis\b/);
    expect(calls.some((c) => /run --rm migrate/.test(c))).toBe(false); // TM has no data migrations
    expect(out).toMatch(/redis, minio/);
  });

  it("backupFirst: runs the backup BEFORE the migrate", async () => {
    const { deps, calls } = stackDeps();
    const out = await tool("stack_update").handler(deps, { stack: "analytics", statelessOnly: true, rollbackOnFailure: true, force: false, confirm: true, timeoutSeconds: 600, backupFirst: true });
    const bk = calls.findIndex((c) => /backup\.sh/.test(c));
    const mg = calls.findIndex((c) => /run --rm migrate/.test(c));
    expect(bk).toBeGreaterThanOrEqual(0); expect(mg).toBeGreaterThan(bk); // backup precedes migrate
    expect(out).toMatch(/backup taken/);
  });

  it("backupFirst: a failed backup aborts before migrating", async () => {
    const { deps, calls } = stackDeps({ fail: /backup\.sh/ });
    const out = await tool("stack_update").handler(deps, { stack: "analytics", statelessOnly: true, rollbackOnFailure: true, force: false, confirm: true, timeoutSeconds: 600, backupFirst: true });
    expect(out).toMatch(/BACKUP FAILED/);
    expect(calls.some((c) => /run --rm migrate/.test(c))).toBe(false); // never migrated
  });
});

describe("stack_status", () => {
  function statusDeps(probe: (cmd: string) => string) {
    const session: Session = {
      server: SRV, authMethod: "publickey", close: () => {},
      exec: async (cmd): Promise<ExecResult> => ({ code: 0, stdout: probe(cmd), stderr: "" }),
    };
    return { resolve: () => SRV, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) } as Deps;
  }

  it("reports commit / branch / behind per stack", async () => {
    const deps = statusDeps((c) => /adpix-tagmanager/.test(c) ? "NOGIT" : "abc1234\tmain\t2\tship it");
    const out = await tool("stack_status").handler(deps, { stack: "analytics" });
    expect(out).toMatch(/analytics: abc1234 \(main\) — 2 behind origin/);
  });

  it("marks an absent checkout as not installed", async () => {
    const deps = statusDeps(() => "NOGIT");
    const out = await tool("stack_status").handler(deps, { stack: "idp" });
    expect(out).toMatch(/idp: not installed/);
  });

  it("reports all three stacks when stack is omitted", async () => {
    const deps = statusDeps(() => "aaa1111\tmain\t0\tx");
    const out = await tool("stack_status").handler(deps, {});
    expect(out).toMatch(/analytics:/); expect(out).toMatch(/tagmanager:/); expect(out).toMatch(/idp:/);
    expect(out).toMatch(/up to date/);
  });
});
