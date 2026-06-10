import { describe, expect, it } from "vitest";
import type { Deps } from "../src/deps.js";
import type { ServerConfig } from "../src/registry.js";
import type { ExecResult, Session } from "../src/ssh.js";
import { allTools } from "../src/tools/index.js";

type Responder = [RegExp, Partial<ExecResult> | ((cmd: string) => Partial<ExecResult>)];

function fakeDeps(responses: Responder[], srvOverrides: Partial<ServerConfig> = {}) {
  const calls: string[] = [];
  const server: ServerConfig = {
    name: "prod",
    host: "203.0.113.7",
    port: 22,
    username: "root",
    adpixDir: "/opt/adpix",
    ...srvOverrides,
  };
  const session: Session = {
    server,
    authMethod: "publickey",
    close: () => {},
    exec: async (cmd: string) => {
      calls.push(cmd);
      for (const [re, res] of responses) {
        if (re.test(cmd)) {
          const r = typeof res === "function" ? res(cmd) : res;
          return { code: 0, stdout: "", stderr: "", ...r };
        }
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const deps: Deps = {
    resolve: () => server,
    connect: async () => session,
    local: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  return { deps, calls };
}

const tool = (name: string) => {
  const t = allTools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};

describe("tool registration", () => {
  it("registers the full DevOps surface", () => {
    const names = allTools.map((t) => t.name);
    for (const expected of [
      "server_add", "server_list", "server_remove", "run_command",
      "adpix_install", "adpix_update", "adpix_status", "adpix_restart",
      "adpix_logs", "adpix_backup", "adpix_restore",
      "health_check", "system_metrics", "performance_report", "tls_status",
      "security_audit", "harden_server", "patch_system",
      "watchdog_install", "watchdog_status", "uptime_report",
      "cicd_enable", "cicd_status", "cicd_run_now", "cicd_disable",
      "ai_setup", "ai_fix", "mcp_self_update",
    ]) {
      expect(names).toContain(expected);
    }
    expect(new Set(names).size).toBe(names.length); // no duplicate names
  });
});

describe("run_command", () => {
  it("refuses destructive commands without confirm and runs nothing", async () => {
    const { deps, calls } = fakeDeps([]);
    const out = await tool("run_command").handler(deps, { command: "rm -rf /", confirm: false, sudo: true, timeoutSeconds: 10 });
    expect(out).toContain("REFUSED");
    expect(calls).toHaveLength(0);
  });

  it("runs destructive commands when confirmed, noting the override", async () => {
    const { deps, calls } = fakeDeps([[/reboot/, { stdout: "" }]]);
    const out = await tool("run_command").handler(deps, { command: "reboot", confirm: true, sudo: true, timeoutSeconds: 10 });
    expect(calls).toContain("reboot");
    expect(out).toContain("destructive pattern confirmed");
  });

  it("runs ordinary commands and reports exit code + output", async () => {
    const { deps } = fakeDeps([[/^df -h/, { stdout: "Filesystem  Use%\n/dev/vda1  42%" }]]);
    const out = await tool("run_command").handler(deps, { command: "df -h /", confirm: false, sudo: true, timeoutSeconds: 10 });
    expect(out).toContain("exit 0");
    expect(out).toContain("42%");
  });
});

describe("adpix_restore", () => {
  it("requires confirm:true", async () => {
    const { deps, calls } = fakeDeps([]);
    const out = await tool("adpix_restore").handler(deps, { backupDir: "backups/x", confirm: false });
    expect(out).toContain("REFUSED");
    expect(calls).toHaveLength(0);
  });

  it("lists available backups when the dir doesn't exist", async () => {
    const { deps } = fakeDeps([
      [/test -d .*backups\/nope.* && echo yes/, { stdout: "no" }],
      [/ls -1dt .*backups/, { stdout: "/opt/adpix/backups/20260609-010101/" }],
    ]);
    const out = await tool("adpix_restore").handler(deps, { backupDir: "backups/nope", confirm: true });
    expect(out).toContain("not found");
    expect(out).toContain("20260609-010101");
  });
});

describe("adpix_update", () => {
  it("aborts when the pre-update backup fails", async () => {
    const { deps, calls } = fakeDeps([
      [/test -d .*\.git.* && echo yes/, { stdout: "yes" }],
      [/git rev-parse HEAD/, { stdout: "aaaa1111\n" }],
      [/git rev-parse --abbrev-ref HEAD/, { stdout: "main\n" }],
      [/backup\.sh/, { code: 1, stdout: "pg_dump: connection refused" }],
    ]);
    const out = await tool("adpix_update").handler(deps, {
      skipBackup: false, rollbackOnFailure: true, force: false, timeoutSeconds: 600,
    });
    expect(out).toContain("backup FAILED");
    expect(calls.some((c) => c.includes("deploy.sh"))).toBe(false);
  });

  it("skips deploy when already up to date", async () => {
    const { deps, calls } = fakeDeps([
      [/test -d .*\.git.* && echo yes/, { stdout: "yes" }],
      [/git rev-parse HEAD/, { stdout: "aaaa1111\n" }],
      [/git rev-parse --abbrev-ref HEAD/, { stdout: "main\n" }],
      [/backup\.sh/, { stdout: "backup complete" }],
      [/git fetch origin/, { stdout: "aaaa1111\n" }],
    ]);
    const out = await tool("adpix_update").handler(deps, {
      skipBackup: false, rollbackOnFailure: true, force: false, timeoutSeconds: 600,
    });
    expect(out).toContain("Already up to date");
    expect(calls.some((c) => c.includes("deploy.sh"))).toBe(false);
  });

  it("rolls back when the new deploy never turns healthy", async () => {
    let deploys = 0;
    const { deps } = fakeDeps([
      [/test -d .*\.git.* && echo yes/, { stdout: "yes" }],
      // the pull command also ends in `git rev-parse HEAD`, so it must match first
      [/git fetch origin/, { stdout: "bbbb2222\n" }],
      [/git rev-parse HEAD/, { stdout: "aaaa1111\n" }],
      [/git rev-parse --abbrev-ref HEAD/, { stdout: "main\n" }],
      [/backup\.sh/, { stdout: "backup complete" }],
      [/deploy\.sh/, () => ({ code: 0, stdout: `deploy run ${++deploys}` })],
      // health gate: fails after the update, succeeds after rollback
      [/for i in \$\(seq/, () => (deploys === 1 ? { code: 1, stdout: "NOT healthy" } : { code: 0, stdout: "healthy after ~5s" })],
    ]);
    const out = await tool("adpix_update").handler(deps, {
      skipBackup: false, rollbackOnFailure: true, force: false, timeoutSeconds: 600,
    });
    expect(out).toContain("ROLLBACK");
    expect(out).toContain("rollback restored the previous version");
    expect(deploys).toBe(2);
  });
});

describe("health_check", () => {
  it("reports HEALTHY when containers and probes are green", async () => {
    const psRow = (svc: string) =>
      JSON.stringify({ Name: `adanalytics-${svc}-1`, Service: svc, State: "running", Status: "Up", Health: "healthy" });
    const { deps } = fakeDeps([
      [/compose .*ps -a --format json/, { stdout: ["api", "web", "ingest"].map(psRow).join("\n") }],
      [/SITE_ADDRESS/, { stdout: "" }],
      [/PUBLIC_BASE_URL/, { stdout: "http://203.0.113.7" }],
      [/curl .*127\.0\.0\.1:80/, { stdout: "200 0.012" }],
      [/systemctl is-active adpix-watchdog/, { stdout: "active\n{\"status\":\"ok\"}" }],
    ]);
    const out = await tool("health_check").handler(deps, {});
    expect(out).toContain("HEALTHY");
    expect(out).not.toContain("PROBLEM");
  });

  it("flags bad containers and failing probes", async () => {
    const { deps } = fakeDeps([
      [/compose .*ps -a --format json/, {
        stdout: JSON.stringify({ Name: "adanalytics-api-1", Service: "api", State: "exited", Status: "Exited (1)", Health: "" }),
      }],
      [/SITE_ADDRESS/, { stdout: "" }],
      [/PUBLIC_BASE_URL/, { stdout: "http://203.0.113.7" }],
      [/curl .*127\.0\.0\.1:80/, { stdout: "000 0" }],
    ]);
    const out = await tool("health_check").handler(deps, {});
    expect(out).toMatch(/DEGRADED|DOWN/);
    expect(out).toContain("api: exited");
    expect(out).toContain("HTTP 000");
  });
});

describe("harden_server", () => {
  it("dry-run shows the plan without executing", async () => {
    const { deps, calls } = fakeDeps([]);
    const out = await tool("harden_server").handler(deps, {
      apply: false,
      components: ["firewall", "fail2ban", "autoUpdates", "sshHardening"],
    });
    expect(out).toContain("dry-run");
    expect(out).toContain("ufw allow 22/tcp");
    expect(out).toContain("PasswordAuthentication no");
    expect(calls).toHaveLength(0); // nothing ran
  });

  it("allows the SSH port before enabling ufw", async () => {
    const { deps } = fakeDeps([], { port: 2222 });
    const out = await tool("harden_server").handler(deps, { apply: false, components: ["firewall"] });
    const allowIdx = out.indexOf("ufw allow 2222/tcp");
    const enableIdx = out.indexOf("ufw --force enable");
    expect(allowIdx).toBeGreaterThan(-1);
    expect(enableIdx).toBeGreaterThan(allowIdx);
  });
});

describe("uptime_report", () => {
  it("explains when the watchdog isn't installed", async () => {
    const { deps } = fakeDeps([
      [/cat .*checks-\*\.log/, { stdout: "" }],
      [/is-enabled adpix-watchdog/, { stdout: "no" }],
    ]);
    const out = await tool("uptime_report").handler(deps, { days: 7 });
    expect(out).toContain("watchdog isn't installed");
  });

  it("renders uptime from check lines", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { deps } = fakeDeps([
      [/cat .*checks-\*\.log/, { stdout: `${today}T00:00:00Z ok\n${today}T00:01:00Z fail adanalytics-api-1\n${today}T00:02:00Z ok\n` }],
      [/incidents\.jsonl/, { stdout: `{"ts":"${today}T00:01:00Z","event":"down","services":"adanalytics-api-1","actions":"restarted:adanalytics-api-1","consecutive":1}` }],
    ]);
    const out = await tool("uptime_report").handler(deps, { days: 7 });
    expect(out).toContain("1 failed of 3");
    expect(out).toContain("restarted:adanalytics-api-1");
  });
});

describe("tls_status", () => {
  it("explains HTTP-on-IP mode", async () => {
    const { deps } = fakeDeps([
      [/SITE_ADDRESS/, { stdout: ":80" }],
      [/PUBLIC_BASE_URL/, { stdout: "http://203.0.113.7" }],
    ]);
    const out = await tool("tls_status").handler(deps, {});
    expect(out).toContain("no TLS certificate to check");
  });

  it("reads expiry and flags a failing renewal window", async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toUTCString().replace(/^\w+, /, "");
    const { deps } = fakeDeps([
      [/SITE_ADDRESS/, { stdout: "analytics.example.com" }],
      [/PUBLIC_BASE_URL/, { stdout: "https://analytics.example.com" }],
      [/openssl s_client/, {
        stdout: `subject=CN = analytics.example.com\nissuer=C = US, O = Let's Encrypt, CN = R11\nnotBefore=Mar 11 00:00:00 2026 GMT\nnotAfter=${soon}\n`,
      }],
    ]);
    const out = await tool("tls_status").handler(deps, {});
    expect(out).toContain("WARNING");
    expect(out).toContain("renewal is failing");
  });
});
