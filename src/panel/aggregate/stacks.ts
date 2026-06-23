import { withSession, type Deps } from "../../deps.js";
import { STACK_META, stackDir, probeStack } from "../../tools/stack.js";

/**
 * Per-stack update status for the Deploys "Update from GitHub" card — the read-only counterpart
 * to stack_update (mirrors what buildMcpStatus gives the MCP). One SSH session, one git probe per
 * stack. Typed-empty + error on failure, never throws.
 */
export interface StackStatus { stack: string; installed: boolean; running: number; total: number; up: boolean; commit: string; subject: string; branch: string; behind: number | "?"; dir: string; error?: string }

export async function buildStacksStatus(deps: Deps, server?: string): Promise<StackStatus[]> {
  const names = Object.keys(STACK_META);
  try {
    return await withSession(deps, server, async (s, srv) => {
      const out: StackStatus[] = [];
      for (const st of names) {
        const dir = stackDir(srv, st);
        try {
          const p = await probeStack(s, dir, STACK_META[st]?.project);
          out.push({ stack: st, installed: p.installed, running: p.running, total: p.total, up: p.up, commit: p.commit, subject: p.subject, branch: p.branch, behind: p.behind === "?" ? "?" : Number(p.behind), dir });
        } catch (e) {
          out.push({ stack: st, installed: false, running: 0, total: 0, up: false, commit: "", subject: "", branch: "", behind: "?", dir, error: (e as Error).message });
        }
      }
      return out;
    });
  } catch (e) {
    return names.map((st) => ({ stack: st, installed: false, running: 0, total: 0, up: false, commit: "", subject: "", branch: "", behind: "?" as const, dir: "", error: (e as Error).message }));
  }
}
