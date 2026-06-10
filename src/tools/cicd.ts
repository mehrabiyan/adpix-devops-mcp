import { z } from "zod";
import { withSession } from "../deps.js";
import type { Session } from "../ssh.js";
import { uploadFile } from "../adpix.js";
import {
  AUTODEPLOY_LOG_DIR,
  AUTODEPLOY_SCRIPT_PATH,
  AUTODEPLOY_SERVICE,
  AUTODEPLOY_TIMER,
  renderAutodeployScript,
  renderAutodeployServiceUnit,
  renderAutodeployTimer,
} from "../remote/autodeploy.js";
import { shq, lastLines } from "../util.js";
import type { ToolDef } from "./types.js";

const serverParam = z
  .string()
  .optional()
  .describe("Registered server name. Omit to use the default server.");

const DEPLOY_KEY_PATH = "/root/.ssh/adpix_deploy_ed25519";

/** Parse owner/repo out of an https or ssh GitHub remote URL. */
export function parseGithubRemote(url: string): { owner: string; repo: string } | undefined {
  const m =
    url.trim().match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/) ||
    url.trim().match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

/**
 * Switch the checkout's origin to SSH with a dedicated read-only deploy key,
 * generating the key if needed. Returns the public key + setup instructions.
 */
async function setupDeployKey(s: Session, dir: string): Promise<string> {
  const remote = (await s.exec(`cd ${shq(dir)} && git remote get-url origin`)).stdout.trim();
  const gh = parseGithubRemote(remote);
  if (!gh) {
    return (
      `Could not parse a GitHub owner/repo from origin "${remote}". ` +
      `Set up read access manually, then re-run cicd_enable.`
    );
  }
  await s.exec(
    `[ -f ${DEPLOY_KEY_PATH} ] || ssh-keygen -t ed25519 -N '' -f ${DEPLOY_KEY_PATH} -C "adpix-autodeploy@$(hostname)" >/dev/null`
  );
  const pub = (await s.exec(`cat ${DEPLOY_KEY_PATH}.pub`)).stdout.trim();
  await s.exec(
    `cd ${shq(dir)} && git remote set-url origin git@github.com:${gh.owner}/${gh.repo}.git && ` +
      `git config core.sshCommand "ssh -i ${DEPLOY_KEY_PATH} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"`
  );
  return [
    `The repo needs authentication, so a dedicated READ-ONLY deploy key was set up:`,
    ``,
    `    ${pub}`,
    ``,
    `Add it at https://github.com/${gh.owner}/${gh.repo}/settings/keys → "Add deploy key"`,
    `(leave "Allow write access" UNCHECKED). Auto-deploy will alert once via webhook and`,
    `keep retrying until the key is added — no further action needed here.`,
  ].join("\n");
}

export const cicdTools: ToolDef[] = [
  {
    name: "cicd_enable",
    title: "Enable continuous deployment",
    description:
      "Turn on pull-based CI/CD on the AdPix server: a systemd timer polls GitHub every few minutes " +
      "and, when the tracked branch moves, runs backup → deploy → health gate → automatic rollback, " +
      "with webhook alerts and a deploy history. No SSH keys live in GitHub; private repos get a " +
      "dedicated read-only deploy key (instructions returned). Idempotent — re-run to change settings.",
    schema: {
      server: serverParam,
      branch: z.string().default("main").describe("Branch to continuously deploy"),
      intervalSeconds: z.number().int().min(60).max(86_400).default(300),
      skipBackup: z.boolean().default(false).describe("Skip the pre-deploy backup (not recommended)"),
      webhookUrl: z.string().optional().describe("Deploy/failure alerts (defaults to the server's registered webhook)"),
    },
    annotations: { idempotentHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; branch: string; intervalSeconds: number; skipBackup: boolean; webhookUrl?: string };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const sections: string[] = [];

        const isRepo = await s.exec(`test -d ${shq(dir + "/.git")} && echo yes || echo no`);
        if (isRepo.stdout.trim() !== "yes") {
          return `No AdPix checkout at ${dir} on ${srv.name} — run adpix_install first, then cicd_enable.`;
        }

        // Can the server fetch the repo on its own? Private repos need a deploy key.
        const fetch = await s.exec(
          `cd ${shq(dir)} && GIT_TERMINAL_PROMPT=0 timeout 30 git fetch origin ${shq(a.branch)} 2>&1`,
          { timeoutMs: 60_000 }
        );
        if (fetch.code !== 0) {
          if (/(authentication|could not read username|permission denied|repository not found|403|401)/i.test(fetch.stdout + fetch.stderr)) {
            sections.push(`## Repo access\n${await setupDeployKey(s, dir)}`);
          } else {
            return `git fetch origin ${a.branch} failed on ${srv.name} — fix this first:\n${lastLines(fetch.stdout + fetch.stderr, 15)}`;
          }
        } else {
          sections.push(`## Repo access\nfetch from origin works — no deploy key needed.`);
        }

        const webhook = a.webhookUrl ?? srv.webhookUrl;
        await uploadFile(
          s,
          AUTODEPLOY_SCRIPT_PATH,
          renderAutodeployScript({
            adpixDir: dir,
            branch: a.branch,
            webhookUrl: webhook,
            skipBackup: a.skipBackup,
            healthTries: 30,
          }),
          "755"
        );
        await uploadFile(s, `/etc/systemd/system/${AUTODEPLOY_SERVICE}`, renderAutodeployServiceUnit(dir), "644");
        await uploadFile(s, `/etc/systemd/system/${AUTODEPLOY_TIMER}`, renderAutodeployTimer(a.intervalSeconds), "644");
        const en = await s.exec(
          `systemctl daemon-reload && systemctl enable --now ${AUTODEPLOY_TIMER} && systemctl start --no-block ${AUTODEPLOY_SERVICE}`,
          { timeoutMs: 120_000 }
        );
        if (en.code !== 0) {
          return sections.concat(`Enabling the timer failed (exit ${en.code}):\n${en.stderr || en.stdout}`).join("\n\n");
        }

        sections.push(
          `## Continuous deployment ENABLED on ${srv.name}\n` +
            `- polls origin/${a.branch} every ${a.intervalSeconds}s; first check is running now\n` +
            `- on new commits: ${a.skipBackup ? "deploy" : "backup → deploy"} → health gate → automatic rollback on failure\n` +
            `- ${webhook ? "webhook alerts on deploys/failures" : "no webhook set — pass webhookUrl to get deploy alerts"}\n` +
            `- history: ${AUTODEPLOY_LOG_DIR}/deploys.jsonl (see cicd_status)\n\n` +
            `Anything that lands on origin/${a.branch} now ships to production automatically — protect that branch ` +
            `(require PRs/reviews) and let adpix's CI gate merges.`
        );
        return sections.join("\n\n");
      });
    },
  },

  {
    name: "cicd_status",
    title: "CI/CD status",
    description:
      "Continuous-deployment state: timer schedule, last pass result, how far the server is behind " +
      "origin, and the recent deploy/rollback history.",
    schema: {
      server: serverParam,
      history: z.number().int().min(1).max(100).default(10),
    },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; history: number };
      return withSession(deps, a.server, async (s, srv) => {
        const dir = srv.adpixDir;
        const r = await s.exec(
          [
            `echo ===TIMER; systemctl is-enabled ${AUTODEPLOY_TIMER} 2>/dev/null || echo not-installed; systemctl list-timers ${AUTODEPLOY_TIMER} --no-pager 2>/dev/null | head -3`,
            `echo ===STATE; cat ${AUTODEPLOY_LOG_DIR}/state.json 2>/dev/null || echo '(no pass recorded yet)'`,
            `echo ===GIT; cd ${shq(dir)} 2>/dev/null && git log -1 --format='deployed: %h %s (%ci)' && (GIT_TERMINAL_PROMPT=0 timeout 20 git fetch -q origin 2>/dev/null; b=$(git rev-parse --abbrev-ref HEAD); echo "behind origin/$b by $(git rev-list --count HEAD..origin/$b 2>/dev/null || echo '?') commit(s)")`,
            `echo ===HISTORY; tail -n ${a.history} ${AUTODEPLOY_LOG_DIR}/deploys.jsonl 2>/dev/null || echo '(no deploys yet)'`,
          ].join("; "),
          { timeoutMs: 90_000 }
        );
        const sec: Record<string, string> = {};
        let cur = "";
        for (const line of r.stdout.split("\n")) {
          const m = line.match(/^===(\w+)/);
          if (m) { cur = m[1]; sec[cur] = ""; }
          else if (cur) sec[cur] += line + "\n";
        }
        if ((sec.TIMER ?? "").includes("not-installed")) {
          return `Continuous deployment is not enabled on ${srv.name} — run cicd_enable.`;
        }
        return [
          `# CI/CD on ${srv.name}`,
          `## Timer\n${(sec.TIMER ?? "").trim()}`,
          `## Last pass\n${(sec.STATE ?? "").trim()}`,
          `## Version\n${(sec.GIT ?? "").trim()}`,
          `## Deploy history (newest last)\n${(sec.HISTORY ?? "").trim()}`,
        ].join("\n\n");
      });
    },
  },

  {
    name: "cicd_run_now",
    title: "Deploy latest now",
    description:
      "Trigger an immediate auto-deploy pass (same pipeline: backup → deploy → health gate → " +
      "rollback) and wait for it to finish. No-op if the server already runs the latest commit.",
    schema: {
      server: serverParam,
      timeoutSeconds: z.number().int().min(60).max(7200).default(2400),
    },
    handler: async (deps, args) => {
      const a = args as { server?: string; timeoutSeconds: number };
      return withSession(deps, a.server, async (s, srv) => {
        const installed = await s.exec(`test -x ${AUTODEPLOY_SCRIPT_PATH} && echo yes || echo no`);
        if (installed.stdout.trim() !== "yes") {
          return `Auto-deploy is not installed on ${srv.name} — run cicd_enable first (or use adpix_update for a one-off update).`;
        }
        const r = await s.exec(`systemctl start ${AUTODEPLOY_SERVICE}`, { timeoutMs: a.timeoutSeconds * 1000 });
        const state = await s.exec(`cat ${AUTODEPLOY_LOG_DIR}/state.json 2>/dev/null; echo; tail -n 3 ${AUTODEPLOY_LOG_DIR}/deploys.jsonl 2>/dev/null`);
        return [
          `Auto-deploy pass finished on ${srv.name} (exit ${r.code}).`,
          r.stderr.trim() ? lastLines(r.stderr, 10) : "",
          `Result:\n${state.stdout.trim() || "(no state)"}`,
        ].filter(Boolean).join("\n");
      });
    },
  },

  {
    name: "cicd_disable",
    title: "Disable continuous deployment",
    description: "Stop the auto-deploy timer. Keeps the script, logs, and deploy history in place; re-enable any time with cicd_enable.",
    schema: { server: serverParam },
    handler: async (deps, args) => {
      const a = args as { server?: string };
      return withSession(deps, a.server, async (s, srv) => {
        const r = await s.exec(`systemctl disable --now ${AUTODEPLOY_TIMER} 2>&1 || true`);
        return `Continuous deployment disabled on ${srv.name}. ${r.stdout.trim()}\nDeploy history stays at ${AUTODEPLOY_LOG_DIR}/deploys.jsonl; cicd_enable turns it back on.`;
      });
    },
  },
];
