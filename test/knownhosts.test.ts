import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { keyFingerprint, decideHostKey, makeHostVerifier, loadHostPins, forgetHostPin, type HostKeyOutcome } from "../src/knownhosts.js";

let tmp: string;
const SAVED = process.env.ADPIX_DEVOPS_HOME;
const SAVED_STRICT = process.env.ADPIX_SSH_STRICT_HOSTKEY;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-hk-test-"));
  process.env.ADPIX_DEVOPS_HOME = tmp;
  delete process.env.ADPIX_SSH_STRICT_HOSTKEY;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED;
  if (SAVED_STRICT === undefined) delete process.env.ADPIX_SSH_STRICT_HOSTKEY; else process.env.ADPIX_SSH_STRICT_HOSTKEY = SAVED_STRICT;
});

const KEY_A = Buffer.from("host-key-aaaa");
const KEY_B = Buffer.from("host-key-bbbb");

describe("keyFingerprint", () => {
  it("is a stable SHA256: fingerprint, no padding", () => {
    const fp = keyFingerprint(KEY_A);
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(fp.endsWith("=")).toBe(false);
    expect(keyFingerprint(KEY_A)).toBe(fp); // deterministic
    expect(keyFingerprint(KEY_B)).not.toBe(fp);
  });
});

describe("decideHostKey (pure)", () => {
  it("matches a pin", () => expect(decideHostKey("fp", "fp", true)).toEqual({ accept: true, status: "match" }));
  it("rejects a changed key (MITM)", () => expect(decideHostKey("fp", "other", true)).toEqual({ accept: false, status: "mismatch" }));
  it("TOFU-accepts an unpinned key when allowed", () => expect(decideHostKey(undefined, "fp", true)).toEqual({ accept: true, status: "tofu" }));
  it("rejects an unpinned key in strict mode", () => expect(decideHostKey(undefined, "fp", false)).toEqual({ accept: false, status: "unpinned-strict" }));
});

describe("makeHostVerifier (TOFU + strict, pinned store)", () => {
  const run = (key: Buffer, opts: { tofu?: boolean } = {}) => {
    const outcome: { value?: HostKeyOutcome } = {};
    let accepted: boolean | undefined;
    makeHostVerifier("10.0.0.1", 22, opts, outcome)(key, (v) => { accepted = v; });
    return { accepted, outcome: outcome.value! };
  };

  it("pins on first contact (TOFU) then requires the same key", () => {
    const first = run(KEY_A);
    expect(first.accepted).toBe(true);
    expect(first.outcome.status).toBe("tofu");
    expect(loadHostPins()["10.0.0.1:22"]).toBe(keyFingerprint(KEY_A));

    const second = run(KEY_A);
    expect(second.accepted).toBe(true);
    expect(second.outcome.status).toBe("match");
  });

  it("REJECTS a changed host key (mismatch)", () => {
    run(KEY_A); // pin A
    const changed = run(KEY_B);
    expect(changed.accepted).toBe(false);
    expect(changed.outcome.status).toBe("mismatch");
    expect(changed.outcome.pinnedFingerprint).toBe(keyFingerprint(KEY_A));
  });

  it("strict mode rejects an unpinned host", () => {
    const r = run(KEY_A, { tofu: false });
    expect(r.accepted).toBe(false);
    expect(r.outcome.status).toBe("unpinned-strict");
    expect(loadHostPins()["10.0.0.1:22"]).toBeUndefined(); // nothing pinned
  });

  it("honors ADPIX_SSH_STRICT_HOSTKEY=1 as the default", () => {
    process.env.ADPIX_SSH_STRICT_HOSTKEY = "1";
    const r = run(KEY_A);
    expect(r.accepted).toBe(false);
    expect(r.outcome.status).toBe("unpinned-strict");
  });

  it("forgetHostPin lets a legitimately-rebuilt host re-pin", () => {
    run(KEY_A);
    forgetHostPin("10.0.0.1:22");
    const r = run(KEY_B);
    expect(r.accepted).toBe(true);
    expect(r.outcome.status).toBe("tofu");
  });
});
