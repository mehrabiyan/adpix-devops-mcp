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

/**
 * A multi-VM HA cluster (the launch topology, DEPLOYMENT_SRE §4): one witness
 * (observability + quorum 3rd-vote + this MCP, never serves traffic) + ≥1 HA
 * serving node, reached through a floating VIP, fronting the public host list.
 * Members are server *names* from `servers` so connection metadata isn't duplicated.
 */
export interface ClusterConfig {
  name: string;
  /** Floating VIP host/IP (keepalived/VRRP) — the single integration point. */
  vip?: string;
  /** Server name of the witness node (MCP/observability/quorum arbiter). */
  witness?: string;
  /** Server names of the active-active HA serving nodes. */
  nodes: string[];
  /** Public host list the front-door Caddy serves (the Caddy SITE_ADDRESS set). */
  hosts: string[];
  /** OIDC issuer base for the shared IdP (account.adpix.io) — the cross-product SPOF. */
  idpIssuer?: string;
}

/** Launch go/no-go attestation (Gate 0 — the Analytics P1 blockers, DEPLOYMENT_SRE §11). */
export interface LaunchGate {
  resolved: boolean;
  /** Audit commit/date or ticket proving the P1 blockers are fixed. */
  reference?: string;
  /** ISO timestamp the attestation was recorded. */
  at?: string;
}

export interface RegistryFile {
  version: 1;
  defaultServer?: string;
  servers: Record<string, Omit<ServerConfig, "name">>;
  clusters?: Record<string, Omit<ClusterConfig, "name">>;
  launchGate?: LaunchGate;
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

/**
 * Name of an already-registered server with the same host:port (excluding `exceptName`), or
 * undefined. A host must map to ONE name — registering it twice (e.g. as both a witness and a
 * data node) silently corrupts quorum math (3 "votes" that are really 1 machine) and double-probes
 * the same box.
 */
export function findServerByHost(reg: RegistryFile, host: string, port = 22, exceptName?: string): string | undefined {
  const h = host.trim().toLowerCase();
  for (const [name, s] of Object.entries(reg.servers)) {
    if (name === exceptName) continue;
    if (s.host.trim().toLowerCase() === h && (s.port ?? 22) === port) return name;
  }
  return undefined;
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

/** Resolve a cluster by name; with no name fall back to the single defined cluster. */
export function resolveCluster(name?: string): ClusterConfig {
  const reg = loadRegistry();
  const names = Object.keys(reg.clusters ?? {});
  if (name) {
    const c = reg.clusters?.[name];
    if (!c) {
      throw new Error(
        `Unknown cluster "${name}". Defined: ${names.length ? names.join(", ") : "(none)"}. Define one with cluster_define.`
      );
    }
    return { name, ...c, nodes: c.nodes ?? [], hosts: c.hosts ?? [] };
  }
  if (names.length === 1) {
    const c = reg.clusters![names[0]];
    return { name: names[0], ...c, nodes: c.nodes ?? [], hosts: c.hosts ?? [] };
  }
  throw new Error(
    names.length === 0
      ? "No clusters defined. Create one with cluster_define (witness + nodes + the public host list)."
      : `Multiple clusters defined (${names.join(", ")}) — pass cluster: "<name>".`
  );
}
