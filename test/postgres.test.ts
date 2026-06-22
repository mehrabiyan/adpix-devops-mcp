import { describe, expect, it } from "vitest";
import { recommendSettings, mbToPg, defaultBudgetMB } from "../src/postgres/tune.js";
import type { Deps } from "../src/deps.js";
import type { ServerConfig } from "../src/registry.js";
import type { ExecResult, Session } from "../src/ssh.js";
import { allTools } from "../src/tools/index.js";

const SEP = "\u001f";
const row = (...f: string[]) => f.join(SEP);

const tool = (name: string) => {
  const t = allTools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};

type Responder = [RegExp, Partial<ExecResult> | ((cmd: string) => Partial<ExecResult>)];
function fakeDeps(responses: Responder[]) {
  const calls: string[] = [];
  const server: ServerConfig = { name: "prod", host: "203.0.113.7", port: 22, username: "root", adpixDir: "/opt/adpix" };
  const session: Session = {
    server, authMethod: "publickey", close: () => {},
    exec: async (cmd: string) => {
      calls.push(cmd);
      for (const [re, res] of responses) {
        if (re.test(cmd)) return { code: 0, stdout: "", stderr: "", ...(typeof res === "function" ? res(cmd) : res) };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { deps: { resolve: () => server, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) } as Deps, calls };
}

const INSTALLED: Responder = [/test -d .*\.git.* && echo yes/, { stdout: "yes" }];
const ENV: Responder[] = [
  [/POSTGRES_USER/, { stdout: "sovereign" }],
  [/POSTGRES_DB/, { stdout: "sovereign" }],
];

// ---------------------------------------------------------------- tune math
describe("postgres tune model", () => {
  it("mbToPg formats sizes", () => {
    expect(mbToPg(1536)).toBe("1536MB");
    expect(mbToPg(2048)).toBe("2GB");
    expect(mbToPg(1024)).toBe("1GB");
    expect(mbToPg(256)).toBe("256MB");
  });

  it("recommendSettings follows the pgtune ratios", () => {
    const recs = recommendSettings({ memoryBudgetMB: 8192, cores: 4, maxConnections: 100, diskType: "ssd" });
    const byKey = Object.fromEntries(recs.map((r) => [r.key, r]));
    expect(byKey.shared_buffers.value).toBe("2GB"); // 8192/4
    expect(byKey.effective_cache_size.value).toBe("6GB"); // 8192*3/4
    expect(byKey.random_page_cost.value).toBe("1.1"); // ssd
    expect(byKey.effective_io_concurrency.value).toBe("200"); // ssd
    expect(byKey.max_worker_processes.value).toBe("4"); // cores
  });

  it("marks the right settings as needing a restart", () => {
    const recs = recommendSettings({ memoryBudgetMB: 4096, cores: 2, maxConnections: 100, diskType: "ssd" });
    const restart = recs.filter((r) => r.needsRestart).map((r) => r.key).sort();
    expect(restart).toEqual(["max_connections", "max_worker_processes", "shared_buffers", "wal_buffers"]);
  });

  it("hdd profile raises random_page_cost", () => {
    const recs = recommendSettings({ memoryBudgetMB: 2048, cores: 2, maxConnections: 50, diskType: "hdd" });
    expect(recs.find((r) => r.key === "random_page_cost")!.value).toBe("4");
  });

  it("keeps work_mem at a 4MB floor for tiny budgets", () => {
    const recs = recommendSettings({ memoryBudgetMB: 256, cores: 1, maxConnections: 100, diskType: "ssd" });
    expect(recs.find((r) => r.key === "work_mem")!.value).toBe("4MB");
  });

  it("defaultBudgetMB reserves RAM for ClickHouse when co-located", () => {
    expect(defaultBudgetMB(8192, true)).toBe(2048); // 25%
    expect(defaultBudgetMB(8192, false)).toBe(Math.round(8192 * 0.7));
    expect(defaultBudgetMB(100, true)).toBe(256); // floor
  });
});

// ---------------------------------------------------------------- registration
describe("postgres tools registered", () => {
  it("exposes the full DBA surface and the suite total is 71", () => {
    const names = allTools.map((t) => t.name);
    for (const n of ["pg_health", "pg_tune", "pg_optimize", "pg_harden", "pg_backup", "pg_restore_db", "pg_replication", "pg_redeploy"])
      expect(names).toContain(n);
    expect(new Set(names).size).toBe(names.length);
    expect(allTools.length).toBe(71);
  });
});

// ---------------------------------------------------------------- pg_health
describe("pg_health", () => {
  it("explains when AdPix isn't installed", async () => {
    const { deps } = fakeDeps([[/test -d .*\.git.* && echo yes/, { stdout: "no" }]]);
    expect(await tool("pg_health").handler(deps, {})).toContain("install it first");
  });

  it("renders a healthy primary snapshot", async () => {
    const { deps } = fakeDeps([
      INSTALLED, ...ENV,
      [/blks_hit/, { stdout: row("PostgreSQL 17.2", "120 MB", "12", "100", "2", "0", "1", "99.50", "f", "0", "3") }],
      [/ORDER BY pg_total_relation_size\(relid\) DESC/, { stdout: row("site_users", "40 MB", "100000", "500", "2026-06-15 03:00") }],
      [/interval '30 seconds'/, { stdout: "" }],
      [/FROM pg_stat_replication/, { stdout: "" }],
    ]);
    const out = await tool("pg_health").handler(deps, {});
    expect(out).toContain("HEALTHY");
    expect(out).toContain("PostgreSQL 17.2");
    expect(out).toContain("PRIMARY — no replicas");
    expect(out).toContain("site_users");
  });

  it("flags trouble (blocked sessions, low cache, wraparound)", async () => {
    const { deps } = fakeDeps([
      INSTALLED, ...ENV,
      [/blks_hit/, { stdout: row("PostgreSQL 17.2", "9 GB", "95", "100", "40", "3", "8", "88.0", "f", "2", "60") }],
      [/ORDER BY pg_total_relation_size\(relid\) DESC/, { stdout: "" }],
      [/interval '30 seconds'/, { stdout: row("8123", "00:02:10", "active", "SELECT ...") }],
      [/FROM pg_stat_replication/, { stdout: "" }],
    ]);
    const out = await tool("pg_health").handler(deps, {});
    expect(out).toContain("NEEDS ATTENTION");
    expect(out).toMatch(/blocked/);
    expect(out).toMatch(/cache hit ratio 88/);
    expect(out).toMatch(/wraparound/);
  });
});

// ---------------------------------------------------------------- pg_tune
describe("pg_tune", () => {
  const hostAndSettings: Responder[] = [
    [/nproc/, { stdout: "4\n8192" }],
    [/FROM pg_settings WHERE name IN/, { stdout: `${row("shared_buffers", "128MB")}\n${row("work_mem", "4MB")}` }],
  ];

  it("dry-run shows the diff and changes nothing", async () => {
    const { deps, calls } = fakeDeps([INSTALLED, ...ENV, ...hostAndSettings]);
    const out = await tool("pg_tune").handler(deps, { maxConnections: 100, diskType: "ssd", coLocated: true, apply: false });
    expect(out).toContain("Postgres tuning");
    expect(out).toContain("512MB"); // shared_buffers = 25% of 2GB budget
    expect(out).toContain("co-located with ClickHouse");
    expect(out).toContain("Dry-run");
    expect(calls.some((c) => c.includes("ALTER SYSTEM"))).toBe(false);
  });

  it("apply issues ALTER SYSTEM + reload and flags restart-needed settings", async () => {
    const { deps, calls } = fakeDeps([INSTALLED, ...ENV, ...hostAndSettings, [/ALTER SYSTEM SET/, { code: 0 }]]);
    const out = await tool("pg_tune").handler(deps, { maxConnections: 100, diskType: "ssd", coLocated: true, apply: true });
    expect(out).toContain("Applied via ALTER SYSTEM");
    expect(out).toMatch(/need a restart.*shared_buffers/);
    expect(calls.some((c) => c.includes("ALTER SYSTEM SET shared_buffers"))).toBe(true);
    expect(calls.some((c) => c.includes("pg_reload_conf"))).toBe(true);
  });
});

// ---------------------------------------------------------------- pg_harden
describe("pg_harden", () => {
  const audit: Responder[] = [
    [/SHOW password_encryption/, { stdout: "scram-sha-256" }],
    [/SHOW ssl/, { stdout: "off" }],
    [/SHOW log_connections/, { stdout: "off" }],
    [/SHOW log_min_duration_statement/, { stdout: "-1" }],
    [/SHOW idle_in_transaction_session_timeout/, { stdout: "0" }],
    [/rolsuper/, { stdout: "sovereign" }],
    [/rolpassword IS NULL/, { stdout: "" }],
    [/has_schema_privilege/, { stdout: "f" }],
    [/ps --format.*postgres/, { stdout: "" }],
  ];

  it("audits and stays read-only on dry-run", async () => {
    const { deps, calls } = fakeDeps([INSTALLED, ...ENV, ...audit]);
    const out = await tool("pg_harden").handler(deps, { apply: false });
    expect(out).toContain("Postgres hardening");
    expect(out).toMatch(/PASS .*scram-sha-256/);
    expect(out).toMatch(/WARN .*log_connections off/);
    expect(out).toContain("Dry-run");
    expect(calls.some((c) => c.includes("ALTER SYSTEM"))).toBe(false);
  });

  it("apply runs the hardening statements", async () => {
    const { deps, calls } = fakeDeps([INSTALLED, ...ENV, ...audit, [/ALTER SYSTEM SET password_encryption/, { code: 0 }]]);
    const out = await tool("pg_harden").handler(deps, { apply: true });
    expect(out).toContain("Applied");
    expect(calls.some((c) => c.includes("idle_in_transaction_session_timeout"))).toBe(true);
  });
});

// ---------------------------------------------------------------- pg_backup
describe("pg_backup", () => {
  it("dumps, verifies and reports", async () => {
    const { deps } = fakeDeps([
      INSTALLED, ...ENV,
      [/pg_dump .*-Fc/, { code: 0, stdout: "OK backups/pg-20260615-030000\n12M	backups/pg-20260615-030000" }],
      [/manifest\.txt/, { stdout: "42" }],
    ]);
    const out = await tool("pg_backup").handler(deps, {});
    expect(out).toContain("Verified Postgres backup");
    expect(out).toContain("42 archive entries");
  });
});

// ---------------------------------------------------------------- pg_restore_db
describe("pg_restore_db", () => {
  it("refuses without confirm", async () => {
    const { deps, calls } = fakeDeps([]);
    expect(await tool("pg_restore_db").handler(deps, { dumpPath: "backups/pg-x/sovereign.dump", confirm: false })).toContain("REFUSED");
    expect(calls).toHaveLength(0);
  });

  it("lists available dumps when the path is missing", async () => {
    const { deps } = fakeDeps([
      INSTALLED, ...ENV,
      [/test -f .*nope.* && echo yes/, { stdout: "no" }],
      [/ls -1t .*backups\/pg-/, { stdout: "/opt/adpix/backups/pg-20260615-030000/sovereign.dump" }],
    ]);
    const out = await tool("pg_restore_db").handler(deps, { dumpPath: "backups/nope/x.dump", confirm: true });
    expect(out).toContain("not found");
    expect(out).toContain("pg-20260615-030000");
  });
});

// ---------------------------------------------------------------- pg_replication
describe("pg_replication", () => {
  it("status of a standalone primary", async () => {
    const { deps } = fakeDeps([
      INSTALLED, ...ENV,
      [/pg_is_in_recovery/, { stdout: "f" }],
      [/FROM pg_stat_replication/, { stdout: "" }],
      [/pg_replication_slots WHERE slot_type/, { stdout: "" }],
    ]);
    const out = await tool("pg_replication").handler(deps, { mode: "status", replicaCIDR: "10.0.0.0/8", slotName: "replica1" });
    expect(out).toContain("is a PRIMARY");
    expect(out).toContain("No standbys");
  });

  it("prepare-primary dry-run prints the plan", async () => {
    const { deps, calls } = fakeDeps([INSTALLED, ...ENV, [/pg_is_in_recovery/, { stdout: "f" }]]);
    const out = await tool("pg_replication").handler(deps, { mode: "prepare-primary", replicaCIDR: "10.1.0.0/16", slotName: "replica1", apply: false });
    expect(out).toMatch(/wal_level/);
    expect(out).toContain("10.1.0.0/16");
    expect(calls.some((c) => c.includes("ALTER SYSTEM"))).toBe(false);
  });

  it("replica-steps prints pg_basebackup", async () => {
    const { deps } = fakeDeps([INSTALLED, ...ENV, [/pg_is_in_recovery/, { stdout: "f" }]]);
    const out = await tool("pg_replication").handler(deps, { mode: "replica-steps", replicaCIDR: "10.0.0.0/8", slotName: "replica1" });
    expect(out).toContain("pg_basebackup");
    expect(out).toContain("--slot=replica1");
  });

  it("promote requires confirm on a standby", async () => {
    const { deps } = fakeDeps([INSTALLED, ...ENV, [/pg_is_in_recovery/, { stdout: "t" }]]);
    const out = await tool("pg_replication").handler(deps, { mode: "promote", replicaCIDR: "10.0.0.0/8", slotName: "replica1", confirm: false });
    expect(out).toContain("REFUSED");
  });
});

// ---------------------------------------------------------------- pg_redeploy
describe("pg_redeploy", () => {
  it("upgrade-plan is advisory and runs nothing", async () => {
    const { deps, calls } = fakeDeps([INSTALLED, ...ENV]);
    const out = await tool("pg_redeploy").handler(deps, { action: "upgrade-plan", skipBackup: false });
    expect(out).toContain("upgrade plan");
    expect(out).toContain("dump & restore");
    expect(calls.some((c) => c.includes("restart") || c.includes("force-recreate"))).toBe(false);
  });

  it("restart backs up first, restarts, waits for ready, health-gates", async () => {
    const { deps, calls } = fakeDeps([
      INSTALLED, ...ENV,
      [/pg_dump .*-Fc/, { code: 0, stdout: "backed up to backups/pg-x" }],
      [/restart postgres/, { code: 0, stdout: "Restarting postgres" }],
      [/pg_isready/, { stdout: "ready" }],
      [/for i in \$\(seq 1 \d+\); do code=/, { code: 0, stdout: "healthy after ~5s" }],
    ]);
    const out = await tool("pg_redeploy").handler(deps, { action: "restart", skipBackup: false });
    expect(out).toContain("Postgres restart");
    expect(out).toContain("ready");
    expect(calls.some((c) => c.includes("pg_dump"))).toBe(true); // backed up first
  });

  it("reload is zero-downtime and skips the backup", async () => {
    const { deps, calls } = fakeDeps([INSTALLED, ...ENV, [/pg_reload_conf/, { code: 0 }]]);
    const out = await tool("pg_redeploy").handler(deps, { action: "reload", skipBackup: false });
    expect(out).toContain("Reloaded");
    expect(calls.some((c) => c.includes("pg_dump"))).toBe(false);
  });
});
