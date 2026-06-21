import * as os from "node:os";
import * as path from "node:path";
import { loadRegistry, saveRegistry, type ServerConfig } from "../registry.js";
import { shq, lastLines, redactSecrets } from "../util.js";
import { setTarget } from "./journal.js";
import type { InstallStep, InstallContext, StepResult } from "./core.js";
import { renderDnsPlan } from "./dns.js";
import { renderConnect } from "./connect.js";
import { verifyInstall, renderVerify } from "./verify.js";
import { DEFAULT_CLUSTER_HOSTS, type FleetMember, type SecretsBag } from "./answers.js";

/** The MCP's own SSH identity (install-server.sh STATE_DIR/.ssh/id_ed25519). */
function mcpKeyPath(): string {
  const home = process.env.ADPIX_DEVOPS_HOME || "/var/lib/adpix-devops-mcp";
  return path.join(home, ".ssh/id_ed25519");
}

const ok = (detail: string): StepResult => ({ ok: true, detail });
const fail = (detail: string, soft = false): StepResult => ({ ok: false, detail, soft });

/**
 * A bootstrap connection config for a target: the OPERATOR's own credential, NOT the MCP
 * key. The MCP key isn't authorized on the target yet (that's what authorize-key installs),
 * so verify-ssh + authorize-key must reach the box with the operator's existing access.
 * Omitting privateKeyPath makes ssh buildAuth use: agent → default keys → ADPIX_SSH_PASSWORD.
 */
function bootstrapServer(m: FleetMember): ServerConfig {
  return { name: m.name, host: m.host, port: m.port, username: m.username, adpixDir: m.adpixDir };
}

/** Run `fn` with this target's bootstrap password (from the SecretsBag) in env, then restore. */
async function withBootstrapPassword<T>(m: FleetMember, secrets: SecretsBag, fn: () => Promise<T>): Promise<T> {
  const pw = secrets.perTarget[m.name]?.password?.reveal();
  if (!pw) return fn();
  const prev = process.env.ADPIX_SSH_PASSWORD;
  process.env.ADPIX_SSH_PASSWORD = pw;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.ADPIX_SSH_PASSWORD;
    else process.env.ADPIX_SSH_PASSWORD = prev;
  }
}

// ---------------------------------------------------------------- 01 host-install
const hostInstall: InstallStep = {
  id: "host-install",
  title: "Install the hosted MCP service (wraps install-server.sh)",
  async isDone(ctx) {
    const r = await ctx.deps.local(`curl -fsS -m 6 http://127.0.0.1:${ctx.answers.mcp.port}/healthz 2>/dev/null || true`);
    return r.stdout.trim() === "ok";
  },
  async apply(ctx) {
    const a = ctx.answers.mcp;
    const env = [
      a.domain ? `MCP_DOMAIN=${shq(a.domain)}` : "",
      `MCP_PORT=${a.port}`,
      a.repoUrl ? `REPO_URL=${shq(a.repoUrl)}` : "",
      a.branch ? `BRANCH=${shq(a.branch)}` : "",
      ctx.secrets.anthropicApiKey ? `ANTHROPIC_API_KEY=${shq(ctx.secrets.anthropicApiKey.reveal())}` : "",
    ].filter(Boolean).join(" ");
    const r = await ctx.deps.local(`${env} bash scripts/install-server.sh 2>&1`, { timeoutMs: 1_800_000 });
    return r.code === 0 ? ok("install-server.sh completed") : fail(`install-server.sh exit ${r.code}\n${redactSecrets(lastLines(r.stdout, 25))}`);
  },
  async verify(ctx) {
    const r = await ctx.deps.local(`curl -fsS -m 8 http://127.0.0.1:${ctx.answers.mcp.port}/healthz 2>/dev/null || echo FAIL`);
    return r.stdout.trim() === "ok" ? ok("/healthz = ok") : fail("service did not answer /healthz");
  },
};

// ---------------------------------------------------------------- 02 identity (pubkey + host ip + token)
const identity: InstallStep = {
  id: "identity",
  title: "Read the MCP SSH identity + host facts",
  async isDone() {
    return false; // always re-read into runtime (cheap, no mutation)
  },
  async apply(ctx) {
    const pub = await ctx.deps.local(`cat ${shq(mcpKeyPath() + ".pub")} 2>/dev/null || true`);
    if (!pub.stdout.trim().startsWith("ssh-")) return fail(`MCP pubkey not found at ${mcpKeyPath()}.pub — host-install must run first`);
    ctx.runtime.mcpPubkey = pub.stdout.trim();
    const ip = await ctx.deps.local(`hostname -I 2>/dev/null | awk '{print $1}'`);
    ctx.runtime.mcpHostIp = ip.stdout.trim() || "<this-host-ip>";
    const tok = await ctx.deps.local(`grep '^MCP_AUTH_TOKEN=' /etc/adpix-devops-mcp/env 2>/dev/null | cut -d= -f2- || true`);
    if (tok.stdout.trim()) ctx.runtime.mcpToken = tok.stdout.trim();
    return ok(`identity loaded (host ${ctx.runtime.mcpHostIp})`);
  },
  async verify(ctx) {
    return ctx.runtime.mcpPubkey ? ok("pubkey in hand") : fail("pubkey missing");
  },
};

// ---------------------------------------------------------------- 03 gather -> registry
const gatherRegistry: InstallStep = {
  id: "gather-registry",
  title: "Write the fleet + cluster into the registry",
  async isDone(ctx) {
    const reg = loadRegistry();
    return ctx.answers.fleet.every((m) => reg.servers[m.name]?.host === m.host);
  },
  async apply(ctx) {
    const reg = loadRegistry();
    const keyPath = mcpKeyPath();
    for (const m of ctx.answers.fleet) {
      reg.servers[m.name] = { host: m.host, port: m.port, username: m.username, privateKeyPath: keyPath, adpixDir: m.adpixDir, webhookUrl: m.webhookUrl };
    }
    if (!reg.defaultServer && ctx.answers.fleet[0]) reg.defaultServer = ctx.answers.fleet[0].name;
    const c = ctx.answers.cluster;
    if (c) {
      reg.clusters ??= {};
      reg.clusters[c.name] = {
        witness: ctx.answers.fleet.find((m) => m.role === "witness")?.name,
        nodes: ctx.answers.fleet.filter((m) => m.role === "node").map((m) => m.name),
        vip: c.vip,
        hosts: c.hosts.length ? c.hosts : DEFAULT_CLUSTER_HOSTS,
        idpIssuer: c.idpIssuer,
      };
    }
    if (ctx.answers.launchGate?.ack) reg.launchGate = { resolved: true, reference: ctx.answers.launchGate.reference, at: new Date().toISOString() };
    saveRegistry(reg);
    return ok(`registry: ${ctx.answers.fleet.length} server(s)${c ? " + cluster " + c.name : ""}`);
  },
  async verify(ctx) {
    const reg = loadRegistry();
    const missing = ctx.answers.fleet.filter((m) => !reg.servers[m.name]).map((m) => m.name);
    return missing.length ? fail(`not written: ${missing.join(", ")}`) : ok("registry persisted");
  },
};

// ---------------------------------------------------------------- 04 verify-ssh (per target, soft)
const verifySsh: InstallStep = {
  id: "verify-ssh",
  title: "Verify SSH reachability to each target",
  async isDone(ctx) {
    return ctx.answers.fleet.every((m) => ctx.journal.targets[m.name]?.verified);
  },
  async apply(ctx) {
    let anyFail = false;
    for (const m of ctx.answers.fleet) {
      try {
        // bootstrap credential (operator's), NOT the MCP key — it isn't authorized yet
        const s = await withBootstrapPassword(m, ctx.secrets, () => ctx.deps.connect(bootstrapServer(m)));
        try {
          const r = await s.exec(". /etc/os-release 2>/dev/null; uname -s; command -v docker >/dev/null && echo docker:yes", { timeoutMs: 25_000 });
          setTarget(ctx.journal, m.name, { verified: r.code === 0, hostKeyPinned: true, detail: r.stdout.trim().replace(/\n/g, " ").slice(0, 60) });
          if (r.code !== 0) anyFail = true;
        } finally {
          s.close();
        }
      } catch (e) {
        setTarget(ctx.journal, m.name, { verified: false, detail: (e as Error).message.split("\n")[0] });
        anyFail = true;
      }
    }
    return anyFail ? fail("one or more targets unreachable with the bootstrap credential (agent / ADPIX_SSH_PASSWORD / a key on the targets)", true) : ok("all targets reachable");
  },
  async verify(ctx) {
    const reachable = ctx.answers.fleet.filter((m) => ctx.journal.targets[m.name]?.verified).length;
    return ok(`${reachable}/${ctx.answers.fleet.length} reachable`);
  },
};

// ---------------------------------------------------------------- 05 authorize-key (restricted, per target, soft)
const authorizeKey: InstallStep = {
  id: "authorize-key",
  title: "Authorize the MCP key on each target (restricted)",
  async isDone(ctx) {
    return ctx.answers.fleet.filter((m) => m.authorizeKey).every((m) => ctx.journal.targets[m.name]?.authorized);
  },
  async apply(ctx) {
    const pub = ctx.runtime.mcpPubkey;
    if (!pub) return fail("no MCP pubkey in context (run the identity step)");
    const cidr = ctx.runtime.mcpHostIp && ctx.runtime.mcpHostIp !== "<this-host-ip>" ? ctx.runtime.mcpHostIp : null;
    // restricted authorized_keys line: source-pinned + no forwarding
    const restricted = `${cidr ? `from="${cidr}",` : ""}restrict ${pub}`;
    let anyFail = false;
    for (const m of ctx.answers.fleet) {
      if (!m.authorizeKey) {
        setTarget(ctx.journal, m.name, { authorized: false, detail: "skipped (authorizeKey:false) — add manually" });
        continue;
      }
      try {
        // 1. append the restricted MCP key using the OPERATOR's bootstrap credential (not the MCP key)
        const append = `umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF ${shq(restricted)} ~/.ssh/authorized_keys || echo ${shq(restricted)} >> ~/.ssh/authorized_keys; echo APPENDED`;
        const appended = await withBootstrapPassword(m, ctx.secrets, async () => {
          const s = await ctx.deps.connect(bootstrapServer(m));
          try {
            const r = await s.exec(append, { timeoutMs: 25_000 });
            return /APPENDED/.test(r.stdout) ? "ok" : `append failed: ${lastLines(r.stdout, 2)}`;
          } finally {
            s.close();
          }
        });
        if (appended !== "ok") {
          setTarget(ctx.journal, m.name, { authorized: false, detail: appended });
          anyFail = true;
          continue;
        }
        // 2. verify-reconnect WITH THE MCP KEY (the registry entry) — proves the key now works
        try {
          const v = await ctx.deps.connect(ctx.deps.resolve(m.name));
          try {
            await v.exec("true", { timeoutMs: 15_000 });
            setTarget(ctx.journal, m.name, { authorized: true, detail: "MCP key authorized (restricted) + reconnect verified" });
          } finally {
            v.close();
          }
        } catch (e) {
          setTarget(ctx.journal, m.name, { authorized: false, detail: `appended but the MCP-key reconnect failed: ${(e as Error).message.split("\n")[0]}` });
          anyFail = true;
        }
      } catch (e) {
        setTarget(ctx.journal, m.name, { authorized: false, detail: `bootstrap connect failed (operator credential): ${(e as Error).message.split("\n")[0]}` });
        anyFail = true;
      }
    }
    return anyFail ? fail("one or more targets not authorized (see per-target status)", true) : ok("MCP key authorized + verified on all opted-in targets");
  },
  async verify(ctx) {
    const want = ctx.answers.fleet.filter((m) => m.authorizeKey);
    const done = want.filter((m) => ctx.journal.targets[m.name]?.authorized).length;
    return ok(`${done}/${want.length} authorized`);
  },
};

// ---------------------------------------------------------------- 06 emit (DNS + connect + verify)
const emit: InstallStep = {
  id: "emit",
  title: "Emit the DNS plan + client configs + verify",
  async isDone() {
    return false; // pure output — always regenerate
  },
  async apply(ctx) {
    const a = ctx.answers;
    const hostIp = ctx.runtime.mcpHostIp || "<this-host-ip>";
    const url = a.mcp.domain ? `https://${a.mcp.domain}/mcp` : `http://${hostIp}:${a.mcp.port}/mcp`;
    const token = ctx.secrets.mcpAuthToken?.reveal() ?? ctx.runtime.mcpToken;
    const dns = a.emit.dnsPlan
      ? renderDnsPlan({ hosts: a.cluster?.hosts.length ? a.cluster.hosts : DEFAULT_CLUSTER_HOSTS, vip: a.cluster?.vip, mcpDomain: a.mcp.domain, mcpHostIp: hostIp })
      : "(DNS plan disabled)";
    const connect = renderConnect({ name: "adpix-devops", url, token, domain: a.mcp.domain, port: a.mcp.port }, a.emit.clients, { serverHost: hostIp });
    const verify = await verifyInstall(ctx.deps, { url, token, mcpDomain: a.mcp.domain, hosts: a.cluster?.hosts.length ? a.cluster.hosts : [], fleet: a.fleet });
    ctx.runtime.emitDns = dns;
    ctx.runtime.emitConnect = connect;
    ctx.runtime.emitVerify = renderVerify(verify);
    return ok(`emitted — verify ${verify.verdict}`);
  },
  async verify() {
    return ok("artifacts generated");
  },
};

/** The ordered install plan. */
export function buildSteps(): InstallStep[] {
  return [hostInstall, identity, gatherRegistry, verifySsh, authorizeKey, emit];
}

export const _steps = { hostInstall, identity, gatherRegistry, verifySsh, authorizeKey, emit };

/** Convenience: a fresh runtime-carrying context partial for callers. */
export { mcpKeyPath };
