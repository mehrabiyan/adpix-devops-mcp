/**
 * Client-connect generator (pure). From the MCP URL + Bearer token, emit ready-to-use
 * configs for each client. The token is masked unless reveal:true, so a default render is
 * safe to print; the real token only appears in a file the operator writes mode 600.
 */

export interface ConnectInput {
  name: string;
  url: string; // https://mcp.example.com/mcp  OR  http://<ip>:8930/mcp
  token?: string;
  domain?: string;
  port: number;
}

export interface ConnectOpts {
  reveal?: boolean;
  serverHost?: string; // for the SSH-tunnel variant in HTTP/loopback mode
}

function tok(input: ConnectInput, opts: ConnectOpts): string {
  if (!input.token) return "<MCP_AUTH_TOKEN>";
  return opts.reveal ? input.token : input.token.slice(0, 4) + "…" + input.token.slice(-4);
}

export function claudeCodeCmd(input: ConnectInput, opts: ConnectOpts = {}): string {
  return `claude mcp add --transport http ${input.name} ${input.url} \\\n  --header "Authorization: Bearer ${tok(input, opts)}"`;
}

export function claudeDesktopJson(input: ConnectInput, opts: ConnectOpts = {}): string {
  return JSON.stringify(
    { mcpServers: { [input.name]: { transport: "http", url: input.url, headers: { Authorization: `Bearer ${tok(input, opts)}` } } } },
    null,
    2
  );
}

export function genericMcpJson(input: ConnectInput, opts: ConnectOpts = {}): string {
  return JSON.stringify(
    { mcpServers: { [input.name]: { url: input.url, headers: { Authorization: `Bearer ${tok(input, opts)}` } } } },
    null,
    2
  );
}

/** When the MCP serves plain HTTP (no domain), reach it safely through an SSH tunnel. */
export function sshTunnelVariant(input: ConnectInput, opts: ConnectOpts = {}): string | null {
  if (input.domain) return null; // HTTPS path doesn't need a tunnel
  const host = opts.serverHost ?? "<mcp-server>";
  const local = `http://127.0.0.1:${input.port}/mcp`;
  return [
    `# HTTP mode — tunnel the loopback port, then connect to the local end:`,
    `ssh -N -L ${input.port}:127.0.0.1:${input.port} root@${host}`,
    `claude mcp add --transport http ${input.name} ${local} --header "Authorization: Bearer ${tok(input, opts)}"`,
  ].join("\n");
}

export function renderConnect(input: ConnectInput, clients: ("claude-code" | "claude-desktop" | "generic")[], opts: ConnectOpts = {}): string {
  const out: string[] = [`# Connect clients to ${input.name} (${input.url})`];
  if (!opts.reveal) out.push(`(token masked — write the real config to a mode-600 file; never paste it in a shared log)`);
  if (clients.includes("claude-code")) out.push(`\n## Claude Code\n${claudeCodeCmd(input, opts)}`);
  if (clients.includes("claude-desktop")) out.push(`\n## Claude Desktop (claude_desktop_config.json)\n${claudeDesktopJson(input, opts)}`);
  if (clients.includes("generic")) out.push(`\n## Generic MCP client\n${genericMcpJson(input, opts)}`);
  const tunnel = sshTunnelVariant(input, opts);
  if (tunnel) out.push(`\n## SSH tunnel (HTTP mode)\n${tunnel}`);
  return out.join("\n");
}
