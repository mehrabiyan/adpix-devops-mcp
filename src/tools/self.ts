import { z } from "zod";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { lastLines } from "../util.js";
import type { ToolDef } from "./types.js";

/** Repo root of THIS running MCP server (dist/tools/self.js → ../../). */
export function selfRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export const selfTools: ToolDef[] = [
  {
    name: "mcp_self_update",
    title: "Update this MCP server",
    description:
      "Update THIS adpix-devops-mcp installation (hosted mode): git pull its own repo, rebuild, and " +
      "— when running under systemd — schedule a service restart 2s after replying so the response " +
      "still reaches you. Refuses on local modifications. Clients reconnect automatically.",
    schema: {
      force: z.boolean().default(false).describe("Rebuild + restart even when already on the newest commit"),
    },
    annotations: { idempotentHint: true },
    handler: async (deps, args) => {
      const a = args as { force: boolean };
      const root = process.env.ADPIX_MCP_ROOT || selfRepoRoot();
      const g = (cmd: string) => `git -C '${root.replace(/'/g, "")}' ${cmd}`;

      const isRepo = await deps.local(`${g("rev-parse --is-inside-work-tree")} 2>/dev/null`);
      if (isRepo.stdout.trim() !== "true") {
        return `Not a git checkout at ${root} — self-update only works for installs made by scripts/install-server.sh (or a git clone).`;
      }
      const dirty = await deps.local(g("status --porcelain"));
      if (dirty.stdout.trim()) {
        return `Refusing to self-update: local modifications in ${root}:\n${lastLines(dirty.stdout, 15)}\nCommit/stash/revert them first (an AI self-heal may have patched files — review before discarding).`;
      }

      const before = (await deps.local(g("rev-parse --short HEAD"))).stdout.trim();
      const pull = await deps.local(`${g("pull --ff-only")} 2>&1`, { timeoutMs: 120_000 });
      if (pull.code !== 0) {
        return `git pull failed (exit ${pull.code}):\n${lastLines(pull.stdout, 15)}`;
      }
      const after = (await deps.local(g("rev-parse --short HEAD"))).stdout.trim();
      if (before === after && !a.force) {
        return `Already up to date (${before}) — nothing rebuilt. Pass force:true to rebuild anyway.`;
      }

      const build = await deps.local(
        `cd '${root.replace(/'/g, "")}' && npm ci --no-audit --no-fund 2>&1 && npm run build 2>&1`,
        { timeoutMs: 600_000 }
      );
      if (build.code !== 0) {
        return (
          `Updated ${before} → ${after} but the BUILD FAILED (exit ${build.code}) — still running the old code:\n` +
          lastLines(build.stdout, 25) +
          `\nFix the build (or git reset to ${before}); the service keeps serving until restarted.`
        );
      }

      const underSystemd = Boolean(process.env.INVOCATION_ID);
      if (underSystemd) {
        // sudo restricted to exactly this command by the installer's sudoers drop-in.
        await deps.local(
          `nohup bash -c 'sleep 2; sudo -n systemctl restart adpix-devops-mcp.service' >/dev/null 2>&1 &`
        );
        return `Updated ${before} → ${after} and rebuilt. Restarting the service in ~2s — reconnect and verify with server_list.`;
      }
      return `Updated ${before} → ${after} and rebuilt. Not running under systemd — restart the process manually to load the new version.`;
    },
  },
];
