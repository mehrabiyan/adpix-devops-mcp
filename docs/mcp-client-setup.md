# MCP client setup — quick guide

Connect `adpix-devops-mcp` to your MCP client in under a minute. The server runs **locally over stdio** (the client launches it) or you point the client at a **hosted** instance over HTTP.

## Prerequisites

- **Node 18+** on the machine running the MCP client.
- A target server (Ubuntu/Debian, 2 GB RAM min, 4 GB recommended) reachable over **SSH with a key** — or add it later from the client with `server_add`.

No global install needed: `npx -y github:mehrabiyan/adpix-devops-mcp` fetches + runs it. (Or clone + `npm install && npm run build`, then run `node /path/to/dist/index.js`.)

---

## Claude Code

```bash
claude mcp add adpix-devops -- npx -y github:mehrabiyan/adpix-devops-mcp
```

Verify: `claude mcp list` (shows `adpix-devops`), then in a session ask *"list my servers"* (runs `server_list`).

## Claude Desktop

Edit the config file:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "adpix-devops": {
      "command": "npx",
      "args": ["-y", "github:mehrabiyan/adpix-devops-mcp"]
    }
  }
}
```

Restart Claude Desktop. The tools appear under the 🔌 / tools menu.

## Cursor / Windsurf / VS Code (and other stdio clients)

Same shape — a server entry with `command` + `args`. In `~/.cursor/mcp.json` (or the client's MCP config):

```json
{
  "mcpServers": {
    "adpix-devops": { "command": "npx", "args": ["-y", "github:mehrabiyan/adpix-devops-mcp"] }
  }
}
```

From a local clone instead of `npx`:

```json
{ "mcpServers": { "adpix-devops": { "command": "node", "args": ["/abs/path/to/adpix-devops-mcp/dist/index.js"] } } }
```

---

## Single-server shortcut (skip the registry)

Most tools take an optional `server` and fall back to the registry. For one box you can skip `server_add` and bake the connection into the client config via env vars:

```json
{
  "mcpServers": {
    "adpix-devops": {
      "command": "npx",
      "args": ["-y", "github:mehrabiyan/adpix-devops-mcp"],
      "env": {
        "ADPIX_SSH_HOST": "203.0.113.7",
        "ADPIX_SSH_USER": "root",
        "ADPIX_SSH_KEY": "/Users/you/.ssh/id_ed25519",
        "ADPIX_DIR": "/opt/adpix"
      }
    }
  }
}
```

(`ADPIX_SSH_USER` defaults to `root`; non-root needs passwordless `sudo`. See the README's Configuration table for every env var.)

---

## Connect to a hosted instance (HTTP transport)

If the server already runs hosted on its own box (`--http`, Bearer token, TLS via Caddy — see the README's "Hosting" section), point an HTTP-capable MCP client at it instead of launching stdio:

```json
{
  "mcpServers": {
    "adpix-devops": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

The endpoint refuses to bind beyond loopback without a token; the token is compared in constant time.

---

## First run

1. **Add a server** (if you didn't use env vars): *"add server 203.0.113.7 as root with key ~/.ssh/id_ed25519"* → `server_add` verifies SSH + reports OS/Docker/AdPix state.
2. **Install**: *"install AdPix on it"* → `adpix_install` (preflight → deploy → health gate). Private repo? it generates a read-only deploy key and prints the one line to add to GitHub, then re-run.
3. Or drive everything visually: run the **setup wizard** / **control panel** (`node dist/index.js --panel`) over an SSH tunnel — see the README.

## Troubleshooting

- **Tools don't appear** → restart the client after editing config; confirm Node 18+ (`node -v`); run `npx -y github:mehrabiyan/adpix-devops-mcp` once manually to pre-fetch.
- **SSH failures** → the key path must be readable by the client process; non-root users need `NOPASSWD` sudo.
- **Hosted 401** → missing/!wrong `Authorization: Bearer` token.
