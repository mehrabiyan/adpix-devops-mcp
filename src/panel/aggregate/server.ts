import { withSession, type Deps } from "../../deps.js";

/**
 * Detailed host resources (one SSH probe, no fragile tool-text parsing) for the server-detail page —
 * beyond the CPU/MEM/DISK %, the real numbers: cores, load 1/5/15, RAM used/total, disk used/free, uptime.
 */
export interface ServerMetrics {
  reachable: boolean;
  cores: number;
  load: [number, number, number];
  mem: { totalMB: number; usedMB: number; availMB: number };
  disk: { totalMB: number; usedMB: number; availMB: number };
  uptimeSec: number;
  kernel: string;
  error?: string;
}

const M_PROBE =
  `printf 'CORES=%s\\nLOAD=%s\\nMEM=%s\\nDISK=%s\\nUP=%s\\nKERN=%s\\n' ` +
  `"$(nproc 2>/dev/null||echo 1)" ` +
  `"$(cat /proc/loadavg 2>/dev/null|awk '{print $1" "$2" "$3}')" ` +
  `"$(free -m 2>/dev/null|awk '/Mem:/{print $2" "$3" "$7}')" ` +
  `"$(df -m / 2>/dev/null|awk 'END{print $2" "$3" "$4}')" ` +
  `"$(awk '{print int($1)}' /proc/uptime 2>/dev/null||echo 0)" ` +
  `"$(uname -r 2>/dev/null||echo -)"`;

export async function buildServerMetrics(deps: Deps, server?: string): Promise<ServerMetrics> {
  const empty: ServerMetrics = { reachable: false, cores: 0, load: [0, 0, 0], mem: { totalMB: 0, usedMB: 0, availMB: 0 }, disk: { totalMB: 0, usedMB: 0, availMB: 0 }, uptimeSec: 0, kernel: "—" };
  try {
    return await withSession(deps, server, async (s) => {
      const r = await s.exec(M_PROBE, { timeoutMs: 10_000 });
      const kv: Record<string, string> = {};
      for (const line of r.stdout.split("\n")) { const i = line.indexOf("="); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim(); }
      const nums = (s2: string, n: number) => { const p = (s2 || "").split(/\s+/).map((x) => parseInt(x, 10) || 0); while (p.length < n) p.push(0); return p; };
      const loadP = (kv.LOAD || "").split(/\s+/).map((x) => parseFloat(x) || 0);
      const [mt, mu, ma] = nums(kv.MEM, 3);
      const [dt, du, da] = nums(kv.DISK, 3);
      return {
        reachable: true,
        cores: parseInt(kv.CORES, 10) || 1,
        load: [loadP[0] || 0, loadP[1] || 0, loadP[2] || 0] as [number, number, number],
        mem: { totalMB: mt, usedMB: mu, availMB: ma },
        disk: { totalMB: dt, usedMB: du, availMB: da },
        uptimeSec: parseInt(kv.UP, 10) || 0,
        kernel: kv.KERN || "—",
      };
    });
  } catch (e) { return { ...empty, error: (e as Error).message }; }
}

/**
 * Inventory of AdPix products actually deployed on the server — detected by docker compose project +
 * working_dir, so it sees stacks installed OUTSIDE this panel (manually / by a different operator). A
 * product is flagged `external` when its compose working_dir isn't the MCP's standard dir for it.
 */
export interface ProductPresence { product: string; project: string; dir: string; running: number; total: number; up: boolean; external: boolean }
export interface ServerInventory { products: ProductPresence[]; unknown: { project: string; dir: string; running: number; total: number }[]; error?: string }

const KNOWN: Record<string, { product: string; stdDir: string }> = {
  adanalytics: { product: "AdPix Analytics", stdDir: "/opt/adpix" },
  "adpix-tm": { product: "AdPix Tag Manager", stdDir: "/opt/adpix-tagmanager" },
  "adpix-account": { product: "AdPix Account (IdP)", stdDir: "/opt/adpix-tagmanager" },
  "adpix-console": { product: "AdPix TM Console", stdDir: "/opt/adpix-tagmanager" },
};

export async function buildServerInventory(deps: Deps, server?: string): Promise<ServerInventory> {
  try {
    return await withSession(deps, server, async (s) => {
      const r = await s.exec(
        `docker ps -a --format '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.State}}' 2>/dev/null`,
        { timeoutMs: 30_000 }
      );
      const agg: Record<string, { dir: string; running: number; total: number }> = {};
      for (const line of r.stdout.split("\n")) {
        if (!line.trim()) continue;
        const [project = "", dir = "", state = ""] = line.split("\t");
        if (!project) continue;
        const a = (agg[project] ??= { dir: "", running: 0, total: 0 });
        if (dir && !a.dir) a.dir = dir;
        a.total++; if (state === "running") a.running++;
      }
      const products: ProductPresence[] = [];
      const unknown: ServerInventory["unknown"] = [];
      for (const [project, a] of Object.entries(agg)) {
        const k = KNOWN[project];
        if (k) products.push({ product: k.product, project, dir: a.dir || k.stdDir, running: a.running, total: a.total, up: a.running > 0, external: !!a.dir && a.dir !== k.stdDir });
        else unknown.push({ project, dir: a.dir, running: a.running, total: a.total });
      }
      products.sort((x, y) => x.product.localeCompare(y.product));
      return { products, unknown };
    });
  } catch (e) { return { products: [], unknown: [], error: (e as Error).message }; }
}
