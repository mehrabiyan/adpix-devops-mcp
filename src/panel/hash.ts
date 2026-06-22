import { createHash } from "node:crypto";

/** Stable JSON (sorted keys) so a hash of args is deterministic regardless of key order. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function argsHash(args: Record<string, unknown>): string {
  return sha256(canonicalJson(args));
}
