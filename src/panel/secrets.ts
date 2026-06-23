import * as fs from "node:fs";
import * as path from "node:path";
import { registryDir } from "../registry.js";

/**
 * Panel-managed secrets the operator can set from the UI (so they don't have to edit the root-owned
 * /etc/adpix-devops-mcp/env by hand). Stored mode-600 under the MCP service user's registry dir —
 * the service can write here but NOT /etc. Only the Anthropic key (for the Assistant) lives here so
 * far. SSH passwords are still never persisted (that invariant is unchanged).
 */
function secretsPath(): string { return path.join(registryDir(), "secrets.json"); }
function load(): Record<string, string> { try { return JSON.parse(fs.readFileSync(secretsPath(), "utf8")); } catch { return {}; } }
function save(o: Record<string, string>): void {
  fs.mkdirSync(registryDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(secretsPath(), JSON.stringify(o, null, 2) + "\n", { mode: 0o600 });
}

/** Effective Anthropic key: a panel-set value wins over the host env (so the UI is authoritative). */
export function getAnthropicKey(): string | undefined {
  const stored = (load().anthropicApiKey || "").trim();
  return stored || process.env.ANTHROPIC_API_KEY || undefined;
}

export function anthropicKeyStatus(): { configured: boolean; source: "panel" | "env" | "none" } {
  if ((load().anthropicApiKey || "").trim()) return { configured: true, source: "panel" };
  if (process.env.ANTHROPIC_API_KEY) return { configured: true, source: "env" };
  return { configured: false, source: "none" };
}

export function setAnthropicKey(key: string): void { const o = load(); o.anthropicApiKey = key.trim(); save(o); }
export function clearAnthropicKey(): void { const o = load(); delete o.anthropicApiKey; save(o); }
