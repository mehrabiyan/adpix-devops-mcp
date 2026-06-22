import { describe, expect, it } from "vitest";
import { buildStacksStatus } from "../src/panel/aggregate/stacks.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";

const SRV: ServerConfig = { name: "n", host: "10.0.0.1", port: 22, username: "root", adpixDir: "/opt/adpix" };

function deps(probe: (cmd: string) => string, fail = false): Deps {
  const session: Session = { server: SRV, authMethod: "publickey", close: () => {}, exec: async (cmd): Promise<ExecResult> => ({ code: 0, stdout: probe(cmd), stderr: "" }) };
  return { resolve: () => SRV, connect: async () => { if (fail) throw new Error("ssh refused"); return session; }, local: async () => ({ code: 0, stdout: "", stderr: "" }) };
}

describe("buildStacksStatus", () => {
  it("returns one typed row per stack with numeric behind", async () => {
    const v = await buildStacksStatus(deps((c) => /adpix-auth/.test(c) ? "NOGIT" : "abc1234\tmain\t3\twip"));
    expect(v.map((x) => x.stack).sort()).toEqual(["analytics", "idp", "tagmanager"]);
    const an = v.find((x) => x.stack === "analytics")!;
    expect(an.installed).toBe(true); expect(an.commit).toBe("abc1234"); expect(an.behind).toBe(3);
    const idp = v.find((x) => x.stack === "idp")!;
    expect(idp.installed).toBe(false); expect(idp.behind).toBe("?");
  });

  it("behind '?' when origin unreachable", async () => {
    const v = await buildStacksStatus(deps(() => "abc1234\tmain\t?\twip"));
    expect(v.every((x) => x.behind === "?")).toBe(true);
  });

  it("never throws — connect failure → typed rows with error", async () => {
    const v = await buildStacksStatus(deps(() => "x", true));
    expect(v).toHaveLength(3);
    expect(v.every((x) => x.error && !x.installed)).toBe(true);
  });
});
