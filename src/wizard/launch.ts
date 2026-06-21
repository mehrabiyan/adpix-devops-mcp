import { serveWizard, type WizardDeps } from "./server.js";
import { realDeps } from "../deps.js";
import { connect } from "../ssh.js";
import { loadHostPins } from "../knownhosts.js";
import { buildSteps } from "../install/steps.js";
import { runPlan, type InstallContext } from "../install/core.js";
import { loadJournal } from "../install/journal.js";
import { validateAnswers, secretsFromEnv, Secret, type InstallAnswers, type SecretsBag } from "../install/answers.js";
import type { ServerConfig } from "../registry.js";

/**
 * Wires the web wizard to the real SSH + install core. sshTest bootstraps a one-shot
 * connection (password via env for the duration only) and surfaces the TOFU-pinned host-key
 * fingerprint for the admin to confirm; finish builds the answers + secrets and runs the
 * reconcile engine. Secrets are held only for the call and never persisted by the wizard.
 */
const realWizardDeps: WizardDeps = {
  async sshTest(r) {
    const srv: ServerConfig = { name: "_bootstrap", host: r.host, port: r.port, username: r.username, adpixDir: "/opt/adpix" };
    const hadPw = process.env.ADPIX_SSH_PASSWORD;
    if (r.bootstrapAuth === "password" && r.password) process.env.ADPIX_SSH_PASSWORD = r.password;
    try {
      const s = await connect(srv);
      try {
        const res = await s.exec("uname -s", { timeoutMs: 20_000 });
        return { reachable: res.code === 0, fingerprint: loadHostPins()[`${r.host}:${r.port}`], detail: res.stdout.trim() || "reachable" };
      } finally {
        s.close();
      }
    } catch (e) {
      return { reachable: false, detail: (e as Error).message.split("\n")[0] };
    } finally {
      if (hadPw === undefined) delete process.env.ADPIX_SSH_PASSWORD;
      else process.env.ADPIX_SSH_PASSWORD = hadPw;
    }
  },

  async finish(body) {
    const b = body as { answers: InstallAnswers; secrets?: { perTarget?: Record<string, { password?: string }> } };
    const v = validateAnswers(b.answers);
    if (!v.ok) throw new Error("invalid answers: " + v.errors.join("; "));
    const secrets: SecretsBag = secretsFromEnv();
    for (const [name, s] of Object.entries(b.secrets?.perTarget ?? {})) {
      if (s.password) secrets.perTarget[name] = { password: new Secret(s.password) };
    }
    const ctx: InstallContext = { answers: b.answers, secrets, deps: realDeps, journal: loadJournal(), log: () => {}, force: false, runtime: {} };
    const out = await runPlan(buildSteps(), ctx);
    return { verdict: out.aborted ? "ABORTED" : "DONE", dns: ctx.runtime.emitDns ?? "", connect: ctx.runtime.emitConnect ?? "", verify: ctx.runtime.emitVerify ?? "" };
  },
};

export function launchWizard(): void {
  const handle = serveWizard({ port: Number(process.env.WIZARD_PORT ?? 8931), deps: realWizardDeps });
  process.stderr.write(
    `\nAdPix DevOps MCP — web setup.\n` +
      `Reach it ONLY through an SSH tunnel from your laptop (loopback bind, never public):\n` +
      `  ${handle.tunnelHint("<this-server-ip>")}\n` +
      `then open in your browser:\n  ${handle.url()}\n` +
      `(single-use token in the URL fragment; auto-shuts down on idle/max-life.)\n\n`
  );
}
