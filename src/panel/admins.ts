import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hashPassword, newTotpSecret } from "./auth.js";

/** Panel admin store — $ADPIX_DEVOPS_HOME/panel-admins.json (mode 600). Holds password hashes
 *  + TOTP secrets + role + tenant scopes. Never serialized to the browser. */

export type Role = "owner" | "operator" | "viewer";
export const ROLES: Role[] = ["owner", "operator", "viewer"];

export interface Admin {
  username: string;
  role: Role;
  pwHash: string;
  totpSecret: string;
  /** Server/cluster names this admin may target; ["*"] = the whole fleet. */
  scopes: string[];
  createdAt: string;
}

export function adminsPath(): string {
  const home = process.env.ADPIX_DEVOPS_HOME || path.join(os.homedir(), ".adpix-devops");
  return path.join(home, "panel-admins.json");
}

export function loadAdmins(): Admin[] {
  try {
    const raw = JSON.parse(fs.readFileSync(adminsPath(), "utf8")) as { version: number; admins: Admin[] };
    return raw && raw.version === 1 && Array.isArray(raw.admins) ? raw.admins : [];
  } catch {
    return [];
  }
}

export function saveAdmins(admins: Admin[]): void {
  const p = adminsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, admins }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function getAdmin(username: string): Admin | undefined {
  return loadAdmins().find((a) => a.username === username);
}

/** Create an admin (returns the plaintext TOTP secret once, for provisioning). */
export function createAdmin(username: string, password: string, role: Role = "owner", scopes = ["*"]): { admin: Admin; totpSecret: string } {
  const admins = loadAdmins();
  if (admins.some((a) => a.username === username)) throw new Error(`admin "${username}" already exists`);
  const totpSecret = newTotpSecret();
  const admin: Admin = { username, role, pwHash: hashPassword(password), totpSecret, scopes, createdAt: new Date().toISOString() };
  admins.push(admin);
  saveAdmins(admins);
  return { admin, totpSecret };
}

export function removeAdmin(username: string): boolean {
  const admins = loadAdmins();
  const next = admins.filter((a) => a.username !== username);
  if (next.length === admins.length) return false;
  saveAdmins(next);
  return true;
}
