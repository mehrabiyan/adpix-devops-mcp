import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import type { Deps } from "../src/deps.js";
import type { ServerConfig } from "../src/registry.js";
import type { ExecResult, Session } from "../src/ssh.js";
import { allTools } from "../src/tools/index.js";
import { coreSshCommand, gitSshEnv } from "../src/github.js";
import { servePanel } from "../src/panel/server.js";

/**
 * Production deploy-flow regression suite.
 *
 * Every section pins a class of failure we actually hit while bringing the Setup Wizard to a working
 * end-to-end deploy, so a regression would turn red here instead of on a live server:
 *
 *   A  deploy-key authorization probe authenticated via the OPERATOR'S personal key → false "authorized"
 *   B  Account/IdP crashed on boot (NODE_ENV=production, no OIDC key) → health 000000
 *   C  an existing checkout in a broken git state couldn't fetch even with an authorized key
 *   D  `git clone -b main` failed when the repo's default branch differed
 *   E  the wizard marked a deploy "done" although the install soft-failed (returned text, exit 0)
 *   F  panel endpoints behind the wizard (version nudge, verify-repos, verify-deploy)
 *   G  the full happy path: account → tag manager → analytics all reach healthy on one server
 *
 * Uses the established fake-Session harness: `responses` answer the prod SESSION (deps.connect), and
 * `localResponses` answer the MCP host (deps.local) where the shared deploy key is generated + checked.
 */

type Resp = [RegExp, Partial<ExecResult> | ((c: string) => Partial<ExecResult>)];
function pick(responses: Resp[], cmd: string): ExecResult {
  for (const [re, res] of responses) if (re.test(cmd)) return { code: 0, stdout: "", stderr: "", ...(typeof res === "function" ? res(cmd) : res) };
  // Default (no explicit responder): a cloned, running stack — so post-deploy verification passes.
  // Tests that need "not cloned"/"not up" provide their own responder, which matches first.
  return { code: 0, stdout: /com\.docker\.compose\.project=.* -q/.test(cmd) ? "1 1" : /&& echo yes \|\| echo no/.test(cmd) ? "yes" : "", stderr: "" };
}
function fakeDeps(responses: Resp[], localResponses: Resp[] = []) {
  const calls: string[] = []; const localCalls: string[] = [];
  const server: ServerConfig = { name: "prod", host: "10.0.0.3", port: 22, username: "root", adpixDir: "/opt/adpix" };
  const session: Session = { server, authMethod: "publickey", close: () => {}, exec: async (cmd: string) => { calls.push(cmd); return pick(responses, cmd); } };
  const deps: Deps = { resolve: () => server, connect: async () => session, local: async (cmd: string) => { localCalls.push(cmd); return pick(localResponses, cmd); } };
  return { deps, calls, localCalls };
}
const tool = (name: string) => { const t = allTools.find((t) => t.name === name); if (!t) throw new Error(`tool ${name} not registered`); return t; };

const PEM = "-----BEGIN PRIVATE KEY-----\nMIIabcDEF123\n-----END PRIVATE KEY-----\n";
const KEY_AUTHORIZED: Resp[] = [[/adpix.*_deploy_ed25519\.pub/, { stdout: "ssh-ed25519 AAAASHARED mcp" }], [/git ls-remote/, { stdout: "OK" }], [/base64 </, { stdout: "QkFTRTY0" }]];
const KEY_UNAUTHORIZED: Resp[] = [[/adpix.*_deploy_ed25519\.pub/, { stdout: "ssh-ed25519 AAAANEW mcp" }], [/git ls-remote/, { stdout: "NO" }]];

// ════════════════════════════════════════════ A. deploy-key isolation (false "authorized") ════════
describe("A. deploy-key probe isolates the deploy key (no personal-key / agent leakage)", () => {
  it("every git ssh op carries IdentitiesOnly + IdentityAgent=none + -F /dev/null", () => {
    for (const ssh of [coreSshCommand("/k"), gitSshEnv("/k")]) {
      expect(ssh).toContain("-o IdentitiesOnly=yes");   // ignore ssh-agent's other identities
      expect(ssh).toContain("-o IdentityAgent=none");   // ignore the agent entirely
      expect(ssh).toContain("-F /dev/null");            // ignore ~/.ssh/config's Host github.com IdentityFile
    }
  });

  it("the ls-remote authorization probe (run on the MCP) uses the isolation flags", async () => {
    const { deps, localCalls } = fakeDeps([[/command -v git/, { code: 0 }]], KEY_UNAUTHORIZED);
    await tool("adpix_install").handler(deps, { branch: "main", repoUrl: "https://github.com/mehrabiyan/adpix.git", skipPreflight: true, timeoutSeconds: 600, deployKey: true });
    const probe = localCalls.find((c) => c.includes("git ls-remote"));
    expect(probe).toBeDefined();
    expect(probe).toContain("-o IdentitiesOnly=yes");
    expect(probe).toContain("-o IdentityAgent=none");
    expect(probe).toContain("-F /dev/null");
  });

  it("the server-side clone over SSH carries the same isolation flags", async () => {
    const { deps, calls } = fakeDeps(
      [[/command -v git/, { code: 0 }], [/git clone/, { code: 0 }], [/deploy\.sh/, { code: 0, stdout: "AdPix Analytics is running." }], [/for i in \$\(seq/, { code: 0, stdout: "healthy after ~5s (HTTP 200)" }], [/PUBLIC_BASE_URL/, { stdout: "http://10.0.0.3" }]],
      KEY_AUTHORIZED,
    );
    await tool("adpix_install").handler(deps, { branch: "main", repoUrl: "https://github.com/mehrabiyan/adpix.git", skipPreflight: true, timeoutSeconds: 600, deployKey: true });
    const clone = calls.find((c) => c.includes("git clone"));
    expect(clone).toContain("-o IdentityAgent=none");
    expect(clone).toContain("-F /dev/null");
  });
});

// ════════════════════════════════════════════ B. Account/IdP OIDC signing key (boot crash) ════════
function accountDeps(extra: Resp[] = [], local: Resp[] = KEY_AUTHORIZED) {
  return fakeDeps([
    [/docker compose version/, { stdout: "ok" }], [/command -v git/, { code: 0 }], [/git (clone|fetch)/, { code: 0 }],
    [/BOOTSTRAP_ADMIN_PASSWORD=/, { stdout: "" }], [/openssl rand/, { stdout: "adminpw" }],
    [/base64 -d/, { code: 0 }], [/-p adpix-account .*build/, { code: 0 }], [/-p adpix-account .*up -d/, { code: 0 }],
    ...extra,
  ], local);
}
const composeYaml = (calls: string[]) => {
  const c = calls.find((x) => x.includes("docker-compose.auth.yml") && x.includes("base64 -d"));
  const b64 = c?.match(/echo '([A-Za-z0-9+/=]+)'/)?.[1] ?? "";
  return Buffer.from(b64, "base64").toString("utf8");
};
const ACCOUNT_ARGS = { dir: "/opt/adpix-tagmanager", repoUrl: "https://github.com/mehrabiyan/AdpixTagManager.git", branch: "main", port: 9696, timeoutSeconds: 2400 };

describe("B. account_install embeds a stable OIDC key so the IdP can boot under NODE_ENV=production", () => {
  it("embeds OIDC_PRIVATE_KEY_PEM in the compose (reusing the existing key, no regen)", async () => {
    const { deps, calls } = accountDeps([[/cat .*oidc_key\.pem/, { stdout: PEM }], [/9696\/healthz/, { code: 0, stdout: "healthy after ~10s" }]]);
    const out = await tool("account_install").handler(deps, ACCOUNT_ARGS);
    const yaml = composeYaml(calls);
    expect(yaml).toContain("OIDC_PRIVATE_KEY_PEM: |");        // multi-line literal block, not an env-file
    expect(yaml).toContain("BEGIN PRIVATE KEY");
    expect(yaml).toContain("NODE_ENV: production");
    expect(calls.some((c) => /openssl genpkey/.test(c))).toBe(false);  // existing key reused (idempotent)
    expect(out).toMatch(/Account\/IdP up/);
    // the wizard now judges deploy success by the RESULT markdown — a healthy install must NOT trip
    // its failure markers (regression: the benign first-attempt `could not read Username` and the
    // health-gate command echo `NOT healthy…` used to false-flag a healthy IdP as "failed").
    expect(out).not.toMatch(/## (Checkout|Deploy) FAILED|Deploy INCOMPLETE|Account NOT healthy|Nothing installed yet/);
  });

  it("generates the key once when none exists yet", async () => {
    let n = 0;
    const { deps, calls } = accountDeps([[/cat .*oidc_key\.pem/, () => ({ stdout: n++ === 0 ? "" : PEM })], [/9696\/healthz/, { code: 0, stdout: "healthy after ~10s" }]]);
    await tool("account_install").handler(deps, ACCOUNT_ARGS);
    expect(calls.some((c) => /openssl genpkey -algorithm RSA/.test(c))).toBe(true);
    expect(composeYaml(calls)).toContain("OIDC_PRIVATE_KEY_PEM");
  });

  it("with a domain, fronts the IdP with Caddy (auto Let's Encrypt on :443) + opens the firewall", async () => {
    const { deps, calls } = accountDeps([
      [/cat .*oidc_key\.pem/, { stdout: PEM }],
      [/9696\/healthz/, { code: 0, stdout: "healthy after ~10s" }],
      [/auth\.adpix\.io:443:127\.0\.0\.1/, { code: 0, stdout: "ready (HTTPS 200)" }],
    ]);
    const out = await tool("account_install").handler(deps, { ...ACCOUNT_ARGS, domain: "auth.adpix.io" });
    const yaml = composeYaml(calls);
    expect(yaml).toContain("caddy:");
    expect(yaml).toContain('"443:443"');
    expect(yaml).toContain("caddy_data");
    expect(calls.some((c) => /Caddyfile\.account/.test(c))).toBe(true);          // Caddyfile written
    expect(calls.some((c) => /ufw allow 443/.test(c))).toBe(true);               // host firewall opened (best-effort)
    expect(out).toMatch(/Let's Encrypt/);
    expect(out).toMatch(/ready \(HTTPS 200\)/);
  });

  it("on a health-gate failure, surfaces the auth container logs (not a bare 'NOT healthy')", async () => {
    const { deps } = accountDeps([
      [/cat .*oidc_key\.pem/, { stdout: PEM }],
      [/9696\/healthz/, { code: 1, stdout: "NOT healthy after 150s (last 000)" }],
      [/logs --no-color --tail 60 auth/, { stdout: "Error: OIDC_PRIVATE_KEY_PEM is required in production (no ephemeral keys)" }],
    ]);
    const out = await tool("account_install").handler(deps, ACCOUNT_ARGS);
    expect(out).toContain("NOT healthy");
    expect(out).toContain("auth container logs");
    expect(out).toContain("OIDC_PRIVATE_KEY_PEM is required in production");
  });
});

// ════════════════════════════════════════════ C. checkout self-heal (broken git state) ════════════
describe("C. a broken existing checkout is normalized, then re-cloned if it still can't fetch", () => {
  it("adpix_install: fetch fails twice with an authorized key → rm -rf + fresh clone, .env preserved", async () => {
    let n = 0;
    const { deps, calls } = fakeDeps(
      [
        [/command -v git/, { code: 0 }],
        // 1) https update (no creds) 2) ssh update STILL fails (broken checkout) 3) fresh clone OK
        [/git (clone|fetch)/, () => { n++; if (n === 1) return { code: 128, stderr: "fatal: could not read Username for 'https://github.com': No such device or address" }; if (n === 2) return { code: 1, stderr: "git@github.com: Permission denied (publickey)." }; return { code: 0 }; }],
        [/test -d.*\.git.* && echo yes/, { stdout: "yes" }],   // reclone guard sees the stale checkout
        [/deploy\.sh/, { code: 0, stdout: "AdPix Analytics is running." }],
        [/for i in \$\(seq/, { code: 0, stdout: "healthy after ~5s (HTTP 200)" }],
        [/PUBLIC_BASE_URL/, { stdout: "http://10.0.0.3" }],
      ],
      KEY_AUTHORIZED,
    );
    const out = await tool("adpix_install").handler(deps, { branch: "main", repoUrl: "https://github.com/mehrabiyan/adpix.git", skipPreflight: true, timeoutSeconds: 600, deployKey: false });
    expect(n).toBe(3);                                         // tried https, ssh-update, then fresh clone
    expect(calls.some((c) => /cp .*adpix-reclone\.env/.test(c))).toBe(true);   // secrets backed up
    expect(calls.some((c) => /rm -rf '\/opt\/adpix'/.test(c))).toBe(true);             // stale checkout wiped
    expect(out).toContain("Repo reset");
    expect(out).toContain("http://10.0.0.3");                  // ...and the deploy completed
  });

  it("adpix_install update path re-points origin at the SSH url before fetching", async () => {
    const { deps, calls } = fakeDeps(
      [[/command -v git/, { code: 0 }], [/git (clone|fetch)/, { code: 0 }], [/deploy\.sh/, { code: 0, stdout: "running." }], [/for i in \$\(seq/, { code: 0, stdout: "healthy" }], [/PUBLIC_BASE_URL/, { stdout: "http://10.0.0.3" }]],
      KEY_AUTHORIZED,
    );
    await tool("adpix_install").handler(deps, { branch: "main", repoUrl: "git@github.com:mehrabiyan/adpix.git", skipPreflight: true, timeoutSeconds: 600, deployKey: true });
    expect(calls.some((c) => /git remote set-url origin 'git@github\.com:mehrabiyan\/adpix\.git'/.test(c))).toBe(true);
  });

  it("checkoutTmRepo (account_install): broken checkout → reclone preserving deploy secrets", async () => {
    let n = 0;
    const { deps, calls } = fakeDeps(
      [
        [/docker compose version/, { stdout: "ok" }], [/command -v git/, { code: 0 }],
        [/git (clone|fetch)/, () => { n++; return n <= 2 ? { code: 1, stderr: "git@github.com: Permission denied (publickey)." } : { code: 0 }; }],
        [/test -d.*\.git.* && echo yes/, { stdout: "yes" }],
        [/cat .*oidc_key\.pem/, { stdout: PEM }], [/BOOTSTRAP_ADMIN_PASSWORD=/, { stdout: "" }], [/openssl rand/, { stdout: "pw" }],
        [/base64 -d/, { code: 0 }], [/-p adpix-account .*build/, { code: 0 }], [/-p adpix-account .*up -d/, { code: 0 }],
        [/9696\/healthz/, { code: 0, stdout: "healthy after ~10s" }],
      ],
      KEY_AUTHORIZED,
    );
    const out = await tool("account_install").handler(deps, ACCOUNT_ARGS);
    expect(calls.some((c) => /oidc_key\.pem.*tm-reclone/.test(c))).toBe(true);  // OIDC key preserved across reclone
    expect(calls.some((c) => /rm -rf '\/opt\/adpix-tagmanager'/.test(c))).toBe(true);
    expect(out).toContain("Repo reset");
    expect(out).toMatch(/Account\/IdP up/);
  });
});

// ════════════════════════════════════════════ D. branch-agnostic clone ════════════════════════════
describe("D. clone is branch-agnostic (no `git clone -b`, so a differing default branch can't fail)", () => {
  it("adpix_install clones without -b and checks out the branch afterward", async () => {
    const { deps, calls } = fakeDeps(
      [[/command -v git/, { code: 0 }], [/git clone/, { code: 0 }], [/deploy\.sh/, { code: 0, stdout: "running." }], [/for i in \$\(seq/, { code: 0, stdout: "healthy" }], [/PUBLIC_BASE_URL/, { stdout: "http://10.0.0.3" }]],
      KEY_AUTHORIZED,
    );
    await tool("adpix_install").handler(deps, { branch: "main", repoUrl: "https://github.com/mehrabiyan/adpix.git", skipPreflight: true, timeoutSeconds: 600, deployKey: true });
    const clone = calls.find((c) => c.includes("git clone"))!;
    expect(clone).not.toMatch(/git clone -b /);
    expect(clone).toMatch(/git checkout 'main'/);
  });
});

// ════════════════════════════════════════════ E. soft-failure output contracts ════════════════════
// The wizard's deploy step scans the streamed output for these markers to render "failed" instead of
// a green "done". If the wording drifts, the wizard would silently show a failed install as done.
describe("E. install tools emit the failure markers the wizard relies on", () => {
  it("unauthorized deploy key → 'Nothing installed yet' + the public key, and nothing is deployed", async () => {
    const { deps, calls } = fakeDeps([[/command -v git/, { code: 0 }]], KEY_UNAUTHORIZED);
    const out = await tool("adpix_install").handler(deps, { branch: "main", repoUrl: "https://github.com/mehrabiyan/adpix.git", skipPreflight: true, timeoutSeconds: 600, deployKey: true });
    expect(out).toContain("Nothing installed yet");
    expect(out).toContain("ssh-ed25519 AAAANEW");
    expect(calls.some((c) => /deploy\.sh/.test(c))).toBe(false);
    expect(calls.some((c) => /git clone/.test(c))).toBe(false);
  });

  it("a hard checkout failure surfaces 'Checkout FAILED' with the repo's Deploy-keys hint", async () => {
    const { deps } = fakeDeps(
      [[/command -v git/, { code: 0 }], [/git (clone|fetch)/, { code: 1, stderr: "git@github.com: Permission denied (publickey)." }], [/test -d.*\.git.* && echo yes/, { stdout: "no" }]],
      KEY_AUTHORIZED,
    );
    const out = await tool("adpix_install").handler(deps, { branch: "main", repoUrl: "git@github.com:mehrabiyan/adpix.git", skipPreflight: true, timeoutSeconds: 600, deployKey: true });
    expect(out).toContain("Checkout FAILED");
    expect(out).toMatch(/Deploy keys/);
  });
});

// ════════════════════════════════════════════ F. panel endpoints behind the wizard ════════════════
let tmp: string; const SAVED = process.env.ADPIX_DEVOPS_HOME;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-deploy-flow-")); process.env.ADPIX_DEVOPS_HOME = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

async function withPanel(deps: Deps, fn: (base: string, H: Record<string, string>) => Promise<void>) {
  const token = "a".repeat(64);
  const server: Server = await servePanel({ port: 0, host: "127.0.0.1", token, deps });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try { await fn(base, { "x-adpix-token": token, "content-type": "application/json" }); } finally { server.close(); }
}
function panelDeps(responses: Resp[], localResponses: Resp[] = []): Deps {
  const server: ServerConfig = { name: "prod", host: "10.0.0.3", port: 22, username: "root", adpixDir: "/opt/adpix" };
  const session: Session = { server, authMethod: "publickey", close: () => {}, exec: async (cmd) => pick(responses, cmd) };
  return { resolve: () => server, connect: async () => session, local: async (cmd) => pick(localResponses, cmd) };
}

describe("F. wizard endpoints", () => {
  it("exposes a build id (version nudge against a stale in-memory SPA)", async () => {
    await withPanel(panelDeps([]), async (base, H) => {
      const v = await (await fetch(`${base}/api/version`, { headers: H })).json();
      expect(typeof v.buildId).toBe("string");
      expect(v.buildId.length).toBeGreaterThan(0);
      const me = await (await fetch(`${base}/api/me`, { headers: H })).json();
      expect(me.buildId).toBe(v.buildId);
    });
  });

  it("verify-repos reports UNAUTHORIZED + the key to add when the deploy key isn't on the repo", async () => {
    await withPanel(panelDeps([], KEY_UNAUTHORIZED), async (base, H) => {
      const r = await (await fetch(`${base}/api/wizard/verify-repos`, { method: "POST", headers: H, body: JSON.stringify({ appIds: ["analytics"] }) })).json();
      const repo = r.repos.find((x: { repo: string }) => x.repo === "adpix");
      expect(repo.authorized).toBe(false);
      expect(repo.pubKey).toContain("ssh-ed25519");
      expect(repo.addUrl).toBe("https://github.com/mehrabiyan/adpix/settings/keys");
    });
  });

  it("verify-repos reports AUTHORIZED once the key is on the repo", async () => {
    await withPanel(panelDeps([], KEY_AUTHORIZED), async (base, H) => {
      const r = await (await fetch(`${base}/api/wizard/verify-repos`, { method: "POST", headers: H, body: JSON.stringify({ appIds: ["analytics"] }) })).json();
      expect(r.repos.find((x: { repo: string }) => x.repo === "adpix").authorized).toBe(true);
    });
  });

  it("verify-deploy: account up + healthy returns the issuer URL", async () => {
    const deps = panelDeps([
      [/test -d.*\.git.* && echo yes/, { stdout: "yes" }],
      [/project='adpix-account'/, { stdout: "1 1" }],
      [/9696\/healthz/, { stdout: "200" }],
      [/AUTH_ISSUER=.*\.env\.account/, { stdout: "https://auth.adpix.io" }],
    ]);
    await withPanel(deps, async (base, H) => {
      const r = await (await fetch(`${base}/api/wizard/verify-deploy`, { method: "POST", headers: H, body: JSON.stringify({ appId: "account", server: "prod" }) })).json();
      expect(r.up).toBe(true); expect(r.healthy).toBe(true); expect(r.url).toBe("https://auth.adpix.io");
    });
  });

  it("verify-deploy: account with zero containers reports not-up (no false greenlight)", async () => {
    const deps = panelDeps([[/test -d.*\.git.* && echo yes/, { stdout: "yes" }], [/project='adpix-account'/, { stdout: "0 0" }]]);
    await withPanel(deps, async (base, H) => {
      const r = await (await fetch(`${base}/api/wizard/verify-deploy`, { method: "POST", headers: H, body: JSON.stringify({ appId: "account", server: "prod" }) })).json();
      expect(r.up).toBe(false); expect(r.healthy).toBe(false);
    });
  });
});

// ════════════════════════════════════════════ G. full happy path on one server ════════════════════
describe("G. full flow: account → tag manager → analytics all deploy healthy on one server", () => {
  function allThreeDeps() {
    return fakeDeps([
      [/docker compose version/, { stdout: "ok" }], [/command -v git/, { code: 0 }], [/git (clone|fetch)/, { code: 0 }],
      [/cat .*oidc_key\.pem/, { stdout: PEM }],
      [/(BOOTSTRAP_ADMIN_PASSWORD|TM_DB_PASSWORD|S3_ACCESS_KEY|S3_SECRET_KEY|PURGE_TOKEN)=/, { stdout: "" }],
      [/deploy\/\.env.* && echo yes/, { stdout: "no" }],
      [/openssl rand/, { stdout: "rand0hex" }], [/base64 -d/, { code: 0 }],
      [/-p adpix-account .*(build|up -d)/, { code: 0 }], [/-p adpix-tm .*(build|up -d)/, { code: 0 }],
      [/9696\/healthz/, { code: 0, stdout: "healthy after ~10s" }],
      [/8686\/healthz/, { code: 0, stdout: "healthy after ~5s (api+edge 200)" }],
      [/deploy\.sh/, { code: 0, stdout: "AdPix Analytics is running." }],
      [/for i in \$\(seq/, { code: 0, stdout: "healthy after ~5s (HTTP 200)" }],
      [/PUBLIC_BASE_URL/, { stdout: "http://10.0.0.3" }], [/ADMIN_EMAIL/, { stdout: "admin@x" }], [/SITE_ADDRESS/, { stdout: "" }],
    ]);
  }

  it("each install reaches a healthy/Done outcome", async () => {
    const { deps } = allThreeDeps();
    const acc = await tool("account_install").handler(deps, ACCOUNT_ARGS);
    expect(acc).toMatch(/Account\/IdP up/);

    const tm = await tool("tm_install").handler(deps, { dir: "/opt/adpix-tagmanager", repoUrl: "https://github.com/mehrabiyan/AdpixTagManager.git", branch: "main", dbContainer: true, authIssuer: "https://auth.adpix.io", s3Bucket: "adpix-tags", timeoutSeconds: 1800 });
    expect(tm).toContain("healthy");
    expect(tm).toContain("Done");

    const an = await tool("adpix_install").handler(deps, { branch: "main", repoUrl: "https://github.com/mehrabiyan/adpix.git", skipPreflight: true, timeoutSeconds: 600, deployKey: false });
    expect(an).toContain("http://10.0.0.3");
  });
});
