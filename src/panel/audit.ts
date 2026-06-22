import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sha256, canonicalJson } from "./hash.js";

/**
 * Append-only, hash-chained audit log of every authenticated action. Each entry's hash covers
 * the previous hash + its own canonical content, so any edit/deletion of history is detectable
 * (verifyChain). Lives at $ADPIX_DEVOPS_HOME/audit.log (jsonl, mode 600). For real tamper-
 * resistance this should also ship in real time to an off-host WORM sink (docs §4) — exposed
 * via the shipHook so a deployment can wire that without touching this module.
 */

export interface AuditEntry {
  seq: number;
  ts: string;
  actor: string;
  role: string;
  ip: string;
  tool: string;
  target: string;
  argsHash: string;
  outcome: string;
  prevHash: string;
  hash: string;
}

export type ShipHook = (entry: AuditEntry) => void;

export function auditPath(): string {
  const home = process.env.ADPIX_DEVOPS_HOME || path.join(os.homedir(), ".adpix-devops");
  return path.join(home, "audit.log");
}

function readLines(): AuditEntry[] {
  try {
    return fs.readFileSync(auditPath(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as AuditEntry);
  } catch {
    return [];
  }
}

let shipHook: ShipHook | undefined;
export function setAuditShipHook(fn: ShipHook | undefined): void { shipHook = fn; }

export function appendAudit(e: Omit<AuditEntry, "seq" | "ts" | "prevHash" | "hash">, now = new Date()): AuditEntry {
  const p = auditPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const lines = readLines();
  const prev = lines[lines.length - 1];
  const seq = prev ? prev.seq + 1 : 1;
  const prevHash = prev ? prev.hash : "GENESIS";
  const base = { seq, ts: now.toISOString(), prevHash, ...e };
  const hash = sha256(prevHash + canonicalJson(base));
  const entry: AuditEntry = { ...base, hash };
  fs.appendFileSync(p, JSON.stringify(entry) + "\n", { mode: 0o600 });
  try { shipHook?.(entry); } catch { /* off-host shipping must never break the action */ }
  return entry;
}

export function readAudit(limit = 200): AuditEntry[] {
  const lines = readLines();
  return lines.slice(-limit).reverse();
}

/** Recompute the chain; returns the first break (or null if intact). */
export function verifyChain(): { ok: boolean; brokenAtSeq?: number } {
  const lines = readLines();
  let prevHash = "GENESIS";
  for (const e of lines) {
    const { hash, ...rest } = e;
    const expect = sha256(prevHash + canonicalJson({ ...rest, prevHash }));
    if (e.prevHash !== prevHash || expect !== hash) return { ok: false, brokenAtSeq: e.seq };
    prevHash = hash;
  }
  return { ok: true };
}
