import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { saveRegistry } from "../src/registry.js";
import type { Deps } from "../src/deps.js";
import type { ServerConfig } from "../src/registry.js";
import type { ExecResult, Session } from "../src/ssh.js";
import { allTools } from "../src/tools/index.js";

/**
 * Behavioral unit tests for the 20 handlers the per-group audit found had no direct
 * coverage (registration-only). Each drives the handler against a mocked SSH seam with
 * responders matching the REAL command strings, asserting the rendered output.
 */

const SEP = ""; // psql field separator
const prow = (...f: string[]) => f.join(SEP);
const trow = (...f: string[]) => f.join("\t"); // ClickHouse TabSeparated

type Resp = [RegExp, Partial<ExecResult> | ((c: string) => Partial<ExecResult>)];
function fakeDeps(responses: Resp[]) {
  const calls: string[] = [];
  const server: ServerConfig = { name: "prod", host: "203.0.113.7", port: 22, username: "root", adpixDir: "/opt/adpix" };
  const session: Session = {
    server, authMethod: "publickey", close: () => {},
    exec: async (cmd: string) => {
      calls.push(cmd);
      for (const [re, res] of responses) if (re.test(cmd)) return { code: 0, stdout: "", stderr: "", ...(typeof res === "function" ? res(cmd) : res) };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { deps: { resolve: () => server, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) } as Deps, calls };
}
const tool = (name: string) => {
  const t = allTools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};

// temp registry home (server_* tools read/write the registry directly)
let tmp: string;
const SAVED = process.env.ADPIX_DEVOPS_HOME;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-gap-test-"));
  process.env.ADPIX_DEVOPS_HOME = tmp;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME;
  else process.env.ADPIX_DEVOPS_HOME = SAVED;
});

const INSTALLED: Resp = [/test -d .*\.git.* && echo yes/, { stdout: "yes" }];
const PG_ENV: Resp[] = [[/POSTGRES_USER/, { stdout: "sovereign" }], [/POSTGRES_DB/, { stdout: "sovereign" }]];
const CH_ENV: Resp[] = [[/\^CLICKHOUSE_USER=/, { stdout: "default" }], [/\^CLICKHOUSE_DB=/, { stdout: "sovereign" }]];

// ---------------------------------------------------------------- servers
describe("server_add / server_list / server_remove", () => {
  it("server_add verify:true probes OS/Docker/AdPix and saves as default", async () => {
    const { deps } = fakeDeps([
      [/uname -a/, { stdout: "Linux prod 6.5.0 x86_64\nOS:Ubuntu 24.04 LTS" }],
      [/docker --version/, { stdout: "Docker version 27.1.1, build 1234567" }],
      [/test -d .*\.git.* && echo yes/, { stdout: "yes" }],
    ]);
    const out = await tool("server_add").handler(deps, { name: "prod", host: "203.0.113.7", username: "root", port: 22, adpixDir: "/opt/adpix", setDefault: true, verify: true });
    expect(out).toContain('Server "prod" saved');
    expect(out).toContain("(default)");
    expect(out).toContain("Ubuntu 24.04 LTS");
    expect(out).toMatch(/Docker version 27\.1\.1/);
    expect(out).toMatch(/AdPix checkout at \/opt\/adpix: present/);
  });

  it("server_list renders registered servers with the default marker", async () => {
    saveRegistry({ version: 1, defaultServer: "prod", servers: { prod: { host: "203.0.113.7", port: 22, username: "root", adpixDir: "/opt/adpix" } } });
    const out = await tool("server_list").handler(fakeDeps([]).deps, {});
    expect(out).toContain("Registered servers");
    expect(out).toContain("prod: root@203.0.113.7:22");
    expect(out).toContain("[default]");
  });

  it("server_remove reports an unknown name is not registered", async () => {
    saveRegistry({ version: 1, defaultServer: "prod", servers: { prod: { host: "203.0.113.7", port: 22, username: "root", adpixDir: "/opt/adpix" } } });
    const out = await tool("server_remove").handler(fakeDeps([]).deps, { name: "staging" });
    expect(out).toContain('Server "staging" is not in the registry.');
  });
});

// ---------------------------------------------------------------- lifecycle
describe("adpix lifecycle (uncovered handlers)", () => {
  it("adpix_install aborts on a preflight FAIL (unsupported OS) and runs no deploy", async () => {
    const { deps, calls } = fakeDeps([
      [/etc\/os-release/, { stdout: "alpine/linux/Alpine Linux v3.19" }],
      [/free -m/, { stdout: "4096" }],
      [/df -m \//, { stdout: "40000" }],
      [/ss -ltnp/, { stdout: "" }],
      [/test -d .*\.git/, { stdout: "no" }],
    ]);
    const out = await tool("adpix_install").handler(deps, { branch: "main", repoUrl: "https://github.com/adpix/adpix.git", deployKey: false, skipPreflight: false, timeoutSeconds: 600 });
    expect(out).toContain("Preflight");
    expect(out).toContain("Install aborted");
    expect(calls.some((c) => c.includes("deploy.sh"))).toBe(false);
  });

  it("adpix_status renders version, watchdog, containers and docker disk", async () => {
    const { deps } = fakeDeps([
      INSTALLED,
      [/git log -1 --format/, { stdout: "abc1234 deploy notes (2026-06-09 03:15:00 +0000)\nmain" }],
      [/compose .*ps -a --format json/, { stdout: JSON.stringify({ Name: "adanalytics-api-1", Service: "api", State: "running", Status: "Up", Health: "healthy" }) }],
      [/SITE_ADDRESS/, { stdout: "" }],
      [/PUBLIC_BASE_URL/, { stdout: "http://203.0.113.7" }],
      [/docker system df/, { stdout: "Images 3 1.2GB" }],
      [/is-active adpix-watchdog\.timer/, { stdout: "active" }],
    ]);
    const out = await tool("adpix_status").handler(deps, {});
    expect(out).toContain("AdPix on prod");
    expect(out).toContain("Version: abc1234");
    expect(out).toMatch(/Watchdog timer: active/);
    expect(out).toContain("api");
  });

  it("adpix_restart restarts one service and reports the health gate", async () => {
    const { deps } = fakeDeps([
      [/compose .*restart api/, { code: 0, stdout: "Restarting adanalytics-api-1" }],
      [/for i in \$\(seq/, { code: 0, stdout: "healthy after ~5s" }],
    ]);
    const out = await tool("adpix_restart").handler(deps, { service: "api" });
    expect(out).toContain("Restarted api on prod");
    expect(out).toContain("Health: healthy after ~5s");
  });

  it("adpix_logs tails grep-filtered logs for one service", async () => {
    const { deps } = fakeDeps([[/logs --no-color --tail=100/, { stdout: "2026-06-09 api ERROR boom" }]]);
    const out = await tool("adpix_logs").handler(deps, { service: "api", lines: 100, grep: "ERROR" });
    expect(out).toContain("Logs from api on prod");
    expect(out).toContain("ERROR boom");
  });

  it("adpix_backup runs backup.sh and lists the latest backup dir", async () => {
    const { deps } = fakeDeps([
      [/backup\.sh/, { code: 0, stdout: "pg_dump done\nMANIFEST written" }],
      [/ls -1dt backups/, { stdout: "12M\tbackups/20260609-031500/" }],
    ]);
    const out = await tool("adpix_backup").handler(deps, {});
    expect(out).toContain("Backup complete on prod");
    expect(out).toContain("20260609-031500");
  });
});

// ---------------------------------------------------------------- monitor
describe("monitor (uncovered handlers)", () => {
  it("system_metrics warns on CPU saturation + full disk and renders the sections", async () => {
    const { deps } = fakeDeps([[/===UPTIME/, { stdout:
      "===UPTIME\nup 3 days\n===LOAD\n5.00 4.20 3.10 1/200 9999\n2\n===MEM\nMem:           2000        1850          50           0         100         120\n===DISK\n/dev/vda1        40G   37G   3G  93% /\n===DOCKER\nadanalytics-api-1  cpu 12.00%  mem 120MiB / 512MiB\n===TOP\n  PID COMMAND %MEM %CPU\n  101 node 8.0 4.0\n" }]]);
    const out = await tool("system_metrics").handler(deps, {});
    expect(out).toMatch(/load 5 exceeds 2 cores/);
    expect(out).toMatch(/disk 93% full/);
    expect(out).toContain("## Containers");
    expect(out).toContain("adanalytics-api-1");
    expect(out).toContain("up 3 days");
  });

  it("performance_report averages curl samples and renders a verdict", async () => {
    const { deps } = fakeDeps([
      [/\^SITE_ADDRESS=/, { stdout: "analytics.example.com" }],
      [/\^PUBLIC_BASE_URL=/, { stdout: "https://analytics.example.com" }],
      [/for i in \$\(seq 1 3\)/, { stdout: "200 0.010 0.020 0.040 0.060 0.090 2048\n200 0.012 0.022 0.042 0.062 0.092 2048\n200 0.011 0.021 0.041 0.061 0.091 2048\n" }],
    ]);
    const out = await tool("performance_report").handler(deps, { runs: 3 });
    expect(out).toContain("Loading speed");
    expect(out).toContain("analytics.example.com");
    expect(out).toMatch(/avg of 3 runs/);
    expect(out).toContain("TTFB");
  });
});

// ---------------------------------------------------------------- security
describe("security (uncovered handlers)", () => {
  it("security_audit renders a GOOD verdict for a hardened host", async () => {
    const { deps } = fakeDeps([[/===SSHD/, { code: 0, stdout:
      "===SSHD\npasswordauthentication no\npermitrootlogin prohibit-password\n===UFW\nStatus: active\n===PORTS\n22 80 443\n===F2B\nactive\n===AUTOUPD\nAPT::Periodic::Unattended-Upgrade \"1\";\n===UPD\n0\n0\n===REBOOT\nno\n===DOCKERPORTS\nnone\n===ENVPERM\n600 root\n===BRUTE\n3\n" }]]);
    const out = await tool("security_audit").handler(deps, {});
    expect(out).toContain("Security audit");
    expect(out).toMatch(/Verdict: GOOD/);
    expect(out).toMatch(/fail2ban active/i);
  });

  it("security_audit flags an exposed Postgres port + password auth as FAIL", async () => {
    const { deps } = fakeDeps([[/===SSHD/, { code: 0, stdout:
      "===SSHD\npasswordauthentication yes\npermitrootlogin yes\n===UFW\nStatus: inactive\n===PORTS\n22 80 443 5432\n===F2B\ninactive\n===AUTOUPD\nmissing\n===UPD\n4\n2\n===REBOOT\nyes\n===DOCKERPORTS\nnone\n===ENVPERM\n644 root\n===BRUTE\n250\n" }]]);
    const out = await tool("security_audit").handler(deps, {});
    expect(out).toMatch(/Verdict: ACTION REQUIRED/);
    expect(out).toMatch(/5432/);
    expect(out).toContain("FAIL");
  });

  it("patch_system full upgrade reports no reboot required", async () => {
    const { deps } = fakeDeps([
      [/apt-get update -qq/, { code: 0, stdout: "" }],
      [/force-confold upgrade/, { code: 0, stdout: "0 upgraded, 0 newly installed" }],
      [/reboot-required/, { code: 0, stdout: "no" }],
    ]);
    const out = await tool("patch_system").handler(deps, { securityOnly: false, autoReboot: false, confirm: false, timeoutSeconds: 1200 });
    expect(out).toMatch(/0 upgraded, 0 newly installed/);
    expect(out).toMatch(/No reboot required/i);
  });

  it("patch_system warns that confirm:false blocks the requested reboot", async () => {
    const { deps } = fakeDeps([
      [/apt-get update -qq/, { code: 0, stdout: "" }],
      [/unattended-upgrade -v/, { code: 0, stdout: "Packages that will be upgraded: openssl" }],
      [/reboot-required/, { code: 0, stdout: "yes" }],
    ]);
    const out = await tool("patch_system").handler(deps, { securityOnly: true, autoReboot: true, confirm: false, timeoutSeconds: 1200 });
    expect(out).toMatch(/confirm:true to reboot|autoReboot.*confirm:false/i);
  });
});

// ---------------------------------------------------------------- watchdog + cicd
describe("watchdog + cicd (uncovered handlers)", () => {
  it("watchdog_install installs the timer and reports the first check", async () => {
    const { deps } = fakeDeps([[/enable --now/, { code: 0, stdout: '{"status":"ok","failures":0}' }]]);
    const out = await tool("watchdog_install").handler(deps, {
      intervalSeconds: 60, autoRestart: true, httpPath: "/_apx_health", realertEvery: 30, aiEscalate: false, escalateAfter: 5, webhookUrl: "",
    });
    expect(out).toMatch(/Watchdog installed on prod/);
  });

  it("watchdog_status renders timer, last check and incidents", async () => {
    const { deps } = fakeDeps([[/echo ===TIMER/, { code: 0, stdout:
      "===TIMER\nenabled\n===STATE\n{\"status\":\"ok\"}\n===INCIDENTS\n{\"ts\":\"2026-06-20T00:00:00Z\",\"event\":\"down\"}\n" }]]);
    const out = await tool("watchdog_status").handler(deps, { incidents: 10 });
    expect(out).toContain("Watchdog on prod");
    expect(out).toMatch(/enabled/);
  });

  it("cicd_disable stops the timer and keeps history", async () => {
    const { deps } = fakeDeps([[/disable --now adpix-autodeploy\.timer/, { code: 0, stdout: "Removed adpix-autodeploy.timer." }]]);
    const out = await tool("cicd_disable").handler(deps, {});
    expect(out).toMatch(/Continuous deployment disabled on prod/);
    expect(out).toMatch(/deploys\.jsonl/);
  });
});

// ---------------------------------------------------------------- pg_optimize / ch_optimize (safety-relevant)
describe("pg_optimize / ch_optimize dry-run (uncovered handlers)", () => {
  it("pg_optimize dry-run reports unused indexes + bloat and advises apply:true", async () => {
    const { deps, calls } = fakeDeps([
      INSTALLED, ...PG_ENV,
      [/WHERE i\.idx_scan=0 AND NOT x\.indisunique/, { stdout: prow("public.events", "idx_events_old", "12 MB") }],
      [/WHERE NOT x\.indisvalid/, { stdout: "" }],
      [/seq_scan > coalesce\(idx_scan,0\) AND n_live_tup > 50000/, { stdout: prow("events", "9000", "10", "120000") }],
      [/n_dead_tup > 1000 ORDER BY n_dead_tup DESC/, { stdout: prow("events", "40000", "100000", "28.6") }],
      [/extname='pg_stat_statements'/, { stdout: "" }],
    ]);
    const out = await tool("pg_optimize").handler(deps, { apply: false });
    expect(out).toContain("Postgres optimization");
    expect(out).toContain("idx_events_old");
    expect(out).toMatch(/Dead-tuple bloat/);
    expect(out).toMatch(/Re-run with apply:true/);
    expect(calls.some((c) => c.includes("VACUUM"))).toBe(false);
  });

  it("ch_optimize dry-run reports part pressure + advises apply:true without running OPTIMIZE", async () => {
    const { deps, calls } = fakeDeps([
      INSTALLED, ...CH_ENV,
      [/HAVING count\(\)>100/, { stdout: trow("events_local", "9000", "30", "300", "9663676416") }],
      [/engine LIKE/, { stdout: "events_local" }],
      [/HAVING sum\(bytes_on_disk\)>10000000/, { stdout: trow("events_local", "3.2", "9.00 GiB") }],
      [/system\.query_log/, { stdout: trow("SELECT count() FROM events", "10", "42", "420") }],
    ]);
    const out = await tool("ch_optimize").handler(deps, { apply: false, maxOptimizeGB: 5 });
    expect(out).toContain("ClickHouse optimization");
    expect(out).toMatch(/Part pressure/);
    expect(out).toContain("events_local");
    expect(out).toMatch(/Re-run with apply:true to OPTIMIZE FINAL/);
    expect(calls.some((c) => c.includes("OPTIMIZE TABLE"))).toBe(false);
  });
});

// ---------------------------------------------------------------- tagmanager (uncovered handlers)
describe("tm_status / tm_logs / tm_restart (uncovered handlers)", () => {
  it("tm_status renders the git version + container table when installed", async () => {
    const { deps } = fakeDeps([
      INSTALLED,
      [/git log -1 --format/, { stdout: "a1b2c3d add purge-bridge (2026-06-20 12:00:00 +0000)\nmain" }],
      [/ps -a --format json/, { stdout: '{"Service":"api","State":"running","Health":"healthy","Status":"Up 2 hours"}' }],
    ]);
    const out = await tool("tm_status").handler(deps, { dir: "/opt/adpix-tagmanager" });
    expect(out).toContain("Tag Manager on prod");
    expect(out).toContain("Version: a1b2c3d");
    expect(out).toContain("api");
  });

  it("tm_status tells you to run tm_install when no checkout exists", async () => {
    const { deps } = fakeDeps([[/test -d .*\.git.* && echo yes/, { stdout: "no" }]]);
    const out = await tool("tm_status").handler(deps, { dir: "/opt/adpix-tagmanager" });
    expect(out).toMatch(/No Tag Manager checkout/);
    expect(out).toContain("run tm_install");
  });

  it("tm_logs tails a filtered service log", async () => {
    const { deps } = fakeDeps([INSTALLED, [/logs --no-color --tail=100/, { stdout: "api  | level=error msg=boom" }]]);
    const out = await tool("tm_logs").handler(deps, { dir: "/opt/adpix-tagmanager", service: "api", lines: 100, grep: "error" });
    expect(out).toContain("TM logs from api on prod");
    expect(out).toContain("level=error msg=boom");
  });

  it("tm_restart restarts one service then re-checks the health gate", async () => {
    const { deps } = fakeDeps([
      INSTALLED,
      [/restart api/, { code: 0, stdout: "Restarting adpix-tm-api-1" }],
      [/8686\/healthz/, { code: 0, stdout: "healthy after ~5s (api+edge 200)" }],
    ]);
    const out = await tool("tm_restart").handler(deps, { dir: "/opt/adpix-tagmanager", service: "api" });
    expect(out).toContain("Restarted api on prod");
    expect(out).toContain("Health: healthy after ~5s (api+edge 200)");
  });
});
