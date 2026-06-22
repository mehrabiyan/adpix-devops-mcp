import { randomBytes } from "node:crypto";

/**
 * Per-action re-auth nonces for destructive ops. Replaces a bare `confirm:true` boolean with a
 * server-issued, single-use, short-TTL token bound to (session, tool, target, args-hash),
 * minted only from a preview the operator just saw. Anti-replay (consumed once) and anti-
 * confused-deputy (a stale tab's old nonce won't match new args). See docs/control-panel.md §4.
 */

interface Nonce {
  nonce: string;
  sessionId: string;
  tool: string;
  target: string;
  argsHash: string;
  expiresAt: number;
  used: boolean;
}

const TTL_MS = 120 * 1000;

export class NonceStore {
  private map = new Map<string, Nonce>();

  constructor(private ttlMs = TTL_MS) {}

  mint(sessionId: string, tool: string, target: string, argsHash: string, now = Date.now()): string {
    const nonce = randomBytes(24).toString("hex");
    this.map.set(nonce, { nonce, sessionId, tool, target, argsHash, expiresAt: now + this.ttlMs, used: false });
    return nonce;
  }

  /** Validate + consume (single use). Must match the same session/tool/target/args it was minted for. */
  consume(nonce: string, sessionId: string, tool: string, target: string, argsHash: string, now = Date.now()): { ok: boolean; reason: string } {
    const n = this.map.get(nonce);
    if (!n) return { ok: false, reason: "unknown or already-used confirmation token" };
    if (n.used) return { ok: false, reason: "confirmation token already used" };
    if (now > n.expiresAt) { this.map.delete(nonce); return { ok: false, reason: "confirmation token expired — re-preview the action" }; }
    if (n.sessionId !== sessionId) return { ok: false, reason: "confirmation token belongs to another session" };
    if (n.tool !== tool || n.target !== target || n.argsHash !== argsHash) return { ok: false, reason: "the action changed since you confirmed it — re-preview" };
    n.used = true;
    this.map.delete(nonce);
    return { ok: true, reason: "ok" };
  }
}
