import type { Fleet } from "./fleet.js";
import type { JobRecord } from "./store.js";

/**
 * Demo mode (ADPIX_PANEL_DEMO=1): serves the design's sample cluster so the UI renders exactly
 * like the AdPix Cloud screenshots without a real fleet. Read-only mock data — no SSH, no
 * registry. Purely for previewing the design.
 */
export const isDemo = (): boolean => process.env.ADPIX_PANEL_DEMO === "1";

export const DEMO_FLEET: Fleet = {
  cluster: { name: "prod", vip: "10.0.0.10", servers: 3, region: "eu-west", version: "2.8.1" },
  counts: { healthy: 2, degraded: 1, down: 0, activeJobs: 0 },
  nodes: [
    { name: "witness", role: "witness", host: "10.0.0.4", os: "Debian 12", status: "healthy", lastSeen: "just now", dbRole: "3rd vote", cpu: 14, mem: 38, disk: 22, primary: false },
    { name: "node-a", role: "node", host: "10.0.0.11", os: "Ubuntu 24.04", status: "healthy", lastSeen: "12s ago", dbRole: "pg primary · ch r1", cpu: 46, mem: 62, disk: 54, primary: true },
    { name: "node-b", role: "node", host: "10.0.0.12", os: "Ubuntu 24.04", status: "degraded", lastSeen: "48s ago", dbRole: "pg standby · ch r2", cpu: 71, mem: 84, disk: 67, primary: false },
  ],
  recentJobs: [
    { tool: "Add server node-c", target: "10.0.0.13", status: "canceled", id: "3919" },
    { tool: "OPTIMIZE postgres", target: "node-a · node-b", status: "succeeded", id: "3922" },
    { tool: "Apply postgres retention TTL", target: "cluster prod", status: "succeeded", id: "3923" },
    { tool: "Rolling deploy v2.8.1", target: "cluster prod", status: "succeeded", id: "3921" },
  ],
  alerts: [
    { title: "node-b memory at 84%", why: "ClickHouse merge backlog rising — parts 312 / merges 4", level: "warn", action: { tool: "ch_optimize", label: "Run OPTIMIZE" } },
    { title: "TLS cert for app.adpix.io", why: "Expires in 14 days — auto-renew scheduled via Caddy", level: "warn", action: { tool: "tls_status", label: "Renew now" } },
  ],
};

const job = (id: string, tool: string, key: string, status: JobRecord["status"], logTail: string[]): JobRecord =>
  ({ id: id + "0000-0000-0000-000000000000".slice(id.length), tool, args: {}, status, key, createdAt: "2026-06-22T12:00:00Z", finishedAt: "2026-06-22T12:01:00Z", logTail });

export const DEMO_JOBS: JobRecord[] = [
  job("3923", "Apply postgres retention TTL", "cluster prod", "succeeded", ["vacuum analyze", "stats refreshed", "merging parts", "acquiring lock", "acquiring lock", "merging parts"]),
  job("3921", "Rolling deploy v2.8.1", "cluster prod", "succeeded", ["deploy v2.8.1 started", "node-a drained from VIP", "node-a pulled image · health ok", "node-b draining…", "migrations applied", "rejoining VIP"]),
  job("3922", "ClickHouse OPTIMIZE", "node-b", "failed", ["cancelled by operator"]),
  job("3920", "Verified backup · postgres", "node-a", "succeeded", ["pg_dump complete · 1.8 GB", "checksum verified", "uploaded to off-host s3://adpix-backups"]),
];

export function demoDb(engine: "pg" | "ch"): { engine: string; healthText: string; tuneText: string; tuneRows: { setting: string; before: string; after: string }[] } {
  if (engine === "ch") {
    const healthText = "ClickHouse 24.3 · healthy on node-a\n312 active parts\n4 merges in backlog\n18400/s inserts\n11.2x compression";
    const tuneText = "max_threads 8 → 16\nbackground_pool_size 8 → 16\nparts_to_throw_insert 300 → 600\nmerge_max_block_size 8192 → 16384";
    return { engine, healthText, tuneText, tuneRows: parse(tuneText) };
  }
  const healthText = "PostgreSQL 16 · primary node-a\n142 connections\n99.3% cache hit\nlag 0.2 s\nsize 48 GB";
  const tuneText = "shared_buffers 128MB → 4GB\neffective_cache_size 4GB → 12GB\nmax_wal_size 1GB → 4GB\nwork_mem 4MB → 32MB";
  return { engine, healthText, tuneText, tuneRows: parse(tuneText) };
}
function parse(text: string): { setting: string; before: string; after: string }[] {
  return text.split("\n").map((l) => { const m = l.match(/(\S+)\s+(\S+)\s*→\s*(\S+)/); return m ? { setting: m[1], before: m[2], after: m[3] } : null; }).filter(Boolean) as { setting: string; before: string; after: string }[];
}
