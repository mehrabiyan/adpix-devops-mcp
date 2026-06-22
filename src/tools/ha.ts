import { z } from "zod";
import { withSession } from "../deps.js";
import { resolveCluster, resolveServer } from "../registry.js";
import { uploadFile } from "../adpix.js";
import { shq, lastLines } from "../util.js";
import {
  renderKeepalivedConf,
  keepalivedSetup,
  renderSentinelConf,
  sentinelSetup,
  vrrpAuthPass,
} from "../remote/ha.js";
import type { ToolDef } from "./types.js";

const clusterParam = z.string().optional().describe("Cluster name. Omit to use the single defined cluster.");

/**
 * ha_standup — lay down the HA quorum across the cluster's members. Automates the
 * host-level, no-data-risk pieces (keepalived VIP failover + Redis Sentinel quorum) and
 * orchestrates/plans the data tier (Postgres via pg_replication, ClickHouse via
 * ha_quorum keeper-config). Runs over SSH with the MCP key (so the fleet must already be
 * onboarded + authorized). Apply modes require confirm:true.
 */
export const haTools: ToolDef[] = [
  {
    name: "ha_standup",
    title: "Stand up the HA quorum (keepalived + Sentinel)",
    description:
      "Configure the witness-anchored HA quorum on a cluster's nodes. mode:plan shows the full standup " +
      "(read-only). mode:keepalived installs keepalived on the two serving nodes — a floating VIP with the first " +
      "node MASTER, the second BACKUP, unicast VRRP, and a front-door health check that releases the VIP if Caddy " +
      "is down (the failover + single entry point). mode:sentinel installs Redis Sentinel on all three members " +
      "(witness = 3rd vote, quorum 2) monitoring the primary node's Redis. Apply modes require confirm:true. " +
      "Postgres replication is pg_replication; the ClickHouse Keeper XML is ha_quorum mode:keeper-config.",
    schema: {
      cluster: clusterParam,
      mode: z.enum(["plan", "keepalived", "sentinel"]).default("plan"),
      vip: z.string().optional().describe("Floating VIP (defaults to the cluster's vip)"),
      iface: z.string().default("eth0").describe("Network interface the VIP attaches to"),
      vrid: z.number().int().min(1).max(255).default(51).describe("VRRP virtual_router_id (must be unique on the LAN)"),
      confirm: z.boolean().default(false).describe("Required for keepalived/sentinel (installs packages + restarts services)"),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { cluster?: string; mode: string; vip?: string; iface: string; vrid: number; confirm: boolean };
      let cl;
      try {
        cl = resolveCluster(a.cluster);
      } catch (e) {
        return (e as Error).message;
      }
      const witness = cl.witness;
      const nodes = cl.nodes;
      const vip = a.vip ?? cl.vip;

      if (a.mode === "plan") {
        return [
          `# HA quorum standup — ${cl.name}`,
          `Members: witness=${witness ?? "(none)"} · nodes=[${nodes.join(", ") || "(none)"}] · VIP=${vip ?? "(unset)"}`,
          ``,
          `## 1. VIP + failover + LB entry  →  ha_standup mode:keepalived confirm:true`,
          `   keepalived on ${nodes[0] ?? "node-a"} (MASTER) + ${nodes[1] ?? "node-b"} (BACKUP), unicast VRRP on ${a.iface},`,
          `   VIP ${vip ?? "<set cluster vip>"} gated on the local Caddy front door. The single entry point; fails over on node loss.`,
          ``,
          `## 2. Redis quorum  →  ha_standup mode:sentinel confirm:true`,
          `   Sentinel on all 3 members (witness = 3rd vote, quorum 2) monitoring ${nodes[0] ?? "node-a"}'s Redis.`,
          `   PREREQ: the Redis primary must be reachable on the private network at <node>:6379 (publish it on the VPC IP).`,
          ``,
          `## 3. Postgres primary + sync standby + witness arbiter`,
          `   pg_replication mode:prepare-primary (on ${nodes[0] ?? "node-a"}) → mode:replica-steps (bring up ${nodes[1] ?? "node-b"}).`,
          `   For automatic failover, run Patroni with a raft member on the witness (the 3rd vote).`,
          ``,
          `## 4. ClickHouse replicated + Keeper`,
          `   ha_quorum mode:keeper-config → place replication.xml (distinct <replica> per node, Keeper on all 3) → ch_redeploy.`,
          `   CH_REPLICATED=1 is FRESH-DEPLOY-ONLY — ch_backup raw_events_jsonl first if there's existing data.`,
          ``,
          `Then: ha_quorum mode:status + cluster_status to verify; bluegreen_deploy for rolling updates.`,
        ].join("\n");
      }

      if (nodes.length < 2) return `Cluster "${cl.name}" needs 2 serving nodes for HA (has ${nodes.length}). cluster_define nodes:[node-a,node-b].`;
      if (!a.confirm) return `REFUSED: ha_standup mode:${a.mode} installs packages + restarts services on the cluster. Re-run with confirm:true.`;

      // resolve member host IPs
      const ipOf = (name: string) => {
        try { return resolveServer(name).host; } catch { return ""; }
      };

      if (a.mode === "keepalived") {
        if (!vip) return "keepalived needs a VIP — set it on the cluster (cluster_define vip:…) or pass vip:.";
        const authPass = vrrpAuthPass(cl.name, vip);
        const plan: { node: string; role: "MASTER" | "BACKUP"; priority: number }[] = [
          { node: nodes[0], role: "MASTER", priority: 150 },
          { node: nodes[1], role: "BACKUP", priority: 100 },
        ];
        const results: string[] = [];
        for (let i = 0; i < plan.length; i++) {
          const p = plan[i];
          const selfIp = ipOf(p.node);
          const peerIp = ipOf(plan[1 - i].node);
          if (!selfIp || !peerIp) { results.push(`  - ${p.node}: cannot resolve node IPs (server_add first)`); continue; }
          try {
            const r = await withSession(deps, p.node, async (s) => {
              const conf = renderKeepalivedConf({ role: p.role, vip, iface: a.iface, vrid: a.vrid, priority: p.priority, authPass, selfIp, peerIp });
              await uploadFile(s, "/etc/keepalived/keepalived.conf", conf, "644");
              const out = await s.exec(keepalivedSetup(), { timeoutMs: 300_000 });
              const active = out.stdout.trim().endsWith("active");
              const hasVip = (await s.exec(`ip -4 addr show ${shq(a.iface)} | grep -qw ${shq(vip)} && echo HAS_VIP || echo no`)).stdout.trim();
              return { active, hasVip: hasVip === "HAS_VIP", detail: lastLines(out.stdout, 3) };
            });
            results.push(`  - ${p.node} (${p.role}): ${r.active ? "keepalived active" : "NOT active — " + r.detail}${p.role === "MASTER" ? `; VIP ${r.hasVip ? "held ✅" : "not yet held (check peer/iface)"}` : ""}`);
          } catch (e) {
            results.push(`  - ${p.node} (${p.role}): FAILED — ${(e as Error).message.split("\n")[0]}`);
          }
        }
        return [
          `# keepalived VIP standup — ${cl.name} (VIP ${vip} on ${a.iface}, vrid ${a.vrid})`,
          results.join("\n"),
          ``,
          `Point DNS / the platform front door at ${vip}. Failover: if ${nodes[0]}'s Caddy dies, the VIP moves to ${nodes[1]} within ~3s.`,
          `Verify: ha_standup mode:plan, or check 'ip addr' on each node. Re-run is idempotent.`,
        ].join("\n");
      }

      // sentinel
      const members = [witness, ...nodes].filter((m): m is string => !!m);
      const primaryIp = ipOf(nodes[0]);
      if (!primaryIp) return `Cannot resolve ${nodes[0]}'s IP (server_add first).`;
      const quorum = Math.floor(members.length / 2) + 1;
      const conf = renderSentinelConf({ name: "adpix", primaryIp, port: 6379, quorum });
      const results: string[] = [];
      for (const m of members) {
        try {
          const ok = await withSession(deps, m, async (s) => {
            await uploadFile(s, "/etc/redis/sentinel.conf", conf, "644");
            const out = await s.exec(sentinelSetup(), { timeoutMs: 300_000 });
            return /PONG|active/.test(out.stdout);
          });
          results.push(`  - ${m}: ${ok ? "sentinel up" : "sentinel NOT confirmed"}`);
        } catch (e) {
          results.push(`  - ${m}: FAILED — ${(e as Error).message.split("\n")[0]}`);
        }
      }
      return [
        `# Redis Sentinel quorum — ${cl.name} (monitoring ${nodes[0]} @ ${primaryIp}:6379, quorum ${quorum}/${members.length})`,
        results.join("\n"),
        ``,
        `PREREQ: the Redis primary must be reachable from each member at ${primaryIp}:6379, and ${nodes[1]}'s Redis must replicate it`,
        `(replicaof ${primaryIp} 6379). AdPix's Redis is compose-internal by default — publish it on the private VPC IP for cross-node HA.`,
        `Verify: redis-cli -p 26379 sentinel master adpix on any member.`,
      ].join("\n");
    },
  },
];
