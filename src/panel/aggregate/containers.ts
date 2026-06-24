import { withSession, type Deps } from "../../deps.js";

/**
 * Per-container status for the server-detail page — one `docker ps -a` (no fragile tool-text parsing),
 * mapped to the dot the UI shows. Without this the dots were a static, always-grey list. Typed-empty +
 * error on failure, never throws.
 */
export interface ContainerInfo {
  service: string;          // compose service label (or the container name as a fallback)
  project: string;          // compose project (adanalytics / adpix-tm / adpix-account / adpix-console)
  name: string;
  state: string;            // running | exited | restarting | created | paused | dead
  health: "" | "healthy" | "unhealthy" | "starting";
  up: boolean;
  level: "pos" | "warn" | "neg" | "idle";  // dot colour
  status: string;           // human status line ("Up 3 hours (healthy)")
}
export interface ContainersView { containers: ContainerInfo[]; error?: string }

function levelOf(state: string, health: ContainerInfo["health"]): ContainerInfo["level"] {
  if (state === "running") return health === "unhealthy" ? "neg" : health === "starting" ? "warn" : "pos";
  if (state === "restarting" || state === "created" || state === "paused") return "warn";
  if (state === "exited" || state === "dead") return "neg";
  return "idle";
}

export async function buildContainers(deps: Deps, server?: string): Promise<ContainersView> {
  try {
    return await withSession(deps, server, async (s) => {
      // tab-delimited: service-label | project-label | name | state | status
      const r = await s.exec(
        `docker ps -a --format '{{.Label "com.docker.compose.service"}}\t{{.Label "com.docker.compose.project"}}\t{{.Names}}\t{{.State}}\t{{.Status}}' 2>/dev/null`,
        { timeoutMs: 30_000 }
      );
      const containers: ContainerInfo[] = [];
      for (const line of r.stdout.split("\n")) {
        if (!line.trim()) continue;
        const [svc = "", project = "", name = "", state = "", status = ""] = line.split("\t");
        const health: ContainerInfo["health"] = /\(healthy\)/.test(status) ? "healthy" : /\(unhealthy\)/.test(status) ? "unhealthy" : /health: starting|\(health: starting\)/.test(status) ? "starting" : "";
        containers.push({ service: svc || name, project, name, state, health, up: state === "running", level: levelOf(state, health), status });
      }
      return { containers };
    });
  } catch (e) {
    return { containers: [], error: (e as Error).message };
  }
}
