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

/** Demo output for the read/report tools so every screen populates coherently in demo mode.
 *  Returns null for tools that already work without a fleet (dns_plan etc.) — those run for real. */
const DEMO_TOOL: Record<string, string> = {
  health_check: "Front-door probes (cluster prod)\n✓ account.adpix.io      200  8ms\n✓ api.adpix.io          200  12ms\n✓ analytics.adpix.io    200  22ms\n✓ tagmanager.adpix.io   200  15ms\nAll routes healthy.",
  tls_status: "TLS certificates\napp.adpix.io        valid · expires in 14 days  (auto-renew via Caddy)\napi.adpix.io        valid · expires in 67 days\naccount.adpix.io    valid · expires in 67 days",
  system_metrics: "Host metrics\nnode-a   cpu 46%   mem 62%   disk 54%\nnode-b   cpu 71%   mem 84%   disk 67%   (degraded)\nwitness  cpu 14%   mem 38%   disk 22%",
  security_audit: "Security audit (cluster prod)\nPASS  ufw enabled, default-deny\nPASS  ssh key-only, root login off\nPASS  fail2ban active\nWARN  unattended-upgrades not enabled on node-b\nPASS  TLS 1.3 only at the edge\n5 checks · 1 warning",
  launch_gate: "Launch gate — 1 finding must be resolved before go-live\n✗ Analytics P1: ClickHouse retention TTL not yet applied on node-b\n✓ OIDC aud split verified\n✓ Set-Cookie carve-out in place\nResolve the P1, then re-run launch_gate mode:attest.",
  cluster_status: "Cluster prod · quorum 3/3 HEALTHY\nwitness   arbiter · 3rd vote · ok\nnode-a    pg primary · redis master · ch r1 · cpu 46% mem 62%\nnode-b    pg standby (lag 0.2s) · redis replica · ch r2 · cpu 71% mem 84% (degraded)\nVIP 10.0.0.10 held by node-a.",
  cicd_status: "CI/CD pipeline\nTimer: enabled · 0 3 * * * (daily 03:00 UTC)\nLast run: success · 12h ago\n3 commits behind main\nAuto-rollback on failed health check: on",
  ha_quorum: "Quorum verdict: HEALTHY (3/3)\nPostgres    primary=node-a  sync-standby=node-b  arbiter=witness\nRedis       master=node-a   replica=node-b   sentinels=3 (quorum 2)\nClickHouse  r1=node-a  r2=node-b  keeper=3-node raft (witness tie-break)\nNo split-brain. Failover-ready.",
  pg_health: "PostgreSQL 16 · primary node-a\n142 active connections (max 300)\n99.3% cache hit ratio\nreplication lag 0.2s to node-b\ndatabase size 48 GB · 0 long-running queries",
  ch_health: "ClickHouse 24.3 · node-a\n312 active parts\n4 merges in backlog\n18400/s inserts\n11.2x compression ratio\n0 replication errors",
  connect_configs: "Client connect configs (cluster prod · VIP 10.0.0.10)\n\nClaude Code:\n  claude mcp add adpix-devops --url https://account.adpix.io/mcp --header \"Authorization: Bearer ****\"\n\nClaude Desktop (claude_desktop_config.json):\n  { \"mcpServers\": { \"adpix-devops\": { \"url\": \"https://account.adpix.io/mcp\", \"headers\": { \"Authorization\": \"Bearer ****\" } } } }\n\n(token masked — reveal:true to inline)",
};
export function demoTool(name: string): string | null {
  return DEMO_TOOL[name] ?? null;
}
