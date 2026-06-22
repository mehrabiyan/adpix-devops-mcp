import { describe, expect, it } from "vitest";
import { buildMcpStatus } from "../src/panel/aggregate/mcp.js";
import type { Deps } from "../src/deps.js";

function deps(stdout: string, throwIt = false): Deps {
  return {
    resolve: () => ({ name: "x", host: "x", port: 22, username: "root", adpixDir: "/opt/adpix" }),
    connect: async () => { throw new Error("no ssh in this test"); },
    local: async () => { if (throwIt) throw new Error("git missing"); return { code: 0, stdout, stderr: "" }; },
  };
}

describe("buildMcpStatus", () => {
  it("parses commit / subject / branch / behind", async () => {
    const v = await buildMcpStatus(deps("abc1234\nFix the thing\nmain\n3"));
    expect(v.commit).toBe("abc1234");
    expect(v.subject).toBe("Fix the thing");
    expect(v.branch).toBe("main");
    expect(v.behind).toBe(3);
    expect(v.version).toBeTruthy(); // read from this repo's package.json
  });
  it("behind '?' when origin is unreachable", async () => {
    const v = await buildMcpStatus(deps("abc1234\nsubject\nmain\n?"));
    expect(v.behind).toBe("?");
  });
  it("error path is typed, never throws", async () => {
    const v = await buildMcpStatus(deps("", true));
    expect(v.error).toBeTruthy();
  });
});
