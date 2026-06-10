import { z } from "zod";
import { loadRegistry, saveRegistry, registryPath } from "../registry.js";
import { withSession } from "../deps.js";
import { checkCommand } from "../guard.js";
import { lastLines, shq } from "../util.js";
import type { ToolDef } from "./types.js";

const serverParam = z
  .string()
  .optional()
  .describe("Registered server name. Omit to use the default server.");

export const serverTools: ToolDef[] = [
  {
    name: "server_add",
    title: "Register a server",
    description:
      "Register (or update) a remote server in the registry so other tools can target it by name. " +
      "Connects via SSH as root or a passwordless-sudo user using a private key on this machine. " +
      "Verifies connectivity and reports OS, Docker availability, and whether AdPix is already installed.",
    schema: {
      name: z.string().regex(/^[a-zA-Z0-9_-]+$/).describe("Short name, e.g. 'prod'"),
      host: z.string().describe("Hostname or IP of the server"),
      username: z.string().default("root").describe("SSH user (root, or a user with passwordless sudo)"),
      port: z.number().int().min(1).max(65535).default(22),
      privateKeyPath: z
        .string()
        .optional()
        .describe("Path to the SSH private key on THIS machine (default: ssh-agent, then ~/.ssh/id_ed25519 / id_rsa)"),
      adpixDir: z.string().default("/opt/adpix").describe("Where AdPix lives / will be installed"),
      webhookUrl: z.string().optional().describe("Alert webhook (Slack/Discord/generic JSON POST) used by the watchdog"),
      setDefault: z.boolean().default(false).describe("Make this the default server for all tools"),
      verify: z.boolean().default(true).describe("Test the SSH connection before saving"),
    },
    annotations: { idempotentHint: true },
    handler: async (deps, args) => {
      const a = args as {
        name: string; host: string; username: string; port: number;
        privateKeyPath?: string; adpixDir: string; webhookUrl?: string;
        setDefault: boolean; verify: boolean;
      };
      const cfg = {
        name: a.name, host: a.host, port: a.port, username: a.username,
        privateKeyPath: a.privateKeyPath, adpixDir: a.adpixDir, webhookUrl: a.webhookUrl,
      };

      let probe = "(connection not verified — verify:false)";
      if (a.verify) {
        const s = await deps.connect(cfg);
        try {
          const uname = await s.exec("uname -a && (. /etc/os-release 2>/dev/null && echo OS:$PRETTY_NAME)");
          const docker = await s.exec("command -v docker >/dev/null && docker --version || echo 'docker: not installed'");
          const installed = await s.exec(`test -d ${shq(a.adpixDir + "/.git")} && echo yes || echo no`, { sudo: true });
          probe =
            `Connected (auth: ${s.authMethod}).\n` +
            uname.stdout.trim() + "\n" +
            docker.stdout.trim() + "\n" +
            `AdPix checkout at ${a.adpixDir}: ${installed.stdout.trim() === "yes" ? "present" : "not present"}`;
        } finally {
          s.close();
        }
      }

      const reg = loadRegistry();
      reg.servers[a.name] = {
        host: a.host, port: a.port, username: a.username,
        privateKeyPath: a.privateKeyPath, adpixDir: a.adpixDir, webhookUrl: a.webhookUrl,
      };
      if (a.setDefault || !reg.defaultServer) reg.defaultServer = a.name;
      saveRegistry(reg);

      return (
        `Server "${a.name}" saved to ${registryPath()}` +
        (reg.defaultServer === a.name ? " (default)" : "") +
        `.\n\n${probe}\n\nNext steps: adpix_install to deploy, or adpix_status if it's already running.`
      );
    },
  },

  {
    name: "server_list",
    title: "List registered servers",
    description: "List all registered servers (no credentials shown) and which one is the default.",
    schema: {},
    annotations: { readOnlyHint: true },
    handler: async () => {
      const reg = loadRegistry();
      const names = Object.keys(reg.servers);
      if (names.length === 0) {
        return `No servers registered (registry: ${registryPath()}). Add one with server_add, or set ADPIX_SSH_HOST/ADPIX_SSH_USER/ADPIX_SSH_KEY env vars for a single default server.`;
      }
      const lines = names.map((n) => {
        const s = reg.servers[n];
        const def = reg.defaultServer === n ? "  [default]" : "";
        return `- ${n}: ${s.username}@${s.host}:${s.port ?? 22}  adpixDir=${s.adpixDir ?? "/opt/adpix"}${s.webhookUrl ? "  webhook:set" : ""}${def}`;
      });
      return `Registered servers (${registryPath()}):\n` + lines.join("\n");
    },
  },

  {
    name: "server_remove",
    title: "Remove a server",
    description: "Remove a server from the registry. Does not touch the remote machine.",
    schema: { name: z.string().describe("Registered server name to remove") },
    handler: async (_deps, args) => {
      const name = args.name as string;
      const reg = loadRegistry();
      if (!reg.servers[name]) return `Server "${name}" is not in the registry.`;
      delete reg.servers[name];
      if (reg.defaultServer === name) reg.defaultServer = Object.keys(reg.servers)[0];
      saveRegistry(reg);
      return `Server "${name}" removed.` + (reg.defaultServer ? ` Default is now "${reg.defaultServer}".` : "");
    },
  },

  {
    name: "run_command",
    title: "Run a shell command",
    description:
      "Run an arbitrary shell command on the server over SSH (escape hatch for ad-hoc ops work). " +
      "Catastrophic patterns (rm -rf /, mkfs, docker volume rm, reboot, DROP TABLE…) are refused " +
      "unless confirm:true is passed. Prefer the purpose-built adpix_* tools when one fits.",
    schema: {
      command: z.string().describe("Shell command to execute (runs via bash -c)"),
      server: serverParam,
      confirm: z
        .boolean()
        .default(false)
        .describe("Set true to run a command that matched the destructive-pattern guard"),
      sudo: z.boolean().default(true).describe("Run privileged (sudo -n) when the SSH user is not root"),
      timeoutSeconds: z.number().int().min(1).max(3600).default(120),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { command: string; server?: string; confirm: boolean; sudo: boolean; timeoutSeconds: number };
      const verdict = checkCommand(a.command);
      if (verdict.blocked && !a.confirm) {
        return (
          `REFUSED — command matches destructive pattern(s):\n` +
          verdict.reasons.map((r) => `  - ${r}`).join("\n") +
          `\n\nIf this is genuinely intended, re-run with confirm:true. ` +
          `For restores/reboots prefer adpix_restore / patch_system which have their own safeguards.`
        );
      }
      return withSession(deps, a.server, async (s, srv) => {
        const r = await s.exec(a.command, { timeoutMs: a.timeoutSeconds * 1000, sudo: a.sudo });
        const out = [
          `$ ${a.command}   (on ${srv.name}: ${srv.username}@${srv.host}, exit ${r.code})`,
          verdict.blocked ? `note: destructive pattern confirmed by caller (${verdict.reasons.join("; ")})` : "",
          r.stdout.trim() ? `--- stdout ---\n${lastLines(r.stdout, 200)}` : "(no stdout)",
          r.stderr.trim() ? `--- stderr ---\n${lastLines(r.stderr, 100)}` : "",
        ].filter(Boolean);
        return out.join("\n");
      });
    },
  },
];
