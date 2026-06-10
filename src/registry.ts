import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Named server registry. Lives at $ADPIX_DEVOPS_HOME/servers.json
 * (default ~/.adpix-devops/servers.json), mode 600. Holds connection metadata
 * only — private keys stay wherever they already live on disk; passwords and
 * passphrases are env-only (ADPIX_SSH_PASSWORD / ADPIX_SSH_PASSPHRASE).
 */

export interface ServerConfig {
  name: string;
  host: string;
  port: number;
  username: string;
  /** Path to the SSH private key. Empty -> try ssh-agent, then default key paths. */
  privateKeyPath?: string;
  /** Where AdPix lives / will be installed on the server. */
  adpixDir: string;
  /** Optional alert webhook used by the on-server watchdog. */
  webhookUrl?: string;
}

export interface RegistryFile {
  version: 1;
  defaultServer?: string;
  servers: Record<string, Omit<ServerConfig, "name">>;
}

export function registryDir(): string {
  return process.env.ADPIX_DEVOPS_HOME || path.join(os.homedir(), ".adpix-devops");
}

export function registryPath(): string {
  return path.join(registryDir(), "servers.json");
}

export function loadRegistry(): RegistryFile {
  try {
    const raw = fs.readFileSync(registryPath(), "utf8");
    const parsed = JSON.parse(raw) as RegistryFile;
    if (!parsed.servers || typeof parsed.servers !== "object") {
      return { version: 1, servers: {} };
    }
    return parsed;
  } catch {
    return { version: 1, servers: {} };
  }
}

export function saveRegistry(reg: RegistryFile): void {
  fs.mkdirSync(registryDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2) + "\n", { mode: 0o600 });
}

/** Server assembled from ADPIX_SSH_* env vars — lets a single-server setup skip the registry. */
function envServer(): ServerConfig | undefined {
  const host = process.env.ADPIX_SSH_HOST;
  if (!host) return undefined;
  return {
    name: "env",
    host,
    port: Number(process.env.ADPIX_SSH_PORT || 22),
    username: process.env.ADPIX_SSH_USER || "root",
    privateKeyPath: process.env.ADPIX_SSH_KEY,
    adpixDir: process.env.ADPIX_DIR || "/opt/adpix",
    webhookUrl: process.env.ADPIX_WEBHOOK_URL,
  };
}

/** Fill defaults for fields an older/hand-edited registry file may omit. */
function withDefaults(name: string, s: Omit<ServerConfig, "name">): ServerConfig {
  return { name, ...s, port: s.port ?? 22, adpixDir: s.adpixDir ?? "/opt/adpix" };
}

/**
 * Resolve a server by name; with no name, fall back to the registry default,
 * then a single registered server, then ADPIX_SSH_* env vars.
 */
export function resolveServer(name?: string): ServerConfig {
  const reg = loadRegistry();
  const names = Object.keys(reg.servers);

  if (name) {
    if (name === "env") {
      const env = envServer();
      if (env) return env;
    }
    const s = reg.servers[name];
    if (!s) {
      throw new Error(
        `Unknown server "${name}". Registered: ${names.length ? names.join(", ") : "(none)"}. ` +
          `Add one with server_add, or set ADPIX_SSH_HOST/ADPIX_SSH_USER/ADPIX_SSH_KEY env vars.`
      );
    }
    return withDefaults(name, s);
  }

  if (reg.defaultServer && reg.servers[reg.defaultServer]) {
    return withDefaults(reg.defaultServer, reg.servers[reg.defaultServer]);
  }
  if (names.length === 1) {
    return withDefaults(names[0], reg.servers[names[0]]);
  }
  const env = envServer();
  if (env) return env;

  throw new Error(
    names.length === 0
      ? "No servers configured. Add one with server_add (host, username, key path), or set ADPIX_SSH_HOST env vars."
      : `Multiple servers registered (${names.join(", ")}) and no default — pass server: "<name>" or set one as default via server_add.`
  );
}
