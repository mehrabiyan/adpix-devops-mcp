import { z } from "zod";
import { withSession } from "../deps.js";
import { uploadFile } from "../adpix.js";
import { shq } from "../util.js";
import { getCert } from "../certstore.js";
import type { ToolDef } from "./types.js";

const serverParam = z.string().optional().describe("Target server name. Omit to use the default.");

/** Standard on-server location for an MCP-managed TLS bundle (mounted into the front-door Caddy). */
export function tlsRemoteDir(domain: string): string { return `/etc/adpix/tls/${domain.replace(/[^a-zA-Z0-9.\-_*]/g, "_")}`; }

export const certTools: ToolDef[] = [
  {
    name: "cert_install",
    title: "Install a stored TLS certificate on a server",
    description:
      "Push a certificate from the Certificate Manager (private key + leaf + optional intermediate chain) to a " +
      "server's front door — for internal-CA / commercial / air-gapped TLS where Let's Encrypt isn't reachable. " +
      "Writes /etc/adpix/tls/<domain>/{fullchain.pem (mode 644), key.pem (mode 600)} and returns the exact Caddy " +
      "`tls` directive to serve it (the account/console installers can mount it directly). reload:true reloads a " +
      "system Caddy if present.",
    schema: {
      server: serverParam,
      domain: z.string().describe("Domain whose stored cert to install (must exist in the Certificate Manager)"),
      reload: z.boolean().default(false).describe("Reload a system Caddy (systemctl reload caddy) after writing, if one is running"),
    },
    annotations: { openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; domain: string; reload: boolean };
      const c = getCert(a.domain);
      if (!c) return `No stored certificate for "${a.domain}". Add it in the Certificate Manager (private key + cert + optional chain) first, then re-run cert_install.`;
      const fullchain = c.cert.trim() + (c.chain && c.chain.trim() ? "\n" + c.chain.trim() : "") + "\n";
      const dir = tlsRemoteDir(a.domain);
      return withSession(deps, a.server, async (s, srv) => {
        await uploadFile(s, `${dir}/fullchain.pem`, fullchain, "644");
        await uploadFile(s, `${dir}/key.pem`, c.key.trim() + "\n", "600");
        let reloaded = "";
        if (a.reload) {
          const r = await s.exec(`command -v caddy >/dev/null 2>&1 && systemctl is-active --quiet caddy && systemctl reload caddy 2>&1 && echo reloaded || echo 'no system caddy'`, { timeoutMs: 30_000 });
          reloaded = `\nSystem Caddy: ${r.stdout.trim()}`;
        }
        return [
          `# TLS cert installed on ${srv.name} for ${a.domain}`,
          `Wrote ${dir}/fullchain.pem (644) + ${dir}/key.pem (600).${c.chain ? "" : "\n⚠ No intermediate chain stored — some clients may reject the cert. Add the chain in the Certificate Manager."}${reloaded}`,
          ``,
          `Serve it from the front-door Caddy with:`,
          "```",
          `${a.domain} {`,
          `\ttls ${dir}/fullchain.pem ${dir}/key.pem`,
          `\treverse_proxy ...`,
          `}`,
          "```",
          `(account_install / console_install with tlsCertDomain:${a.domain} mount this automatically. Otherwise add the block to your Caddyfile + reload.)`,
        ].join("\n");
      });
    },
  },
];
