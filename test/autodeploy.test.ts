import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  renderAutodeployScript,
  renderAutodeployServiceUnit,
  renderAutodeployTimer,
} from "../src/remote/autodeploy.js";

const opts = {
  adpixDir: "/opt/adpix",
  branch: "main",
  webhookUrl: "https://hooks.example.com/x",
  skipBackup: false,
  healthTries: 30,
};

function bashCheck(content: string) {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ad-")), "s.sh");
  fs.writeFileSync(tmp, content);
  execFileSync("bash", ["-n", tmp]); // throws on syntax error
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
}

describe("autodeploy script template", () => {
  it("substitutes settings and leaves no residue", () => {
    const s = renderAutodeployScript(opts);
    expect(s).toContain("ADPIX_DIR='/opt/adpix'");
    expect(s).toContain("BRANCH='main'");
    expect(s).toContain("SKIP_BACKUP=0");
    expect(s).toContain("HEALTH_TRIES=30");
    expect(s).not.toContain("undefined");
  });

  it("contains the full safety pipeline: lock, backup-abort, health gate, rollback", () => {
    const s = renderAutodeployScript(opts);
    expect(s).toContain("flock -n 9");
    expect(s).toContain("backup.sh");
    expect(s).toContain("backup_failed");
    expect(s).toContain("_apx_health");
    expect(s).toContain("rolled_back");
    expect(s).toContain("rollback_failed");
    // rollback resets to the pre-deploy commit
    expect(s).toContain('git reset --hard "$local_head"');
  });

  it("skips backup only when asked", () => {
    expect(renderAutodeployScript({ ...opts, skipBackup: true })).toContain("SKIP_BACKUP=1");
  });

  it("is valid bash (bash -n)", () => {
    bashCheck(renderAutodeployScript(opts));
  });
});

describe("autodeploy systemd units", () => {
  it("service gives builds room (no 90s oneshot default)", () => {
    const u = renderAutodeployServiceUnit("/opt/adpix");
    expect(u).toContain("Type=oneshot");
    expect(u).toContain("TimeoutStartSec=3900");
    expect(u).toContain("WorkingDirectory=/opt/adpix");
  });
  it("timer clamps the interval", () => {
    expect(renderAutodeployTimer(300)).toContain("OnUnitActiveSec=300");
    expect(renderAutodeployTimer(5)).toContain("OnUnitActiveSec=60");
    expect(renderAutodeployTimer(10_000_000)).toContain("OnUnitActiveSec=86400");
  });
});

describe("static host scripts", () => {
  it("installer + selfheal scripts are valid bash", () => {
    for (const f of ["scripts/install-server.sh", "scripts/selfheal.sh", "scripts/install-dev-adpix.sh"]) {
      execFileSync("bash", ["-n", path.resolve(f)]);
    }
  });

  it("the dev.adpix.io installer pins the right deployment", () => {
    const s = fs.readFileSync(path.resolve("scripts/install-dev-adpix.sh"), "utf8");
    expect(s).toContain('MCP_DOMAIN="${MCP_DOMAIN:-dev.adpix.io}"');
    expect(s).toContain('EXPECTED_IP="${EXPECTED_IP:-167.233.101.248}"');
    expect(s).toContain("install-server.sh");
    expect(s).toContain("claude mcp add --transport http");
  });
});
