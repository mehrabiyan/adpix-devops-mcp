import { z } from "zod";
import { withSession } from "../deps.js";
import { uploadFile } from "../adpix.js";
import type { Session } from "../ssh.js";
import { resolveCert } from "../certstore.js";
import type { ToolDef } from "./types.js";

const serverParam = z.string().optional().describe("Target server name. Omit to use the default.");

/** Standard on-server location for an MCP-managed TLS bundle (mounted into the front-door Caddy). */
export function tlsRemoteDir(fqdn: string): string { return `/etc/adpix/tls/${fqdn.replace(/[^a-zA-Z0-9.\-_*]/g, "_")}`; }

/**
 * Resolve the stored cert that serves `fqdn` (exact or wildcard SAN match) and push it to the server
 * at /etc/adpix/tls/<fqdn>/{fullchain.pem (644), key.pem (600)}. Returns the remote dir + which stored
 * cert matched, or null if none covers the FQDN. Reused by account_install / console_install so an
 * uploaded cert is wired into their Caddy front door automatically.
 */
export async function pushCertForFqdn(s: Session, fqdn: string): Promise<{ dir: string; via: string; sans: string[] } | null> {
  const r = resolveCert(fqdn);
  if (!r) return null;
  const fullchain = r.bundle.cert.trim() + (r.bundle.chain && r.bundle.chain.trim() ? "\n" + r.bundle.chain.trim() : "") + "\n";
  const dir = tlsRemoteDir(fqdn);
  await uploadFile(s, `${dir}/fullchain.pem`, fullchain, "644");
  await uploadFile(s, `${dir}/key.pem`, r.bundle.key.trim() + "\n", "600");
  return { dir, via: r.domain, sans: r.sans };
}

export const certTools: ToolDef[] = [
  {
    name: "cert_install",
    title: "Install a stored TLS certificate on a server",
    description:
      "Push the certificate that serves a given FQDN (from the Certificate Manager — private key + leaf + optional " +
      "chain) to a server's front door. Matches the FQDN against each stored cert's SANs, so one wildcard " +
      "(*.adpix.io) or multi-SAN cert covers every sub-domain. Writes /etc/adpix/tls/<fqdn>/{fullchain.pem 644, " +
      "key.pem 600} and returns the exact Caddy `tls` directive. For internal-CA / commercial / air-gapped TLS " +
      "where Let's Encrypt isn't reachable. reload:true reloads a system Caddy if present.",
    schema: {
      server: serverParam,
      domain: z.string().describe("The FQDN to serve (e.g. auth.adpix.io). A stored cert whose SANs cover it is used (incl. *.adpix.io wildcards)."),
      reload: z.boolean().default(false).describe("Reload a system Caddy (systemctl reload caddy) after writing, if one is running"),
    },
    annotations: { openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; domain: string; reload: boolean };
      const r = resolveCert(a.domain);
      if (!r) return `No stored certificate covers "${a.domain}". Add one in the Certificate Manager (a cert whose SANs include ${a.domain}, e.g. a *.${a.domain.split(".").slice(1).join(".")} wildcard), then re-run cert_install.`;
      return withSession(deps, a.server, async (s, srv) => {
        const pushed = await pushCertForFqdn(s, a.domain);
        let reloaded = "";
        if (a.reload) {
          const rl = await s.exec(`command -v caddy >/dev/null 2>&1 && systemctl is-active --quiet caddy && systemctl reload caddy 2>&1 && echo reloaded || echo 'no system caddy'`, { timeoutMs: 30_000 });
          reloaded = `\nSystem Caddy: ${rl.stdout.trim()}`;
        }
        const dir = pushed!.dir;
        return [
          `# TLS cert installed on ${srv.name} for ${a.domain}`,
          `Matched stored cert "${r.domain}" (SANs: ${r.sans.join(", ")}). Wrote ${dir}/fullchain.pem (644) + ${dir}/key.pem (600).${r.bundle.chain ? "" : "\n⚠ No intermediate chain — some clients may reject it; add the chain in the Certificate Manager."}${reloaded}`,
          ``,
          `Serve it from the front-door Caddy with:`,
          "```",
          `${a.domain} {`,
          `\ttls ${dir}/fullchain.pem ${dir}/key.pem`,
          `\treverse_proxy ...`,
          `}`,
          "```",
          `(account_install / console_install auto-detect + mount this when a stored cert covers their domain. Otherwise add the block to your Caddyfile + reload.)`,
        ].join("\n");
      });
    },
  },
];
