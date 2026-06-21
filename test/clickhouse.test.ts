import { describe, expect, it } from "vitest";
import {
  recommendSettings,
  defaultBudgetMB,
  mbToBytes,
  formatBytes,
  renderServerXml,
  renderProfileXml,
} from "../src/clickhouse/tune.js";
import type { Deps } from "../src/deps.js";
import type { ServerConfig } from "../src/registry.js";
import type { ExecResult, Session } from "../src/ssh.js";
import { allTools } from "../src/tools/index.js";

/** ClickHouse output is TabSeparated. */
const trow = (...f: string[]) => f.join("\t");

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
// CH password is referenced as $CLICKHOUSE_PASSWORD in every query command, so env
// reads must be matched on the anchored `^KEY=` grep form, not a bare keyword.
const ENV: Responder[] = [
  [/\^CLICKHOUSE_USER=/, { stdout: "default" }],
  [/\^CLICKHOUSE_DB=/, { stdout: "sovereign" }],
];

// ---------------------------------------------------------------- tune math
describe("clickhouse tune model", () => {
  it("mbToBytes + formatBytes round-trip", () => {
    expect(mbToBytes(1)).toBe(1024 * 1024);
    expect(formatBytes(1073741824)).toBe("1.00 GiB");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("recommendSettings sizes the analytical profile", () => {
    const recs = recommendSettings({ memoryBudgetMB: 8000, cores: 4, diskType: "ssd" });
    const byKey = Object.fromEntries(recs.map((r) => [r.key, r]));
    expect(byKey.max_concurrent_queries.value).toBe("40"); // 10×cores
    expect(byKey.max_threads.value).toBe("4"); // cores
    expect(byKey.join_algorithm.value).toBe("auto");
    expect(byKey.max_server_memory_usage.scope).toBe("server");
    expect(byKey.max_memory_usage.scope).toBe("profile"); // per-query cap
    expect(Number(byKey.max_memory_usage.value)).toBe(mbToBytes(4000)); // ½ budget
  });

  it("marks the right settings as needing a restart", () => {
    const recs = recommendSettings({ memoryBudgetMB: 4096, cores: 2, diskType: "ssd" });
    const restart = recs.filter((r) => r.needsRestart).map((r) => r.key).sort();
    expect(restart).toEqual(["background_pool_size", "max_server_memory_usage"]);
  });

  it("defaultBudgetMB gives ClickHouse the lion's share when co-located", () => {
    expect(defaultBudgetMB(8192, true)).toBe(Math.round(8192 * 0.6)); // 60%
    expect(defaultBudgetMB(8192, false)).toBe(Math.round(8192 * 0.8)); // dedicated
    expect(defaultBudgetMB(100, true)).toBe(512); // floor
  });

  it("renders config.d + users.d drop-ins", () => {
    const recs = recommendSettings({ memoryBudgetMB: 4096, cores: 2, diskType: "ssd" });
    expect(renderServerXml(recs)).toContain("<max_server_memory_usage>");
    expect(renderServerXml(recs)).toMatch(/<clickhouse>[\s\S]*<\/clickhouse>/);
    expect(renderProfileXml(recs)).toContain("<profiles>");
    expect(renderProfileXml(recs)).toContain("<max_memory_usage>");
  });
});

// ---------------------------------------------------------------- registration
describe("clickhouse tools registered", () => {
  it("exposes the full ClickHouse DBA surface", () => {
    const names = allTools.map((t) => t.name);
    for (const n of ["ch_health", "ch_tune", "ch_optimize", "ch_harden", "ch_backup", "ch_restore_db", "ch_replication", "ch_retention", "ch_redeploy"])
      expect(names).toContain(n);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---------------------------------------------------------------- ch_health
describe("ch_health", () => {
  it("explains when AdPix isn't installed", async () => {
    const { deps } = fakeDeps([[/test -d .*\.git.* && echo yes/, { stdout: "no" }]]);
    expect(await tool("ch_health").handler(deps, {})).toContain("install it first");
  });

  it("renders a healthy single-node snapshot", async () => {
    const { deps } = fakeDeps([
      INSTALLED, ...ENV,
      [/version\(\), \(SELECT formatReadableSize/, { stdout: trow("25.3.1.1", "12.00 GiB", "240", "0", "0", "0", "0", "0", "1.20 GiB", "8589934592", "0", "0") }],
      [/ORDER BY sum\(bytes_on_disk\) DESC LIMIT 8/, { stdout: trow("events_local", "9.00 GiB", "5000000", "12", "8.1") }],
      [/HAVING count\(\)>200/, { stdout: "" }],
      [/FROM system\.merges ORDER BY elapsed/, { stdout: "" }],
    ]);
    const out = await tool("ch_health").handler(deps, {});
    expect(out).toContain("HEALTHY");
    expect(out).toContain("25.3.1.1");
    expect(out).toContain("single-node MergeTree");
    expect(out).toContain("events_local");
  });

  it("flags trouble (read-only replica, lag, mutations, memory)", async () => {
    const { deps } = fakeDeps([
      INSTALLED, ...ENV,
      [/version\(\), \(SELECT formatReadableSize/, { stdout: trow("25.3", "9.00 GiB", "9000", "1", "2", "1", "1", "120", "7.50 GiB", "8589934592", "1", "1") }],
      [/ORDER BY sum\(bytes_on_disk\) DESC LIMIT 8/, { stdout: trow("events_local", "9.00 GiB", "5000000", "9000", "8.1") }],
      [/HAVING count\(\)>200/, { stdout: trow("events_local", "9000", "30", "300") }],
      [/FROM system\.merges ORDER BY elapsed/, { stdout: "" }],
      [/FROM system\.replicas ORDER BY absolute_delay DESC LIMIT 10/, { stdout: trow("events_local", "1", "120", "50", "3", "1", "1") }],
      [/FROM system\.errors WHERE value>0 ORDER BY/, { stdout: trow("TIMEOUT_EXCEEDED", "4", "read timed out") }],
    ]);
    const out = await tool("ch_health").handler(deps, {});
    expect(out).toContain("NEEDS ATTENTION");
    expect(out).toMatch(/READ-ONLY/);
    expect(out).toMatch(/replication delay 120s/);
    expect(out).toMatch(/parts\/partition/);
    expect(out).toMatch(/90% of the/);
  });
});

// ---------------------------------------------------------------- ch_tune
describe("ch_tune", () => {
  const hostAndSettings: Responder[] = [
    [/nproc/, { stdout: "4\n8192" }],
    [/system\.server_settings WHERE name IN/, { stdout: trow("max_server_memory_usage", "0") }],
    [/system\.settings WHERE name IN/, { stdout: trow("max_threads", "4") }],
  ];

  it("dry-run shows the diff + XML and writes nothing", async () => {
    const { deps, calls } = fakeDeps([INSTALLED, ...ENV, ...hostAndSettings]);
    const out = await tool("ch_tune").handler(deps, { diskType: "ssd", coLocated: true, apply: false });
    expect(out).toContain("ClickHouse tuning");
    expect(out).toContain("co-located with Postgres");
    expect(out).toContain("max_server_memory_usage");
    expect(out).toContain("config.d/zz-tuning.xml");
    expect(out).toContain("Dry-run");
    expect(calls.some((c) => c.includes("base64 -d"))).toBe(false);
  });

  it("apply writes the drop-ins and reports the mount requirement when not mounted", async () => {
    const { deps, calls } = fakeDeps([
      INSTALLED, ...ENV, ...hostAndSettings,
      [/base64 -d/, { code: 0 }],
      [/test -f \/etc\/clickhouse-server\/config\.d\/zz-tuning\.xml/, { stdout: "no" }],
    ]);
    const out = await tool("ch_tune").handler(deps, { diskType: "ssd", coLocated: true, apply: true });
    expect(out).toContain("NOT yet live");
    expect(out).toContain("/etc/clickhouse-server/config.d/zz-tuning.xml:ro");
    expect(calls.filter((c) => c.includes("base64 -d")).length).toBe(2); // config.d + users.d
  });
});

// ---------------------------------------------------------------- ch_harden
describe("ch_harden", () => {
  it("audits a prod box and stays read-only", async () => {
    const { deps, calls } = fakeDeps([
      INSTALLED, ...ENV,
      [/\^APP_ENV=/, { stdout: "production" }],
      [/\^CLICKHOUSE_PASSWORD=/, { stdout: "s3cret" }],
      [/ps --format.*Publishers/, { stdout: "" }],
      [/auth_type=/, { stdout: "" }],
      [/access_management=1/, { stdout: "default" }],
      [/log_queries/, { stdout: "1" }],
      [/max_concurrent_queries/, { stdout: "100" }],
    ]);
    const out = await tool("ch_harden").handler(deps, {});
    expect(out).toContain("ClickHouse hardening");
    expect(out).toMatch(/PASS .*CLICKHOUSE_PASSWORD is set/);
    expect(out).toContain("GOOD");
    expect(calls.some((c) => c.includes("ALTER"))).toBe(false);
  });

  it("fails an exposed prod box with no password", async () => {
    const { deps } = fakeDeps([
      INSTALLED, ...ENV,
      [/\^APP_ENV=/, { stdout: "production" }],
      [/\^CLICKHOUSE_PASSWORD=/, { stdout: "" }],
      [/ps --format.*Publishers/, { stdout: "clickhouse 0.0.0.0:8123->8123/tcp" }],
      [/auth_type=/, { stdout: "default" }],
      [/access_management=1/, { stdout: "default" }],
      [/log_queries/, { stdout: "0" }],
      [/max_concurrent_queries/, { stdout: "0" }],
    ]);
    const out = await tool("ch_harden").handler(deps, {});
    expect(out).toContain("ACTION REQUIRED");
    expect(out).toMatch(/CLICKHOUSE_PASSWORD is EMPTY/);
    expect(out).toMatch(/port published on the host/);
  });
});

// ---------------------------------------------------------------- ch_backup
describe("ch_backup", () => {
  it("exports, verifies and reports", async () => {
    const { deps } = fakeDeps([
      INSTALLED, ...ENV,
      [/O=backups\/ch-/, { code: 0, stdout: "OK backups/ch-20260615-030000\n--- sizes ---\n9.0G\tbackups/ch-20260615-030000/events_local.native\nevents_local=5000000" }],
      [/find .* -name '\*\.native' -size 0/, { stdout: "" }],
    ]);
    const out = await tool("ch_backup").handler(deps, {});
    expect(out).toContain("Verified ClickHouse backup");
    expect(out).toContain("non-empty");
  });

  it("warns on a zero-byte export", async () => {
    const { deps } = fakeDeps([
      INSTALLED, ...ENV,
      [/O=backups\/ch-/, { code: 0, stdout: "OK backups/ch-x" }],
      [/find .* -name '\*\.native' -size 0/, { stdout: "/opt/adpix/backups/ch-x/distinct_id_overrides.native" }],
    ]);
    const out = await tool("ch_backup").handler(deps, {});
    expect(out).toContain("zero-byte export");
  });
});

// ---------------------------------------------------------------- ch_restore_db
describe("ch_restore_db", () => {
  it("refuses without confirm", async () => {
    const { deps, calls } = fakeDeps([]);
    expect(await tool("ch_restore_db").handler(deps, { backupDir: "backups/ch-x", confirm: false })).toContain("REFUSED");
    expect(calls).toHaveLength(0);
  });

  it("lists available backups when the dir is missing", async () => {
    const { deps } = fakeDeps([
      INSTALLED, ...ENV,
      [/test -d .*ch-nope.* && echo yes/, { stdout: "no" }],
      [/ls -1dt .*backups\/ch-/, { stdout: "/opt/adpix/backups/ch-20260615-030000/" }],
    ]);
    const out = await tool("ch_restore_db").handler(deps, { backupDir: "backups/ch-nope", confirm: true });
    expect(out).toContain("not found");
    expect(out).toContain("ch-20260615-030000");
  });
});

// ---------------------------------------------------------------- ch_replication
describe("ch_replication", () => {
  it("status of a single-node deployment", async () => {
    const { deps } = fakeDeps([
      INSTALLED, ...ENV,
      [/FROM system\.replicas ORDER BY absolute_delay DESC/, { stdout: "" }],
      [/test -f \/etc\/clickhouse-server\/config\.d\/replication\.xml/, { stdout: "no" }],
    ]);
    const out = await tool("ch_replication").handler(deps, { mode: "status", confirm: false });
    expect(out).toContain("single-node MergeTree");
  });

  it("enable-plan explains the fresh-deploy caveat", async () => {
    const { deps } = fakeDeps([INSTALLED, ...ENV]);
    const out = await tool("ch_replication").handler(deps, { mode: "enable-plan", confirm: false });
    expect(out).toContain("FRESH");
    expect(out).toContain("events_local");
  });

  it("sync refuses without confirm", async () => {
    const { deps } = fakeDeps([INSTALLED, ...ENV, [/SELECT table FROM system\.replicas/, { stdout: "events_local" }]]);
    const out = await tool("ch_replication").handler(deps, { mode: "sync", confirm: false });
    expect(out).toContain("REFUSED");
  });
});

// ---------------------------------------------------------------- ch_retention
describe("ch_retention", () => {
  it("status shows tables + current TTLs", async () => {
    const { deps } = fakeDeps([
      INSTALLED, ...ENV,
      [/GROUP BY table ORDER BY sum\(bytes_on_disk\) DESC LIMIT 12/, { stdout: trow("events_local", "9.00 GiB", "12", "202501", "202506") }],
      [/create_table_query LIKE/, { stdout: trow("events_local", "TTL toDateTime(event_time) + toIntervalMonth(25)") }],
    ]);
    const out = await tool("ch_retention").handler(deps, { mode: "status", unit: "MONTH", confirm: false });
    expect(out).toContain("ClickHouse retention");
    expect(out).toContain("events_local");
    expect(out).toContain("cost lever");
  });

  it("set-ttl dry-run prints the ALTER and runs nothing", async () => {
    const { deps, calls } = fakeDeps([INSTALLED, ...ENV]);
    const out = await tool("ch_retention").handler(deps, { mode: "set-ttl", table: "events_local", interval: 12, unit: "MONTH", confirm: false });
    expect(out).toContain("dry-run");
    expect(out).toMatch(/MODIFY TTL toDateTime\(event_time\) \+ INTERVAL 12 MONTH/);
    expect(calls.some((c) => c.includes("ALTER TABLE"))).toBe(false);
  });

  it("set-ttl with confirm applies the ALTER", async () => {
    const { deps, calls } = fakeDeps([INSTALLED, ...ENV, [/ALTER TABLE .*MODIFY TTL/, { code: 0 }]]);
    const out = await tool("ch_retention").handler(deps, { mode: "set-ttl", table: "events_local", interval: 12, unit: "MONTH", confirm: true });
    expect(out).toContain("done");
    expect(calls.some((c) => c.includes("MODIFY TTL"))).toBe(true);
  });

  it("drop-partition refuses without confirm", async () => {
    const { deps } = fakeDeps([INSTALLED, ...ENV]);
    const out = await tool("ch_retention").handler(deps, { mode: "drop-partition", table: "events_local", partition: "202401", unit: "MONTH", confirm: false });
    expect(out).toContain("REFUSED");
  });
});

// ---------------------------------------------------------------- ch_redeploy
describe("ch_redeploy", () => {
  it("upgrade-plan is advisory and runs nothing", async () => {
    const { deps, calls } = fakeDeps([INSTALLED, ...ENV]);
    const out = await tool("ch_redeploy").handler(deps, { action: "upgrade-plan", skipBackup: false });
    expect(out).toContain("upgrade plan");
    expect(out).toContain("recreate");
    expect(calls.some((c) => c.includes("restart clickhouse") || c.includes("force-recreate"))).toBe(false);
  });

  it("reload is zero-downtime", async () => {
    const { deps, calls } = fakeDeps([INSTALLED, ...ENV, [/SYSTEM RELOAD CONFIG/, { code: 0 }]]);
    const out = await tool("ch_redeploy").handler(deps, { action: "reload", skipBackup: false });
    expect(out).toContain("Reloaded");
    expect(calls.some((c) => c.includes("restart clickhouse"))).toBe(false);
  });

  it("restart snapshots schema, restarts, waits for ping, health-gates", async () => {
    const { deps, calls } = fakeDeps([
      INSTALLED, ...ENV,
      [/ch-schema-/, { code: 0, stdout: "" }],
      [/restart clickhouse/, { code: 0, stdout: "Restarting clickhouse" }],
      [/wget -q -O - http:\/\/localhost:8123\/ping/, { stdout: "ready" }],
      [/for i in \$\(seq 1 \d+\); do code=/, { code: 0, stdout: "healthy after ~5s" }],
    ]);
    const out = await tool("ch_redeploy").handler(deps, { action: "restart", skipBackup: false });
    expect(out).toContain("ClickHouse restart");
    expect(out).toContain("Ok (server up)");
    expect(calls.some((c) => c.includes("ch-schema-"))).toBe(true); // snapshot first
  });
});
