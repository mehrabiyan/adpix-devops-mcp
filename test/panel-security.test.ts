import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { base32Encode, totpCode, totpVerify, hashPassword, verifyPassword, newTotpSecret } from "../src/panel/auth.js";
import { roleAllows, targetAllowed, authorize, OWNER_ONLY } from "../src/panel/rbac.js";
import { NonceStore } from "../src/panel/nonce.js";
import { SessionStore } from "../src/panel/sessions.js";
import { appendAudit, readAudit, verifyChain, auditPath } from "../src/panel/audit.js";
import { argsHash } from "../src/panel/hash.js";
import type { Admin } from "../src/panel/admins.js";

let tmp: string;
const SAVED = process.env.ADPIX_DEVOPS_HOME;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-sec-")); process.env.ADPIX_DEVOPS_HOME = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

describe("auth — TOTP + password", () => {
  it("matches the RFC-6238 SHA1 test vector (T=59s → 287082)", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(totpCode(secret, 59 * 1000)).toBe("287082");
  });
  it("verifies within the drift window, rejects outside", () => {
    const s = newTotpSecret();
    const now = 1_700_000_000_000;
    expect(totpVerify(s, totpCode(s, now), now)).toBe(true);
    expect(totpVerify(s, totpCode(s, now - 30_000), now)).toBe(true); // -1 step
    expect(totpVerify(s, totpCode(s, now - 120_000), now)).toBe(false); // far off
    expect(totpVerify(s, "000000", now)).toBe(false);
  });
  it("hashes + verifies passwords (scrypt), rejects wrong", () => {
    const h = hashPassword("correct horse");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("correct horse", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
  });
});

describe("rbac — default-deny by role + scope", () => {
  const ro = { name: "pg_health", readOnly: true, destructive: false };
  const mut = { name: "adpix_update", readOnly: false, destructive: false };
  const own = { name: "run_command", readOnly: false, destructive: false };
  it("viewer: read-only only", () => {
    expect(roleAllows("viewer", ro)).toBe(true);
    expect(roleAllows("viewer", mut)).toBe(false);
  });
  it("operator: mutating yes, owner-only no", () => {
    expect(roleAllows("operator", mut)).toBe(true);
    expect(roleAllows("operator", own)).toBe(false);
    expect(OWNER_ONLY.has("run_command")).toBe(true);
  });
  it("owner: everything", () => {
    expect(roleAllows("owner", own)).toBe(true);
  });
  it("scopes gate the target", () => {
    expect(targetAllowed(["*"], { server: "x" })).toBe(true);
    expect(targetAllowed(["prod"], { cluster: "prod" })).toBe(true);
    expect(targetAllowed(["prod"], { server: "staging" })).toBe(false);
    expect(targetAllowed(["prod"], {})).toBe(true); // unscoped read
  });
  it("authorize combines both", () => {
    expect(authorize("operator", ["prod"], mut, { server: "prod" }).ok).toBe(true);
    expect(authorize("operator", ["prod"], mut, { server: "other" }).ok).toBe(false);
    expect(authorize("viewer", ["*"], own, {}).ok).toBe(false);
  });
});

describe("nonce — per-action re-auth", () => {
  it("mints + consumes once, bound to session/tool/target/args", () => {
    const ns = new NonceStore();
    const h = argsHash({ server: "prod", confirm: true });
    const n = ns.mint("sess1", "pg_restore_db", "prod", h);
    expect(ns.consume(n, "sess1", "pg_restore_db", "prod", h).ok).toBe(true);
    expect(ns.consume(n, "sess1", "pg_restore_db", "prod", h).ok).toBe(false); // replay
  });
  it("rejects wrong session / changed args / expiry", () => {
    const ns = new NonceStore(50);
    const h = argsHash({ a: 1 });
    expect(ns.consume("nope", "s", "t", "x", h).ok).toBe(false);
    const n1 = ns.mint("s", "t", "x", h);
    expect(ns.consume(n1, "other", "t", "x", h).ok).toBe(false);
    const n2 = ns.mint("s", "t", "x", h);
    expect(ns.consume(n2, "s", "t", "x", argsHash({ a: 2 })).ok).toBe(false); // args changed
    const n3 = ns.mint("s", "t", "x", h, 0);
    expect(ns.consume(n3, "s", "t", "x", h, 999).ok).toBe(false); // expired
  });
});

describe("sessions — lifetime + revoke", () => {
  const admin: Admin = { username: "ali", role: "owner", pwHash: "x", totpSecret: "y", scopes: ["*"], createdAt: "t" };
  it("creates + resolves; idle + absolute expiry enforced", () => {
    const ss = new SessionStore(1000, 5000);
    const s = ss.create(admin, "127.0.0.1", 0);
    expect(ss.get(s.id, 500)?.username).toBe("ali"); // alive (touches lastSeen=500)
    expect(ss.get(s.id, 1400)?.username).toBe("ali"); // 1400-500=900 < idle 1000 (touches lastSeen=1400)
    expect(ss.get(s.id, 2500)).toBeUndefined(); // 2500-1400=1100 > idle 1000
  });
  it("revoke + revokeAll", () => {
    const ss = new SessionStore();
    const a = ss.create(admin, "ip"); ss.create(admin, "ip");
    expect(ss.revoke(a.id)).toBe(true);
    expect(ss.revokeAll()).toBe(1);
    expect(ss.list().length).toBe(0);
  });
});

describe("audit — hash-chained, tamper-evident", () => {
  const base = { actor: "ali", role: "owner", ip: "127.0.0.1", argsHash: "h", outcome: "ok" };
  it("appends a chain and verifies intact", () => {
    appendAudit({ ...base, tool: "pg_backup", target: "prod" });
    appendAudit({ ...base, tool: "adpix_update", target: "prod" });
    const log = readAudit();
    expect(log.length).toBe(2);
    expect(log[0].tool).toBe("adpix_update"); // newest first
    expect(verifyChain().ok).toBe(true);
  });
  it("detects tampering", () => {
    appendAudit({ ...base, tool: "a", target: "x" });
    appendAudit({ ...base, tool: "b", target: "x" });
    const lines = fs.readFileSync(auditPath(), "utf8").trim().split("\n");
    const first = JSON.parse(lines[0]); first.tool = "TAMPERED";
    fs.writeFileSync(auditPath(), [JSON.stringify(first), lines[1]].join("\n") + "\n");
    expect(verifyChain().ok).toBe(false);
  });
});
