import { describe, expect, it } from "vitest";
import { buildContainers } from "../src/panel/aggregate/containers.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";

const SRV: ServerConfig = { name: "n", host: "10.0.0.1", port: 22, username: "root", adpixDir: "/opt/adpix" };
function deps(stdout: string, fail = false): Deps {
  const session: Session = { server: SRV, authMethod: "publickey", close: () => {}, exec: async (): Promise<ExecResult> => ({ code: 0, stdout, stderr: "" }) };
  return { resolve: () => SRV, connect: async () => { if (fail) throw new Error("ssh refused"); return session; }, local: async () => ({ code: 0, stdout: "", stderr: "" }) };
}

// service \t project \t name \t state \t status
const PS = [
  "ingest\tadanalytics\tadanalytics-ingest-1\trunning\tUp 3 hours (healthy)",
  "api\tadanalytics\tadanalytics-api-1\trunning\tUp 3 hours",
  "clickhouse\tadanalytics\tadanalytics-clickhouse-1\trunning\tUp 2 hours (unhealthy)",
  "worker\tadanalytics\tadanalytics-worker-1\trestarting\tRestarting (1) 5 seconds ago",
  "web\tadanalytics\tadanalytics-web-1\texited\tExited (137) 1 hour ago",
  "identity-job\tadanalytics\tadanalytics-identity-job-1\trunning\tUp 10 minutes (health: starting)",
].join("\n");

describe("buildContainers", () => {
  it("maps each container's state+health to a dot level", async () => {
    const { containers } = await buildContainers(deps(PS));
    const by = Object.fromEntries(containers.map((c) => [c.service, c]));
    expect(by.ingest.level).toBe("pos");                  // running + healthy
    expect(by.api.level).toBe("pos");                     // running + no healthcheck
    expect(by.clickhouse.level).toBe("neg");              // running but unhealthy
    expect(by.worker.level).toBe("warn");                 // restarting
    expect(by.web.level).toBe("neg");                     // exited
    expect(by["identity-job"].level).toBe("warn");        // health: starting
    expect(by.ingest.up).toBe(true);
    expect(by.web.up).toBe(false);
    expect(by.clickhouse.health).toBe("unhealthy");
  });

  it("never throws — connect failure → empty + error", async () => {
    const v = await buildContainers(deps("", true));
    expect(v.containers).toEqual([]);
    expect(v.error).toMatch(/ssh refused/);
  });

  it("ignores blank lines + falls back to the name when no service label", async () => {
    const { containers } = await buildContainers(deps("\n\tadpix-tm\tloose-box\trunning\tUp 1 minute\n"));
    expect(containers).toHaveLength(1);
    expect(containers[0].service).toBe("loose-box");
    expect(containers[0].level).toBe("pos");
  });
});
