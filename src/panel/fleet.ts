import type { Deps } from "../deps.js";
import { withSession } from "../deps.js";
import { loadRegistry, type ClusterConfig } from "../registry.js";
import { loadHostPins } from "../knownhosts.js";
import type { JobRecord } from "./store.js";

/**
 * Fleet aggregator — turns the registry + live per-node probes into the structured model the
 * dashboard renders (KPI counts, topology, node-health bars, alerts). Each node is probed with
 * ONE deterministic SSH one-liner (no fragile tool-text parsing): os|cores|load|mem%|disk%.
 */

export type NodeStatus = "healthy" | "degraded" | "down";
export interface NodeInfo {
  name: string; role: "witness" | "node" | "—"; host: string; os: string;
  status: NodeStatus; lastSeen: string; dbRole: string;
  cpu: number; mem: number; disk: number; primary: boolean;
}
export interface Fleet {
  cluster: { name: string; vip: string; servers: number; region?: string; version?: string };
  counts: { healthy: number; degraded: number; down: number; activeJobs: number };
  nodes: NodeInfo[];
  recentJobs: { tool: string; target: string; status: string; id: string }[];
  alerts: { title: string; why: string; level: string; action?: { tool: string; label: string } }[];
}

const PROBE =
  `. /etc/os-release 2>/dev/null; printf '%s|%s|%s|%s|%s' ` +
  `"\${PRETTY_NAME:-Linux}" "$(nproc 2>/dev/null||echo 1)" ` +
  `"$(awk '{print $1}' /proc/loadavg 2>/dev/null||echo 0)" ` +
  `"$(free 2>/dev/null|awk '/Mem:/{printf "%.0f",$3/$2*100}')" ` +
  `"$(df / 2>/dev/null|awk 'END{gsub(/%/,"",$5);print $5}')"`;

async function probeNode(deps: Deps, name: string): Promise<{ reachable: boolean; os: string; cpu: number; mem: number; disk: number }> {
  try {
    return await withSession(deps, name, async (s) => {
      const r = await s.exec(PROBE, { timeoutMs: 8000 });
      const [os, cores, load, mem, disk] = r.stdout.trim().split("|");
      const cpu = Math.min(100, Math.round((parseFloat(load) / Math.max(1, parseInt(cores, 10) || 1)) * 100));
      return { reachable: true, os: os || "Linux", cpu: cpu || 0, mem: parseInt(mem, 10) || 0, disk: parseInt(disk, 10) || 0 };
    });
  } catch {
    return { reachable: false, os: "—", cpu: 0, mem: 0, disk: 0 };
  }
}

function statusOf(p: { reachable: boolean; cpu: number; mem: number; disk: number }): NodeStatus {
  if (!p.reachable) return "down";
  if (p.mem >= 80 || p.cpu >= 85 || p.disk >= 90) return "degraded";
  return "healthy";
}

/** Run an async fn over items with a bounded worker pool (so 50 servers don't open 50 SSH at once). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** List every defined cluster (name + members) — drives the cluster switcher. */
export function listClusters(): { name: string; witness?: string; nodes: string[]; vip?: string }[] {
  const reg = loadRegistry();
  return Object.entries(reg.clusters ?? {}).map(([name, c]) => ({ name, witness: c.witness, nodes: c.nodes ?? [], vip: c.vip }));
}

export async function buildFleet(deps: Deps, jobs: JobRecord[], clusterName?: string): Promise<Fleet> {
  const reg = loadRegistry();
  const names = Object.keys(reg.servers);
  const entries = Object.entries(reg.clusters ?? {});
  const clEntry = (clusterName ? entries.find(([n]) => n === clusterName) : undefined) ?? entries[0];
  const selectedName = clEntry?.[0] ?? "";
  const cluster = clEntry?.[1] as Omit<ClusterConfig, "name"> | undefined;
  const witness = cluster?.witness;
  const clusterNodes = cluster?.nodes ?? [];

  const probes = await mapLimit(names, 8, (n) => probeNode(deps, n));
  const nodes: NodeInfo[] = names.map((name, i) => {
    const p = probes[i]; const srv = reg.servers[name];
    const role: NodeInfo["role"] = name === witness ? "witness" : clusterNodes.includes(name) ? "node" : "—";
    const idx = clusterNodes.indexOf(name);
    const dbRole = role === "witness" ? "3rd vote" : idx === 0 ? "pg primary · ch r1" : idx === 1 ? "pg standby · ch r2" : "node";
    const status = statusOf(p);
    return { name, role, host: srv.host, os: p.os, status, lastSeen: p.reachable ? "just now" : "unreachable", dbRole, cpu: p.cpu, mem: p.mem, disk: p.disk, primary: idx === 0 };
  });

  const counts = {
    healthy: nodes.filter((n) => n.status === "healthy").length,
    degraded: nodes.filter((n) => n.status === "degraded").length,
    down: nodes.filter((n) => n.status === "down").length,
    activeJobs: jobs.filter((j) => j.status === "running" || j.status === "queued").length,
  };

  const recentJobs = jobs.slice(0, 6).map((j) => ({ tool: j.tool, target: j.key === "_global" ? "" : j.key, status: j.status, id: j.id.slice(0, 8) }));

  const alerts: Fleet["alerts"] = [];
  for (const n of nodes) {
    if (n.status === "down") alerts.push({ title: `${n.name} is unreachable`, why: "SSH probe failed — check the host and the MCP key.", level: "neg" });
    else if (n.status === "degraded") alerts.push({ title: `${n.name} under pressure`, why: `cpu ${n.cpu}% · mem ${n.mem}% · disk ${n.disk}%`, level: "warn", action: { tool: "system_metrics", label: "Inspect" } });
  }

  return { cluster: { name: selectedName, vip: cluster?.vip ?? "", servers: names.length }, counts, nodes, recentJobs, alerts };
}

/** Verify reachability of an (often not-yet-registered) host + return its SSH host-key
 *  fingerprint — the Add-server wizard's "Verify SSH" step. Connects ad-hoc with the operator's
 *  default credentials (agent / default key / ADPIX_SSH_PASSWORD). */
export async function verifyServer(deps: Deps, cfg: { host: string; port?: number; username?: string }): Promise<{ reachable: boolean; fingerprint: string; detail: string }> {
  const srv = { name: cfg.host, host: cfg.host, port: cfg.port ?? 22, username: cfg.username || "root", adpixDir: "/opt/adpix" };
  try {
    const s = await deps.connect(srv);
    try {
      const r = await s.exec("echo ok; whoami; uname -sr", { timeoutMs: 8000 });
      const fp = loadHostPins()[`${srv.host}:${srv.port}`] ?? "pinned on first connect";
      return { reachable: true, fingerprint: fp, detail: r.stdout.trim() };
    } finally { s.close(); }
  } catch (e) {
    return { reachable: false, fingerprint: "", detail: (e as Error).message.split("\n")[0] };
  }
}

/** Best-effort parse of a tool's tune output into before→after rows (the design's tune table). */
export function parseTuneRows(text: string): { setting: string; before: string; after: string }[] {
  const rows: { setting: string; before: string; after: string }[] = [];
  for (const line of String(text).split("\n")) {
    const m = line.match(/([A-Za-z_][\w.]*)\s*[:=]?\s*([\w.]+)\s*(?:→|->|=>)\s*([\w.]+)/);
    if (m) rows.push({ setting: m[1], before: m[2], after: m[3] });
  }
  return rows;
}
