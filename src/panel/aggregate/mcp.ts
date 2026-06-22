import * as fs from "node:fs";
import * as path from "node:path";
import type { Deps } from "../../deps.js";
import { selfRepoRoot } from "../../tools/self.js";
import { shq } from "../../util.js";

/**
 * MCP self status — current commit + how far the MCP's own repo is behind origin, for the
 * "Update AdPix Cloud" card. Reads the MCP's own git checkout on the host (the MCP + panel UI
 * are one repo; mcp_self_update pulls + rebuilds + restarts).
 */
export interface McpStatus { version: string; commit: string; subject: string; branch: string; behind: number | "?"; error?: string }

function mcpRoot(): string { return process.env.ADPIX_MCP_ROOT || selfRepoRoot(); }

export async function buildMcpStatus(deps: Deps): Promise<McpStatus> {
  const root = mcpRoot();
  let version = "";
  try { version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || ""; } catch { /* not in a checkout */ }
  try {
    const r = await deps.local(
      `cd ${shq(root)} && git rev-parse --short HEAD && git log -1 --format=%s && git rev-parse --abbrev-ref HEAD && (git fetch -q origin 2>/dev/null; b=$(git rev-parse --abbrev-ref HEAD); git rev-list --count HEAD..origin/$b 2>/dev/null || echo '?')`,
      { timeoutMs: 30_000 }
    );
    const [commit = "?", subject = "", branch = "?", behind = "?"] = r.stdout.trim().split("\n");
    return { version, commit, subject, branch, behind: behind === "?" ? "?" : Number(behind) };
  } catch (e) {
    return { version, commit: "?", subject: "", branch: "?", behind: "?", error: (e as Error).message };
  }
}
