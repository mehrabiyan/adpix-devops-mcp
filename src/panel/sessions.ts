import { randomBytes } from "node:crypto";
import type { Admin, Role } from "./admins.js";

/**
 * Opaque server-side sessions (in-memory; a restart forces re-login, which is the safer
 * default for a fleet-root panel). Enforces idle + absolute lifetime server-side, supports
 * revoke + revoke-all (kill-switch / logout). The session id rides in a cookie; it is never
 * the credential itself and never put in a URL.
 */

export interface Session {
  id: string;
  /** Double-submit CSRF token for cookie-authed mutations (sent as the x-adpix-csrf header). */
  csrf: string;
  username: string;
  role: Role;
  scopes: string[];
  createdAt: number;
  lastSeen: number;
  ip: string;
}

const IDLE_MS = 15 * 60 * 1000;
const ABSOLUTE_MS = 8 * 60 * 60 * 1000;

export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(private idleMs = IDLE_MS, private absoluteMs = ABSOLUTE_MS) {}

  create(admin: Admin, ip: string, now = Date.now()): Session {
    const s: Session = { id: randomBytes(32).toString("hex"), csrf: randomBytes(24).toString("hex"), username: admin.username, role: admin.role, scopes: admin.scopes, createdAt: now, lastSeen: now, ip };
    this.sessions.set(s.id, s);
    return s;
  }

  /** Resolve a live session, enforcing idle + absolute lifetime; touches lastSeen. */
  get(id: string | undefined, now = Date.now()): Session | undefined {
    if (!id) return undefined;
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (now - s.createdAt > this.absoluteMs || now - s.lastSeen > this.idleMs) {
      this.sessions.delete(id);
      return undefined;
    }
    s.lastSeen = now;
    return s;
  }

  revoke(id: string): boolean {
    return this.sessions.delete(id);
  }

  revokeAll(): number {
    const n = this.sessions.size;
    this.sessions.clear();
    return n;
  }

  list(now = Date.now()): Session[] {
    return [...this.sessions.values()].filter((s) => now - s.createdAt <= this.absoluteMs && now - s.lastSeen <= this.idleMs);
  }
}
