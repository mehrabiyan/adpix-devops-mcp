import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { base32Encode, base32Decode, totpCode, totpVerify, newTotpSecret, hashPassword, verifyPassword } from "../src/panel/auth.js";
import { NonceStore } from "../src/panel/nonce.js";
import { appendAudit, readAudit, verifyChain, auditPath } from "../src/panel/audit.js";
import { argsHash } from "../src/panel/hash.js";

let tmp: string; const SAVED = process.env.ADPIX_DEVOPS_HOME;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-authe-")); process.env.ADPIX_DEVOPS_HOME = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

describe("TOTP boundaries", () => {
  const T = 1_700_000_000_000;
  it("accepts ±1 step of drift, rejects ±2", () => {
    const s = newTotpSecret();
    expect(totpVerify(s, totpCode(s, T), T)).toBe(true);
    expect(totpVerify(s, totpCode(s, T - 30_000), T)).toBe(true);
    expect(totpVerify(s, totpCode(s, T + 30_000), T)).toBe(true);
    expect(totpVerify(s, totpCode(s, T - 60_000), T)).toBe(false);
    expect(totpVerify(s, totpCode(s, T + 60_000), T)).toBe(false);
  });
  it("rejects malformed codes (non-digit, wrong length)", () => {
    const s = newTotpSecret();
    expect(totpVerify(s, "abcdef", T)).toBe(false);
    expect(totpVerify(s, "12345", T)).toBe(false);
    expect(totpVerify(s, "1234567", T)).toBe(false);
    expect(totpVerify(s, "", T)).toBe(false);
    expect(totpVerify(s, "  ", T)).toBe(false);
  });
  it("base32 round-trips arbitrary bytes", () => {
    const buf = Buffer.from([0, 1, 2, 250, 255, 128, 64, 7, 99]);
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });
});

describe("password hashing", () => {
  it("verifies the right password, rejects wrong + corrupt stored formats", () => {
    const h = hashPassword("s3cret pass");
    expect(verifyPassword("s3cret pass", h)).toBe(true);
    expect(verifyPassword("nope", h)).toBe(false);
    expect(verifyPassword("x", "")).toBe(false);
    expect(verifyPassword("x", "notscrypt$aa$bb")).toBe(false);
    expect(verifyPassword("x", "scrypt$$")).toBe(false);
    expect(verifyPassword("", h)).toBe(false);
  });
});

describe("nonce store edges", () => {
  it("consumes exactly once, bound to session/tool/target/args", () => {
    const ns = new NonceStore();
    const h = argsHash({ a: 1 });
    const n = ns.mint("s", "pg_restore_db", "prod", h);
    expect(ns.consume(n, "s", "pg_restore_db", "prod", h).ok).toBe(true);
    expect(ns.consume(n, "s", "pg_restore_db", "prod", h).ok).toBe(false); // replay
  });
  it("rejects unknown / wrong-session / changed-args / expired", () => {
    const ns = new NonceStore(100);
    const h = argsHash({ a: 1 });
    expect(ns.consume("never-minted", "s", "t", "x", h).ok).toBe(false);
    expect(ns.consume(ns.mint("s", "t", "x", h), "OTHER", "t", "x", h).ok).toBe(false);
    expect(ns.consume(ns.mint("s", "t", "x", h), "s", "t", "x", argsHash({ a: 2 })).ok).toBe(false);
    expect(ns.consume(ns.mint("s", "t", "x", h), "s", "DIFFERENT", "x", h).ok).toBe(false);
    // expiry boundary: ttl 100, exactly-at is still valid, just-after is not
    expect(ns.consume(ns.mint("s", "t", "x", h, 0), "s", "t", "x", h, 100).ok).toBe(true);
    expect(ns.consume(ns.mint("s", "t", "x", h, 0), "s", "t", "x", h, 101).ok).toBe(false);
  });
});

describe("audit chain integrity", () => {
  const base = { actor: "ali", role: "owner", ip: "127.0.0.1", argsHash: "h", outcome: "ok" };
  it("empty log → [] and an (empty) chain is valid", () => {
    expect(readAudit()).toEqual([]);
    expect(verifyChain().ok).toBe(true);
  });
  it("detects a deleted middle entry", () => {
    appendAudit({ ...base, tool: "a", target: "x" });
    appendAudit({ ...base, tool: "b", target: "x" });
    appendAudit({ ...base, tool: "c", target: "x" });
    const lines = fs.readFileSync(auditPath(), "utf8").trim().split("\n");
    fs.writeFileSync(auditPath(), [lines[0], lines[2]].join("\n") + "\n"); // drop the middle
    expect(verifyChain().ok).toBe(false);
  });
  it("detects reordered entries", () => {
    appendAudit({ ...base, tool: "a", target: "x" });
    appendAudit({ ...base, tool: "b", target: "x" });
    const lines = fs.readFileSync(auditPath(), "utf8").trim().split("\n");
    fs.writeFileSync(auditPath(), [lines[1], lines[0]].join("\n") + "\n"); // swap
    expect(verifyChain().ok).toBe(false);
  });
  it("a clean chain stays valid as it grows", () => {
    for (let i = 0; i < 5; i++) appendAudit({ ...base, tool: `t${i}`, target: "x" });
    expect(verifyChain().ok).toBe(true);
    expect(readAudit().length).toBe(5);
  });
});
