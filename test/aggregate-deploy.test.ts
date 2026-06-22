import { describe, expect, it } from "vitest";
import { buildDeployView } from "../src/panel/aggregate/deploy.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";

const FS = "\u001f";
function deps(stdout: string, throwIt = false): Deps {
  const srv = { name: "node-a", host: "10.0.0.11", port: 22, username: "root", adpixDir: "/opt/adpix" };
  return {
    resolve: () => srv,
    connect: async () => { if (throwIt) throw new Error("connection refused"); return { server: srv as never, authMethod: "publickey", close: () => {}, exec: async (): Promise<ExecResult> => ({ code: 0, stdout, stderr: "" }) } as Session; },
    local: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
}

const SAMPLE = [
  "===TIMER", "enabled", "Sun 2026-06-22 03:00:00 UTC  2h left  adpix-autodeploy.timer",
  "===STATE", `{"result":"success","at":"2026-06-22T03:01:00Z"}`,
  "===GIT", `a3f9c2e${FS}Add the events pipeline`, "behind:3",
  "===HISTORY",
  `{"commit":"a3f9c2e1234567","subject":"Add the events pipeline","ts":"2026-06-22 03:00","result":"success"}`,
  `{ this is not json }`,
  `{"commit":"b1d2e3f9","subject":"Fix the bug","ts":"2026-06-21 03:00","result":"failed"}`,
].join("\n");

describe("buildDeployView", () => {
  it("parses timer + state + git + JSON history (skips malformed lines)", async () => {
    const v = await buildDeployView(deps(SAMPLE));
    expect(v.error).toBeUndefined();
    expect(v.timer.enabled).toBe(true);
    expect(v.timer.next).toBe("2026-06-22 03:00:00");
    expect(v.timer.lastRun).toEqual({ result: "success", at: "2026-06-22T03:01:00Z" });
    expect(v.version).toEqual({ hash: "a3f9c2e", subject: "Add the events pipeline", behind: 3 });
    expect(v.history.length).toBe(2); // the malformed line is dropped
    expect(v.history[0]).toMatchObject({ hash: "b1d2e3f", result: "failed" }); // newest first (reversed)
    expect(v.history[1]).toMatchObject({ hash: "a3f9c2e", result: "success" });
  });
  it("not-installed timer → disabled, behind '?' when no upstream", async () => {
    const v = await buildDeployView(deps(["===TIMER", "not-installed", "===STATE", "", "===GIT", "===HISTORY", ""].join("\n")));
    expect(v.timer.enabled).toBe(false);
    expect(v.version.behind).toBe("?");
    expect(v.history).toEqual([]);
  });
  it("connect failure → typed error", async () => {
    const v = await buildDeployView(deps("", true));
    expect(v.error).toBeTruthy(); expect(v.timer.enabled).toBe(false);
  });
});
