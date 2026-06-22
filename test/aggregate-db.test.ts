import { describe, expect, it } from "vitest";
import { buildDbView } from "../src/panel/aggregate/db.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";

const SEP = "\u001f";
function dbDeps(answers: [RegExp, string][], opts: { throwAll?: boolean } = {}): Deps {
  const srv = { name: "node-a", host: "10.0.0.11", port: 22, username: "root", adpixDir: "/opt/adpix" };
  return {
    resolve: () => srv,
    connect: async () => {
      const s: Session = { server: srv as never, authMethod: "publickey", close: () => {}, exec: async (cmd): Promise<ExecResult> => {
        if (opts.throwAll) throw new Error("connect/exec blew up");
        for (const [re, out] of answers) if (re.test(cmd)) return { code: 0, stdout: out, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      } };
      return s;
    },
    local: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
}
const NPROC: [RegExp, string] = [/nproc/, "4\n8192"];

describe("buildDbView — Postgres", () => {
  it("returns structured stat cards + tune diff from the metrics row", async () => {
    const deps = dbDeps([NPROC, [/pg_database_size/, `PostgreSQL 16${SEP}48 GB${SEP}142${SEP}300${SEP}99.3${SEP}f`], [/FROM pg_settings/, `shared_buffers${SEP}128MB`]]);
    const v = await buildDbView(deps, "pg");
    expect(v.error).toBeUndefined();
    expect(v.version).toBe("PostgreSQL 16");
    const by = Object.fromEntries(v.stats.map((s) => [s.label, s]));
    expect(by["Connections"].value).toBe("142 / 300"); expect(by["Connections"].level).toBe("pos");
    expect(by["Cache hit"].value).toBe("99.3%");
    expect(by["Role"].value).toBe("primary");
    expect(by["DB size"].value).toBe("48 GB");
    expect(v.tune.length).toBeGreaterThan(0);
  });
  it("warns when connections exceed 80% and standby role", async () => {
    const deps = dbDeps([NPROC, [/pg_database_size/, `PostgreSQL 16${SEP}9 GB${SEP}280${SEP}300${SEP}88${SEP}t`]]);
    const v = await buildDbView(deps, "pg");
    const by = Object.fromEntries(v.stats.map((s) => [s.label, s]));
    expect(by["Connections"].level).toBe("warn");
    expect(by["Cache hit"].level).toBe("warn"); // 88 < 95
    expect(by["Role"].value).toBe("standby");
  });
  it("errors gracefully when the query fails", async () => {
    const v = await buildDbView(dbDeps([NPROC, [/pg_database_size/, ""]]), "pg");
    expect(v.error).toMatch(/Postgres query failed/);
    expect(v.stats).toEqual([]);
  });
});

describe("buildDbView — ClickHouse", () => {
  it("returns parts / merges / size / compression cards", async () => {
    const deps = dbDeps([NPROC, [/version\(\),.*system\.merges/s, "24.3\t1.2 GiB\t312\t4\t11.2\t0"], [/server_settings|FROM system\.settings/, "max_threads\t8"]]);
    const v = await buildDbView(deps, "ch");
    expect(v.error).toBeUndefined();
    const by = Object.fromEntries(v.stats.map((s) => [s.label, s]));
    expect(by["Active parts"].value).toBe("312"); expect(by["Active parts"].level).toBe("warn"); // >300
    expect(by["Merge backlog"].value).toBe("4 merges");
    expect(by["On-disk size"].value).toBe("1.2 GiB");
    expect(by["Compression"].value).toBe("11.2×");
    expect(v.tune.length).toBeGreaterThan(0);
  });
  it("flags read-only replicas (compression card negative)", async () => {
    const deps = dbDeps([NPROC, [/version\(\),.*system\.merges/s, "24.3\t1 GiB\t10\t0\t9.0\t1"]]);
    const v = await buildDbView(deps, "ch");
    expect(v.stats.find((s) => s.label === "Compression")!.level).toBe("neg");
  });
});

describe("buildDbView — failure isolation", () => {
  it("connect/exec throwing yields a typed error view, never throws", async () => {
    const v = await buildDbView(dbDeps([], { throwAll: true }), "pg");
    expect(v.error).toBeTruthy();
    expect(v.engine).toBe("pg");
  });
});
