import * as fs from "node:fs";
import * as path from "node:path";
import type { Deps } from "../deps.js";
import { registryDir } from "../registry.js";
import { shq } from "../util.js";

/**
 * Panel SSH key management. Keys live alongside the registry ($ADPIX_DEVOPS_HOME/.ssh, default
 * ~/.adpix-devops/.ssh) — writable wherever the panel runs (not the installer's /var/lib path),
 * so password-bootstrap + key-upload work locally too. The registry stores key PATHS, never
 * password bytes (the launch invariant).
 */
export function panelKeyDir(): string {
  return path.join(registryDir(), ".ssh");
}
export function panelMcpKeyPath(): string {
  return path.join(panelKeyDir(), "id_ed25519");
}

/** Generate the panel's MCP keypair if it doesn't exist yet; returns its private-key path. */
export async function ensureMcpKey(deps: Deps): Promise<string> {
  const keyPath = panelMcpKeyPath();
  if (fs.existsSync(keyPath) && fs.existsSync(keyPath + ".pub")) return keyPath;
  fs.mkdirSync(panelKeyDir(), { recursive: true, mode: 0o700 });
  const r = await deps.local(`ssh-keygen -t ed25519 -N "" -C adpix-devops-mcp -f ${shq(keyPath)} <<< y`, { timeoutMs: 30_000 });
  if (!fs.existsSync(keyPath + ".pub")) throw new Error(`could not generate the MCP key at ${keyPath} (is ssh-keygen installed?): ${r.stderr || r.stdout}`.trim());
  return keyPath;
}

/** Persist an uploaded/pasted private key to a mode-600 file and return its path. */
export function saveUploadedKey(name: string, pem: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "-") || "server";
  fs.mkdirSync(panelKeyDir(), { recursive: true, mode: 0o700 });
  const p = path.join(panelKeyDir(), `${safe}.key`);
  const body = pem.endsWith("\n") ? pem : pem + "\n";
  fs.writeFileSync(p, body, { mode: 0o600 });
  return p;
}
