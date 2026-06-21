import { inspect } from "node:util";

/**
 * The single input contract both installer front-ends (shell TUI + web wizard) fill.
 * Secret-free + loggable. Secrets travel separately in a SecretsBag (below) and never
 * enter this object, the journal, the registry, or any log.
 */

export type FleetRole = "witness" | "node" | "standalone";
export type BootstrapAuth = "agent" | "password" | "keyfile";
export type ClientKind = "claude-code" | "claude-desktop" | "generic";

export interface FleetMember {
  name: string;
  host: string;
  port: number;
  username: string;
  role: FleetRole;
  adpixDir: string;
  webhookUrl?: string;
  /** Auto-append the MCP pubkey to this target's authorized_keys (restricted). */
  authorizeKey: boolean;
  /** How we first reach the target to install the MCP key (one-shot bootstrap). */
  bootstrapAuth: BootstrapAuth;
}

export interface InstallAnswers {
  mcp: {
    domain?: string;
    port: number;
    bindHost: string;
    tokenMode: "preserve" | "generate" | "provided";
    repoUrl?: string;
    branch?: string;
    apiKeyMode: "none" | "provided" | "preserve";
  };
  fleet: FleetMember[];
  cluster?: { name: string; vip?: string; idpIssuer: string; hosts: string[] };
  launchGate?: { ack: boolean; reference?: string };
  emit: { clients: ClientKind[]; dnsPlan: boolean };
  resume?: boolean;
}

/** The 8 public launch hosts (kept in sync with src/launch/hosts.ts DEFAULT_LAUNCH_HOSTS). */
export const DEFAULT_CLUSTER_HOSTS = [
  "account.adpix.io", "tagmanager.adpix.io", "analytics.adpix.io", "api.adpix.io",
  "cdn.adpix.net", "collect.adpix.net", "config.adpix.net", "gateway.adpix.net",
];

export function defaultAnswers(): InstallAnswers {
  return {
    mcp: { port: 8930, bindHost: "127.0.0.1", tokenMode: "preserve", apiKeyMode: "preserve" },
    fleet: [],
    emit: { clients: ["claude-code"], dnsPlan: true },
  };
}

const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const FQDN_RE = /^(?=.{1,253}$)([a-zA-Z0-9](-?[a-zA-Z0-9])*\.)+[a-zA-Z]{2,}$/;

/** Pure validation of an InstallAnswers object. Returns every problem, never throws. */
export function validateAnswers(a: InstallAnswers): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!Number.isInteger(a.mcp.port) || a.mcp.port < 1 || a.mcp.port > 65535) errors.push(`mcp.port ${a.mcp.port} is not a valid port`);
  if (a.mcp.domain && !FQDN_RE.test(a.mcp.domain)) errors.push(`mcp.domain "${a.mcp.domain}" is not a valid FQDN`);
  if (a.mcp.bindHost !== "127.0.0.1" && a.mcp.bindHost !== "0.0.0.0" && a.mcp.bindHost !== "::1") errors.push(`mcp.bindHost "${a.mcp.bindHost}" must be 127.0.0.1 / ::1 / 0.0.0.0`);
  const tokenWillExist = (["preserve", "generate", "provided"] as string[]).includes(a.mcp.tokenMode);
  if (a.mcp.bindHost === "0.0.0.0" && !tokenWillExist) errors.push(`binding 0.0.0.0 requires an auth token (tokenMode must yield a token)`);

  const seen = new Set<string>();
  for (const m of a.fleet) {
    if (!NAME_RE.test(m.name)) errors.push(`fleet member name "${m.name}" must match ${NAME_RE}`);
    if (seen.has(m.name)) errors.push(`duplicate fleet member name "${m.name}"`);
    seen.add(m.name);
    if (!m.host) errors.push(`fleet member "${m.name}" has no host`);
    if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535) errors.push(`fleet member "${m.name}" port ${m.port} invalid`);
    if (!m.username) errors.push(`fleet member "${m.name}" has no username`);
  }

  if (a.cluster) {
    if (!NAME_RE.test(a.cluster.name)) errors.push(`cluster name "${a.cluster.name}" must match ${NAME_RE}`);
    const members = a.cluster.hosts;
    if (!members || members.length === 0) errors.push(`cluster "${a.cluster.name}" has no hosts`);
    // witness/nodes are fleet member names referenced by role
    const witnesses = a.fleet.filter((m) => m.role === "witness").map((m) => m.name);
    const nodes = a.fleet.filter((m) => m.role === "node").map((m) => m.name);
    if (a.cluster && witnesses.length > 1) errors.push(`cluster "${a.cluster.name}" has ${witnesses.length} witnesses (expected 0–1)`);
    if (a.cluster && nodes.length === 0 && witnesses.length === 0) errors.push(`cluster "${a.cluster.name}" references no witness/node fleet members (set role on the fleet entries)`);
  }
  if (a.launchGate?.ack && !a.launchGate.reference) errors.push(`launchGate.ack requires a reference (audit commit/ticket)`);

  return { ok: errors.length === 0, errors };
}

/**
 * A secret value that refuses to print itself — toString/toJSON/util.inspect all
 * redact to "***", so a stray log line or JSON.stringify can never leak it.
 */
export class Secret {
  constructor(private readonly value: string) {}
  reveal(): string { return this.value; }
  isEmpty(): boolean { return this.value.length === 0; }
  toString(): string { return "***"; }
  toJSON(): string { return "***"; }
  [inspect.custom](): string { return "Secret(***)"; }
}

export interface SecretsBag {
  mcpAuthToken?: Secret;
  anthropicApiKey?: Secret;
  /** keyed by fleet member name */
  perTarget: Record<string, { password?: Secret; passphrase?: Secret; pastedKey?: Secret }>;
}

/** Build a SecretsBag from the environment (the non-interactive path). */
export function secretsFromEnv(env: NodeJS.ProcessEnv = process.env): SecretsBag {
  const bag: SecretsBag = { perTarget: {} };
  if (env.MCP_AUTH_TOKEN) bag.mcpAuthToken = new Secret(env.MCP_AUTH_TOKEN);
  if (env.ANTHROPIC_API_KEY) bag.anthropicApiKey = new Secret(env.ANTHROPIC_API_KEY);
  return bag;
}
