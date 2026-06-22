import { newToken } from "../wizard/guard.js";
import { servePanel } from "./server.js";
import { allTools } from "../tools/index.js";

/**
 * Launch the AdPix Cloud control panel (Phase 1, loopback). Prints a one-line URL with the
 * session token in the fragment (never sent to the server in logs/referrers) and the SSH
 * tunnel command. The panel holds fleet-root access, so it binds loopback only here.
 */
export async function launchPanel(opts: { port?: number; host?: string } = {}): Promise<void> {
  const port = opts.port ?? 8931;
  const host = opts.host ?? "127.0.0.1";
  const token = process.env.ADPIX_PANEL_TOKEN || newToken();
  await servePanel({ port, host, token });
  const url = `http://127.0.0.1:${port}/#token=${token}`;
  process.stderr.write(
    `\nAdPix Cloud panel — ${allTools.length} tools\n` +
      `  Open:   ${url}\n` +
      `  Tunnel: ssh -L ${port}:127.0.0.1:${port} <server>   (then open the URL locally)\n` +
      `  Bind:   ${host}:${port} (loopback-first; Phase-2 hardening before any public exposure)\n\n`
  );
}
