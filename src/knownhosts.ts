import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

/**
 * SSH host-key verification + pinning. Before this, connect() passed no hostVerifier,
 * so the MCP accepted ANY host key on every target — MITM-able. This adds TOFU
 * (trust-on-first-use) pinning: the first time we see a host we record its key
 * fingerprint; on every later connect the key must match the pin, or we abort. The
 * installer's verify-reconnect can demand strict mode (no TOFU) once a host is pinned.
 */

export type HostKeyStatus = "match" | "tofu" | "mismatch" | "unpinned-strict";

/** OpenSSH-style SHA256 fingerprint of a host public key (the raw ssh wire buffer). */
export function keyFingerprint(key: Buffer): string {
  return "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

/**
 * Pure decision: given the pinned fingerprint (if any), the presented one, and whether
 * TOFU is allowed, decide accept/reject + why. Unit-tested in isolation.
 */
export function decideHostKey(
  pinned: string | undefined,
  presented: string,
  tofu: boolean
): { accept: boolean; status: HostKeyStatus } {
  if (pinned) return pinned === presented ? { accept: true, status: "match" } : { accept: false, status: "mismatch" };
  return tofu ? { accept: true, status: "tofu" } : { accept: false, status: "unpinned-strict" };
}

function storePath(): string {
  const home = process.env.ADPIX_DEVOPS_HOME || path.join(os.homedir(), ".adpix-devops");
  return path.join(home, "known_hosts.json");
}

export function loadHostPins(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8")) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveHostPin(id: string, fingerprint: string): void {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const pins = loadHostPins();
  pins[id] = fingerprint;
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(pins, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/** Remove a pin (e.g. after a legitimate host rebuild) so the next connect re-pins. */
export function forgetHostPin(id: string): void {
  const p = storePath();
  const pins = loadHostPins();
  if (!(id in pins)) return;
  delete pins[id];
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(pins, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export interface HostKeyOutcome {
  status: HostKeyStatus;
  fingerprint: string;
  pinnedFingerprint?: string;
}

/**
 * Build the ssh2 hostVerifier callback for one connection. TOFU by default; strict
 * (reject unpinned hosts) when `tofu:false` or env ADPIX_SSH_STRICT_HOSTKEY=1. Records
 * the outcome into `outcome.value` so connect() can surface a precise error on reject.
 */
export function makeHostVerifier(
  host: string,
  port: number,
  opts: { tofu?: boolean } = {},
  outcome: { value?: HostKeyOutcome } = {}
): (key: Buffer, cb: (valid: boolean) => void) => void {
  const id = `${host}:${port}`;
  const tofu = opts.tofu ?? process.env.ADPIX_SSH_STRICT_HOSTKEY !== "1";
  return (key: Buffer, cb: (valid: boolean) => void) => {
    const fingerprint = keyFingerprint(key);
    const pinned = loadHostPins()[id];
    const d = decideHostKey(pinned, fingerprint, tofu);
    outcome.value = { status: d.status, fingerprint, pinnedFingerprint: pinned };
    if (d.accept && d.status === "tofu") saveHostPin(id, fingerprint);
    cb(d.accept);
  };
}

/** Human-readable abort reason for a rejected host key. */
export function hostKeyError(host: string, port: number, o: HostKeyOutcome): string {
  if (o.status === "mismatch") {
    return (
      `SSH host-key verification FAILED for ${host}:${port} — the host key CHANGED (possible MITM). ` +
      `Presented ${o.fingerprint}, pinned ${o.pinnedFingerprint}. ` +
      `If this is a legitimate rebuild, forget the pin (remove ${host}:${port} from known_hosts.json) and retry.`
    );
  }
  return (
    `SSH host-key for ${host}:${port} is not pinned and strict mode is on (presented ${o.fingerprint}). ` +
    `Connect once without ADPIX_SSH_STRICT_HOSTKEY to pin it after verifying the fingerprint out-of-band.`
  );
}
