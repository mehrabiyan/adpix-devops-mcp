import { z } from "zod";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { lastLines, shq } from "../util.js";
import type { ToolDef } from "./types.js";

/** Repo root of THIS running MCP server (dist/tools/self.js → ../../). */
export function selfRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export const selfTools: ToolDef[] = [
  {
    name: "mcp_status",
    title: "MCP version + update status",
    description:
      "Read-only: this MCP's current version + commit + branch, and how many commits it is behind its own " +
      "GitHub origin (the MCP server + the panel UI are one repo). Powers the panel's 'Update AdPix Cloud' card.",
    schema: {},
    annotations: { readOnlyHint: true },
    handler: async (deps) => {
      const root = process.env.ADPIX_MCP_ROOT || selfRepoRoot();
      const r = await deps.local(
        `cd ${shq(root)} && git rev-parse --short HEAD && git log -1 --format=%s && git rev-parse --abbrev-ref HEAD && (git fetch -q origin 2>/dev/null; b=$(git rev-parse --abbrev-ref HEAD); git rev-list --count HEAD..origin/$b 2>/dev/null || echo '?')`,
        { timeoutMs: 30_000 }
      );
      if (r.code !== 0) return `Not a git checkout at ${root} (or git unavailable): ${lastLines(r.stdout, 6)}`;
      const [commit = "?", subject = "", branch = "?", behind = "?"] = r.stdout.trim().split("\n");
      return `adpix-devops-mcp @ ${commit} (${branch})\n${subject}\n${behind === "0" ? "Up to date with origin." : `${behind} commit(s) behind origin/${branch} — run mcp_self_update to update.`}`;
    },
  },
  {
    name: "mcp_self_update",
    title: "Update this MCP server",
    description:
      "Update THIS adpix-devops-mcp installation (hosted mode): git pull its own repo, rebuild (incl. the panel " +
      "UI), and — when running under systemd — schedule a service restart 2s after replying so the response " +
      "still reaches you. Refuses on local modifications. Clients reconnect automatically.",
    schema: {
      force: z.boolean().default(false).describe("Rebuild + restart even when already on the newest commit"),
      confirm: z.boolean().default(false).describe("Required — this restarts the control plane itself"),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    handler: async (deps, args) => {
      const a = args as { force: boolean; confirm: boolean };
      if (!a.confirm) return `REFUSED: mcp_self_update rebuilds + restarts the control plane itself (a brief self-outage). Re-run with confirm:true.`;
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
