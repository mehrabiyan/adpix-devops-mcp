import { createHmac, randomBytes, timingSafeEqual, scryptSync } from "node:crypto";

/**
 * Panel authentication primitives — local admin password (scrypt) + RFC-6238 TOTP. Pure +
 * unit-tested (TOTP against the RFC test vector). Phase 2 of docs/control-panel.md. WebAuthn/
 * OIDC are the stronger options noted in the spec; this is the local-admin break-glass that
 * works without external infra.
 */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0, val = 0; const out: number[] = [];
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx < 0) continue;
    val = (val << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export function base32Encode(buf: Buffer): string {
  let bits = 0, val = 0, out = "";
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

/** The 6-digit TOTP for a base32 secret at a given time (ms). */
export function totpCode(secret: string, forTimeMs = Date.now(), step = 30, digits = 6): string {
  const counter = Math.floor(forTimeMs / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

/** Verify a TOTP code, tolerating ±`window` steps of clock drift. Constant-time per candidate. */
export function totpVerify(secret: string, code: string, forTimeMs = Date.now(), window = 1): boolean {
  const c = code.trim();
  if (!/^\d{6}$/.test(c)) return false;
  for (let w = -window; w <= window; w++) {
    const cand = totpCode(secret, forTimeMs + w * 30 * 1000);
    if (timingSafeEqual(Buffer.from(cand), Buffer.from(c))) return true;
  }
  return false;
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** otpauth:// URI for QR provisioning in an authenticator app. */
export function totpUri(secret: string, account: string, issuer = "AdPix Cloud"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const dk = scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString("hex")}$${dk.toString("hex")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltHex, hashHex] = stored.split("$");
  if (alg !== "scrypt" || !saltHex || !hashHex) return false;
  const dk = scryptSync(pw, Buffer.from(saltHex, "hex"), 32);
  const exp = Buffer.from(hashHex, "hex");
  return dk.length === exp.length && timingSafeEqual(dk, exp);
}
