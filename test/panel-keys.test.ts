import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { panelMcpKeyPath, panelKeyDir, saveUploadedKey, ensureMcpKey } from "../src/panel/keys.js";
import { realDeps } from "../src/deps.js";

let tmp: string; const SAVED = process.env.ADPIX_DEVOPS_HOME;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-keys-")); process.env.ADPIX_DEVOPS_HOME = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

describe("panel keys", () => {
  it("key dir + MCP key path live under the registry home (not /var/lib)", () => {
    expect(panelKeyDir()).toBe(path.join(tmp, ".ssh"));
    expect(panelMcpKeyPath()).toBe(path.join(tmp, ".ssh", "id_ed25519"));
  });
  it("saveUploadedKey persists a mode-600 key file and returns its path", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nABC\n-----END OPENSSH PRIVATE KEY-----";
    const p = saveUploadedKey("node-a", pem);
    expect(p).toBe(path.join(tmp, ".ssh", "node-a.key"));
    expect((fs.statSync(p).mode & 0o777)).toBe(0o600);
    expect(fs.readFileSync(p, "utf8")).toBe(pem + "\n");
  });
  it("saveUploadedKey sanitizes the name", () => {
    const p = saveUploadedKey("../../etc/passwd", "k");
    expect(path.dirname(p)).toBe(path.join(tmp, ".ssh"));
    expect(path.basename(p)).toBe("------etc-passwd.key");
  });
  it("ensureMcpKey generates the keypair once, then returns it", async () => {
    const p = await ensureMcpKey(realDeps); // runs ssh-keygen for real
    expect(p).toBe(panelMcpKeyPath());
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.existsSync(p + ".pub")).toBe(true);
    const pub = fs.readFileSync(p + ".pub", "utf8");
    expect(pub.startsWith("ssh-ed25519")).toBe(true);
    const mtime = fs.statSync(p).mtimeMs;
    const again = await ensureMcpKey(realDeps); // idempotent — does not regenerate
    expect(again).toBe(p);
    expect(fs.statSync(p).mtimeMs).toBe(mtime);
  });
});
