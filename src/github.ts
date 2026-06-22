import * as path from "node:path";
import type { Session } from "./ssh.js";
import type { Deps } from "./deps.js";
import { registryDir } from "./registry.js";
import { shq } from "./util.js";

/**
 * Read-only GitHub deploy keys for cloning private repos on a server. One
 * canonical key path per server so adpix_install and cicd_enable share it: a
 * repo authorized at install time is already authorized for continuous deploy.
 */
export const ADPIX_DEPLOY_KEY_PATH = "/root/.ssh/adpix_deploy_ed25519";

/** ssh options used for every deploy-key git operation (no prompts, pinned key). */
function sshOpts(keyPath: string, batch = false): string {
  return (
    `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` +
    (batch ? " -o BatchMode=yes" : "")
  );
}

/** `GIT_SSH_COMMAND=...` prefix (with trailing space) for an inline git call. */
export function gitSshEnv(keyPath: string): string {
  return `GIT_SSH_COMMAND=${shq(sshOpts(keyPath))} `;
}

/** Value to persist as the repo's `core.sshCommand` so later pulls reuse the key. */
export function coreSshCommand(keyPath: string): string {
  return sshOpts(keyPath);
}

/** Parse owner/repo from an https or ssh GitHub remote URL. */
export function parseGithubRemote(url: string): { owner: string; repo: string } | undefined {
  const m =
    url.trim().match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/) ||
    url.trim().match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

/** Normalize any GitHub URL to its SSH form (`git@github.com:owner/repo.git`). */
export function toSshUrl(url: string): string | undefined {
  const gh = parseGithubRemote(url);
  return gh ? `git@github.com:${gh.owner}/${gh.repo}.git` : undefined;
}

export interface DeployKeyStatus {
  pubKey: string;
  sshUrl: string;
  owner: string;
  repo: string;
  /** Whether the key already grants access (git ls-remote succeeds). */
  authorized: boolean;
}

/**
 * Ensure a deploy key exists on the server and report whether it's authorized
 * for the repo yet. Does NOT clone or change any checkout — callers decide.
 */
export async function ensureDeployKey(
  s: Session,
  repoUrl: string,
  keyPath: string = ADPIX_DEPLOY_KEY_PATH
): Promise<DeployKeyStatus> {
  const gh = parseGithubRemote(repoUrl);
  if (!gh) throw new Error(`Not a GitHub repo URL: ${repoUrl}`);
  const sshUrl = `git@github.com:${gh.owner}/${gh.repo}.git`;

  await s.exec(
    `install -d -m700 "$(dirname ${shq(keyPath)})" && ` +
      `[ -f ${shq(keyPath)} ] || ssh-keygen -t ed25519 -N '' -C "adpix-deploy@$(hostname)" -f ${shq(keyPath)} >/dev/null 2>&1`
  );
  const pub = (await s.exec(`cat ${shq(keyPath + ".pub")} 2>/dev/null`)).stdout.trim();
  const test = await s.exec(
    `GIT_SSH_COMMAND=${shq(sshOpts(keyPath, true))} git ls-remote ${shq(sshUrl)} HEAD >/dev/null 2>&1 && echo OK || echo NO`,
    { timeoutMs: 45_000 }
  );
  return { pubKey: pub, sshUrl, owner: gh.owner, repo: gh.repo, authorized: /\bOK\b/.test(test.stdout) };
}

/**
 * Shared deploy key managed on the MCP (control plane) and reused for every server.
 *
 * The key lives on the MCP under registryDir()/.ssh and is added to GitHub ONCE. On each install
 * the MCP checks it's authorized (ls-remote, run locally on the MCP), then distributes it to the
 * target server at the canonical per-server path (the same path cicd_enable expects). So adding a
 * new server needs NO new GitHub deploy key — unlike per-server keygen.
 *
 * keyName "adpix" → /root/.ssh/adpix_deploy_ed25519; "adpix_tm" → /root/.ssh/adpix_tm_deploy_ed25519.
 */
export interface SharedKeyStatus { pubKey: string; sshUrl: string; owner: string; repo: string; authorized: boolean; prodKeyPath: string }
export async function ensureSharedDeployKey(deps: Deps, s: Session, repoUrl: string, keyName: string): Promise<SharedKeyStatus> {
  const gh = parseGithubRemote(repoUrl);
  if (!gh) throw new Error(`Not a GitHub repo URL: ${repoUrl}`);
  const sshUrl = `git@github.com:${gh.owner}/${gh.repo}.git`;
  const dir = path.join(registryDir(), ".ssh");
  const keyPath = path.join(dir, `${keyName}_deploy_ed25519`);
  const prodKeyPath = `/root/.ssh/${keyName}_deploy_ed25519`;

  // 1. Ensure the canonical key exists ON THE MCP (generate once, never on the prod servers).
  await deps.local(
    `install -d -m700 ${shq(dir)} && [ -f ${shq(keyPath)} ] || ssh-keygen -t ed25519 -N '' -C ${shq("adpix-deploy-mcp")} -f ${shq(keyPath)} >/dev/null 2>&1`,
    { timeoutMs: 30_000 }
  );
  const pub = (await deps.local(`cat ${shq(keyPath + ".pub")} 2>/dev/null`)).stdout.trim();

  // 2. Authorized on GitHub? Checked from the MCP (it has GitHub egress for its own self-update).
  const test = await deps.local(
    `GIT_SSH_COMMAND=${shq(sshOpts(keyPath, true))} git ls-remote ${shq(sshUrl)} HEAD >/dev/null 2>&1 && echo OK || echo NO`,
    { timeoutMs: 45_000 }
  );
  const authorized = /\bOK\b/.test(test.stdout);
  if (!authorized) return { pubKey: pub, sshUrl, owner: gh.owner, repo: gh.repo, authorized: false, prodKeyPath };

  // 3. Distribute the (read-only) key to the target server at the canonical path. base64 over the
  // wire to avoid any quoting/newline trouble; written 0600 under a tight umask.
  const b64 = (await deps.local(`base64 < ${shq(keyPath)} | tr -d '\\n'`)).stdout.trim();
  await s.exec(`umask 077; install -d -m700 "$(dirname ${shq(prodKeyPath)})" && printf %s ${shq(b64)} | base64 -d > ${shq(prodKeyPath)} && chmod 600 ${shq(prodKeyPath)}`);
  return { pubKey: pub, sshUrl, owner: gh.owner, repo: gh.repo, authorized: true, prodKeyPath };
}

/** Instructions for authorizing the ONE shared MCP deploy key (added to GitHub a single time). */
export function sharedKeyInstructions(st: SharedKeyStatus): string {
  return [
    `This private repo needs ONE read-only deploy key — it is managed on the MCP and reused for every server you add.`,
    ``,
    `    ${st.pubKey || "(key generation failed on the MCP — check ssh-keygen there)"}`,
    ``,
    `→ https://github.com/${st.owner}/${st.repo}/settings/keys  (Add deploy key; leave "Allow write access" UNCHECKED)`,
    `Add it once. Every server the MCP provisions reuses this key automatically — no per-server key.`,
  ].join("\n");
}

/** Human instructions for authorizing a not-yet-authorized deploy key. */
export function deployKeyInstructions(st: DeployKeyStatus): string {
  return [
    `This private repo needs a dedicated READ-ONLY deploy key. Add this key to GitHub:`,
    ``,
    `    ${st.pubKey || "(key generation failed — check ssh-keygen on the server)"}`,
    ``,
    `→ https://github.com/${st.owner}/${st.repo}/settings/keys  (Add deploy key; leave "Allow write access" UNCHECKED)`,
    `Then re-run the same command — the key is detected automatically, nothing else changes.`,
  ].join("\n");
}
