import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderWatchdogScript, renderWatchdogTimer, WATCHDOG_SERVICE_UNIT } from "../src/remote/watchdog.js";
import { summarizeChecks } from "../src/tools/watchdog.js";

const opts = {
  adpixDir: "/opt/adpix",
  webhookUrl: "https://hooks.example.com/T123/B456",
  autoRestart: true,
  httpPath: "/_apx_health",
  realertEvery: 30,
};

describe("watchdog script template", () => {
  it("substitutes every setting and leaves no template residue", () => {
    const s = renderWatchdogScript(opts);
    expect(s).toContain("ADPIX_DIR='/opt/adpix'");
    expect(s).toContain("WEBHOOK_URL='https://hooks.example.com/T123/B456'");
    expect(s).toContain("AUTO_RESTART=1");
    expect(s).toContain("HTTP_PATH='/_apx_health'");
    expect(s).toContain("REALERT_EVERY=30");
    expect(s).not.toContain("undefined");
    expect(s).toContain("com.docker.compose.project=$PROJECT");
  });

  it("renders autoRestart:false and empty webhook safely", () => {
    const s = renderWatchdogScript({ ...opts, autoRestart: false, webhookUrl: undefined });
    expect(s).toContain("AUTO_RESTART=0");
    expect(s).toContain("WEBHOOK_URL=''");
  });

  it("strips single quotes that would break the script's quoting", () => {
    const s = renderWatchdogScript({ ...opts, webhookUrl: "https://x/'$(reboot)'" });
    expect(s).toContain("WEBHOOK_URL='https://x/$(reboot)'"); // inert inside single quotes
  });

  it("is valid bash (bash -n)", () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wd-")), "watchdog.sh");
    fs.writeFileSync(tmp, renderWatchdogScript(opts));
    // throws on syntax errors
    execFileSync("bash", ["-n", tmp]);
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  });
});

describe("systemd units", () => {
  it("timer clamps the interval into a sane range", () => {
    expect(renderWatchdogTimer(60)).toContain("OnUnitActiveSec=60");
    expect(renderWatchdogTimer(1)).toContain("OnUnitActiveSec=15");
    expect(renderWatchdogTimer(999999)).toContain("OnUnitActiveSec=3600");
  });
  it("service is oneshot and runs the installed script", () => {
    expect(WATCHDOG_SERVICE_UNIT).toContain("Type=oneshot");
    expect(WATCHDOG_SERVICE_UNIT).toContain("ExecStart=/usr/local/bin/adpix-watchdog.sh");
  });
});

describe("summarizeChecks (uptime math)", () => {
  it("computes per-day and overall uptime", () => {
    const lines = [
      "2026-06-08T00:00:00Z ok",
      "2026-06-08T00:01:00Z ok",
      "2026-06-08T00:02:00Z fail adanalytics-api-1",
      "2026-06-08T00:03:00Z fail adanalytics-api-1 http:80(000)",
      "2026-06-09T00:00:00Z ok",
      "2026-06-09T00:01:00Z ok",
    ];
    const r = summarizeChecks(lines, "2026-06-01T00:00:00Z");
    expect(r.total).toBe(6);
    expect(r.failed).toBe(2);
    expect(r.text).toContain("2026-06-08");
    expect(r.text).toContain("2 failed of 4");
    expect(r.text).toContain("longest outage streak: 2");
  });

  it("ignores lines before the cutoff and junk lines", () => {
    const r = summarizeChecks(
      ["2026-05-01T00:00:00Z fail x", "garbage", "2026-06-09T00:00:00Z ok"],
      "2026-06-01T00:00:00Z"
    );
    expect(r.total).toBe(1);
    expect(r.failed).toBe(0);
  });
});
