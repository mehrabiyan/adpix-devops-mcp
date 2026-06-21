import type { Deps } from "../deps.js";
import { shq, lastLines } from "../util.js";
import { loadRegistry } from "../registry.js";

/**
 * Reverse / recovery operations on what the installer owns. All run on the MCP host via
 * deps.local (uninstall/rollback) or over SSH to the fleet (revoke). They read the
 * install-state the installer recorded; none touch a target's data.
 */

const INSTALL_DIR = "/opt/adpix-devops-mcp";
const STATE_DIR = "/var/lib/adpix-devops-mcp";

export async function uninstall(deps: Deps, opts: { purge?: boolean } = {}): Promise<string> {
  const steps = [
    "systemctl disable --now adpix-devops-mcp.service 2>/dev/null || true",
    "systemctl disable --now adpix-mcp-selfheal.service 2>/dev/null || true",
    "rm -f /etc/systemd/system/adpix-devops-mcp.service /etc/systemd/system/adpix-mcp-selfheal.service",
    "rm -f /etc/sudoers.d/adpix-devops-mcp",
    // remove the delimited Caddy managed block, then reload
    "if [ -f /etc/caddy/Caddyfile ]; then sed -i '/# adpix-devops-mcp (managed/,/^}/d' /etc/caddy/Caddyfile; systemctl reload caddy 2>/dev/null || true; fi",
    "systemctl daemon-reload 2>/dev/null || true",
  ];
  if (opts.purge) steps.push(`rm -rf ${shq(STATE_DIR)} /etc/adpix-devops-mcp`);
  const r = await deps.local(steps.join("; "), { timeoutMs: 120_000 });
  return [
    `Uninstalled adpix-devops-mcp${opts.purge ? " (+PURGED state dir, registry, and the SSH identity)" : ` (data kept under ${STATE_DIR}; pass --purge to remove)`}.`,
    lastLines(r.stdout, 6),
    opts.purge ? "" : "Note: the MCP key may still be authorized on your targets — run revoke to strip it.",
  ].filter(Boolean).join("\n");
}

/** Strip the MCP pubkey from every registered target's authorized_keys (best-effort). */
export async function revokeKeys(deps: Deps, pubkey: string): Promise<string> {
  const reg = loadRegistry();
  const names = Object.keys(reg.servers);
  if (!names.length) return "No registered servers — nothing to revoke.";
  // match on the key BODY (the AAAA… blob) so we catch the line regardless of from=/restrict options
  const body = pubkey.split(/\s+/).find((p) => p.startsWith("AAAA")) ?? pubkey;
  const results: string[] = [];
  for (const name of names) {
    try {
      const s = await deps.connect(deps.resolve(name));
      try {
        const r = await s.exec(
          `f=~/.ssh/authorized_keys; if [ -f "$f" ]; then grep -vF ${shq(body)} "$f" > "$f.tmp" && mv "$f.tmp" "$f" && echo REVOKED; else echo NOKEYS; fi`,
          { timeoutMs: 20_000 }
        );
        results.push(`  - ${name}: ${/REVOKED/.test(r.stdout) ? "MCP key removed" : "no authorized_keys file"}`);
      } finally {
        s.close();
      }
    } catch (e) {
      results.push(`  - ${name}: UNREACHABLE (${(e as Error).message.split("\n")[0]}) — remove the key line manually`);
    }
  }
  return `Revoked the MCP key from ${names.length} target(s):\n${results.join("\n")}`;
}

/** Roll the hosted MCP back to the previous commit + rebuild + restart. */
export async function rollback(deps: Deps): Promise<string> {
  const r = await deps.local(
    `cd ${shq(INSTALL_DIR)} && prev=$(git rev-parse --short 'HEAD@{1}' 2>/dev/null) && [ -n "$prev" ] && ` +
      `git checkout "$prev" 2>&1 && npm ci --no-audit --no-fund >/dev/null 2>&1 && ` +
      `systemctl restart adpix-devops-mcp.service && echo "rolled back to $prev"`,
    { timeoutMs: 600_000 }
  );
  return r.code === 0 ? `Rollback OK:\n${lastLines(r.stdout, 6)}` : `Rollback FAILED (exit ${r.code}):\n${lastLines(r.stdout, 12)}`;
}
