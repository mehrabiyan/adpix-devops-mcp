import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAnthropicKey, anthropicKeyStatus, setAnthropicKey, clearAnthropicKey } from "../src/panel/secrets.js";

let home: string;
beforeAll(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-sec-")); process.env.ADPIX_DEVOPS_HOME = home; });
afterAll(() => { delete process.env.ADPIX_DEVOPS_HOME; fs.rmSync(home, { recursive: true, force: true }); });
afterEach(() => { clearAnthropicKey(); delete process.env.ANTHROPIC_API_KEY; });

describe("anthropic key store", () => {
  it("none → set → get → clear", () => {
    expect(anthropicKeyStatus()).toEqual({ configured: false, source: "none" });
    expect(getAnthropicKey()).toBeUndefined();
    setAnthropicKey("sk-ant-abc");
    expect(getAnthropicKey()).toBe("sk-ant-abc");
    expect(anthropicKeyStatus()).toEqual({ configured: true, source: "panel" });
    clearAnthropicKey();
    expect(anthropicKeyStatus().configured).toBe(false);
  });

  it("falls back to the host env when nothing is stored", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    expect(anthropicKeyStatus()).toEqual({ configured: true, source: "env" });
    expect(getAnthropicKey()).toBe("sk-ant-env");
  });

  it("a panel-set key overrides the host env", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    setAnthropicKey("sk-ant-panel");
    expect(getAnthropicKey()).toBe("sk-ant-panel");
    expect(anthropicKeyStatus().source).toBe("panel");
  });

  it("writes the secrets file mode 600", () => {
    setAnthropicKey("sk-ant-x");
    const mode = fs.statSync(path.join(home, "secrets.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
