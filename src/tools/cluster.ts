import { z } from "zod";
import { loadRegistry, saveRegistry, registryPath, resolveCluster, resolveServer } from "../registry.js";
import { withSession } from "../deps.js";
import { waitHealthyCmd, gitSyncCmd } from "../adpix.js";
import { shq, lastLines, redactSecrets, table } from "../util.js";
import { DEFAULT_LAUNCH_HOSTS } from "../launch/hosts.js";
import { tmCompose, tmHealthGate } from "./tagmanager.js";
import type { ToolDef } from "./types.js";

const clusterParam = z.string().optional().describe("Cluster name. Omit to use the single defined cluster.");

export const clusterTools: ToolDef[] = [
  {
    name: "cluster_define",
    title: "Define an HA cluster",
    description:
      "Define (or update) the multi-VM launch topology (DEPLOYMENT_SRE §4): a witness node (observability + " +
      "quorum 3rd-vote + this MCP, never serves traffic) + the active-active HA serving nodes, reached through a " +
      "floating VIP, fronting the public host list. Members are registered server names (server_add first). Lets " +
      "the launch tools target roles ('the witness', 'the nodes') and probe the right hosts.",
    schema: {
      name: z.string().regex(/^[a-zA-Z0-9_-]+$/).describe("Cluster name, e.g. 'prod'"),
      witness: z.string().optional().describe("Registered server name of the witness (VM1)"),
      nodes: z.array(z.string()).default([]).describe("Registered server names of the HA serving nodes (VM2, VM3)"),
      vip: z.string().optional().describe("Floating VIP host/IP (keepalived/VRRP)"),
      hosts: z.array(z.string()).optional().describe(`Public host list Caddy serves. Default: the 8 AdPix hosts (${DEFAULT_LAUNCH_HOSTS.join(", ")})`),
      idpIssuer: z.string().default("https://account.adpix.io").describe("OIDC issuer base for the shared IdP"),
    },
    annotations: { idempotentHint: true },
    handler: async (_deps, args) => {
      const a = args as { name: string; witness?: string; nodes: string[]; vip?: string; hosts?: string[]; idpIssuer: string };
      const reg = loadRegistry();
      const known = new Set(Object.keys(reg.servers));
      const members = [a.witness, ...a.nodes].filter((m): m is string => !!m);
      const unknown = members.filter((m) => !known.has(m));

      reg.clusters ??= {};
      reg.clusters[a.name] = {
        witness: a.witness,
        nodes: a.nodes,
        vip: a.vip,
        hosts: a.hosts?.length ? a.hosts : DEFAULT_LAUNCH_HOSTS,
        idpIssuer: a.idpIssuer,
      };
      saveRegistry(reg);

      return [
        `Cluster "${a.name}" saved to ${registryPath()}.`,
        `  witness: ${a.witness ?? "(none)"}`,
        `  nodes:   ${a.nodes.length ? a.nodes.join(", ") : "(none)"}`,
        `  vip:     ${a.vip ?? "(none)"}`,
        `  idp:     ${a.idpIssuer}`,
        `  hosts:   ${(a.hosts?.length ? a.hosts : DEFAULT_LAUNCH_HOSTS).length} (${(a.hosts?.length ? a.hosts : DEFAULT_LAUNCH_HOSTS).join(", ")})`,
        unknown.length ? `\n⚠ Not yet registered as servers (run server_add): ${unknown.join(", ")} — define them so cluster_status can reach them.` : ``,
        `\nNext: cluster_status to probe members; edge_validate / oidc_health / launch_smoke for the front door.`,
      ].filter(Boolean).join("\n");
    },
  },

  {
    name: "cluster_list",
    title: "List clusters",
    description: "List defined HA clusters with their witness/node roles, VIP and host count.",
    schema: {},
    annotations: { readOnlyHint: true },
    handler: async () => {
      const reg = loadRegistry();
      const names = Object.keys(reg.clusters ?? {});
      if (!names.length) return `No clusters defined (${registryPath()}). Create one with cluster_define.`;
      return [
        `Clusters (${registryPath()}):`,
        ...names.map((n) => {
          const c = reg.clusters![n];
          return `- ${n}: witness=${c.witness ?? "-"} nodes=[${(c.nodes ?? []).join(", ")}] vip=${c.vip ?? "-"} hosts=${(c.hosts ?? []).length} idp=${c.idpIssuer ?? "-"}`;
        }),
      ].join("\n");
    },
  },

  {
    name: "cluster_status",
    title: "Cluster status",
    description:
      "Probe every member of an HA cluster over SSH and roll up reachability + role + what each runs (Docker " +
      "containers, AdPix / Tag-Manager checkouts). Flags the witness if it looks like it's serving user traffic " +
      "(it shouldn't) and a serving node that's down. Read-only.",
    schema: { cluster: clusterParam },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { cluster?: string };
      let cl;
      try {
        cl = resolveCluster(a.cluster);
      } catch (e) {
        return (e as Error).message;
      }
      const members: { name: string; role: string }[] = [
        ...(cl.witness ? [{ name: cl.witness, role: "witness" }] : []),
        ...cl.nodes.map((n) => ({ name: n, role: "node" })),
      ];
      if (!members.length) return `Cluster "${cl.name}" has no members. Add them with cluster_define (witness + nodes).`;

      const probe =
        "uname -sr; echo '---SVC---'; docker ps --format '{{.Names}}' 2>/dev/null | sed 's/^[a-z]*-//;s/-[0-9]*$//' | sort -u | tr '\\n' ' '; " +
        "echo; echo '---CO---'; for d in /opt/adpix /opt/adpix-tagmanager /opt/adpix-devops-mcp; do test -d \"$d/.git\" && echo -n \"$(basename $d) \"; done; echo";

      const rows: string[][] = [];
      const problems: string[] = [];
      for (const m of members) {
        try {
          const out = await withSession(deps, m.name, async (s, srv) => {
            const r = await s.exec(probe, { timeoutMs: 30_000 });
            return { srv, r };
          });
          const text = out.r.stdout;
          const os = (text.split("---SVC---")[0] || "").trim() || "?";
          const svc = ((text.split("---SVC---")[1] || "").split("---CO---")[0] || "").trim() || "(none)";
          const co = ((text.split("---CO---")[1] || "").trim()) || "(none)";
          const serving = /\b(caddy|ingest|web|console|edge|sgtm)\b/.test(svc);
          if (m.role === "witness" && serving) problems.push(`${m.name} (witness) is running serving containers (${svc}) — the witness should not serve user traffic`);
          if (m.role === "node" && !serving) problems.push(`${m.name} (node) has no serving containers up — it isn't taking traffic`);
          rows.push([m.name, m.role, out.srv.host, os, lastLines(svc, 1).slice(0, 40), co]);
        } catch (e) {
          problems.push(`${m.name} (${m.role}) UNREACHABLE: ${(e as Error).message.split("\n")[0]}`);
          rows.push([m.name, m.role, "?", "UNREACHABLE", "-", "-"]);
        }
      }

      let vip = "";
      if (cl.vip) {
        const r = await deps.local(`curl -ksS -m 8 -o /dev/null -w '%{http_code}' https://${shq(cl.vip)}/ 2>/dev/null || echo 000`);
        vip = `VIP ${cl.vip}: HTTP ${r.stdout.trim() || "000"}${/^[23]/.test(r.stdout.trim()) ? "" : " (not answering — check keepalived/VRRP holder)"}`;
      }

      const verdict = problems.length === 0 ? "HEALTHY" : "NEEDS ATTENTION";
      return [
        `# Cluster ${cl.name} — ${verdict}`,
        problems.length ? "Findings:\n" + problems.map((p) => `  - ${p}`).join("\n") : "All members reachable + in their expected role.",
        ``,
        table(["MEMBER", "ROLE", "HOST", "OS", "SERVICES", "CHECKOUTS"], rows),
        vip ? `\n${vip}` : "",
        `\nidp: ${cl.idpIssuer ?? "-"} · hosts: ${cl.hosts.length} (edge_validate to check them)`,
      ].filter(Boolean).join("\n");
    },
  },

  {
    name: "bluegreen_deploy",
    title: "Rolling (blue-green) deploy across the cluster",
    description:
      "Zero-interruption code deploy across an HA cluster's serving nodes (DEPLOYMENT_SRE §8.2): one node at a " +
      "time — redeploy (git pull → rebuild/migrate) → health-gate → only then move to the next. If a node fails " +
      "its gate it STOPS and leaves the remaining nodes untouched (still serving the old version). The VIP/LB " +
      "sheds the draining node by its health check, so traffic keeps flowing. Migrations must be expand-then-" +
      "contract so old + new run concurrently during the roll. Requires confirm:true.",
    schema: {
      cluster: clusterParam,
      stack: z.enum(["adpix", "tagmanager"]).default("adpix").describe("Which stack to roll on each node"),
      branch: z.string().optional().describe("Branch to deploy (default: each node's checked-out branch)"),
      tmDir: z.string().default("/opt/adpix-tagmanager").describe("Tag Manager checkout dir (stack:tagmanager)"),
      confirm: z.boolean().default(false).describe("Must be true — this redeploys production nodes"),
      timeoutSeconds: z.number().int().min(60).max(7200).default(2400),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { cluster?: string; stack: "adpix" | "tagmanager"; branch?: string; tmDir: string; confirm: boolean; timeoutSeconds: number };
      let cl;
      try {
        cl = resolveCluster(a.cluster);
      } catch (e) {
        return (e as Error).message;
      }
      if (!cl.nodes.length) return `Cluster "${cl.name}" has no serving nodes (cluster_define nodes:[...]). Nothing to roll.`;
      if (!a.confirm) return `REFUSED: bluegreen_deploy redeploys ${cl.nodes.length} production node(s) (${cl.nodes.join(", ")}) one at a time. Re-run with confirm:true.`;

      const out: string[] = [`# Rolling ${a.stack} deploy across ${cl.name} (${cl.nodes.join(" → ")})`];
      let stopped = false;
      for (let i = 0; i < cl.nodes.length; i++) {
        const node = cl.nodes[i];
        if (stopped) {
          out.push(`\n## ${node} — SKIPPED (a prior node failed its gate; left on the old version, still serving)`);
          continue;
        }
        try {
          const res = await withSession(deps, node, async (s, srv) => {
            const dir = a.stack === "adpix" ? srv.adpixDir : a.tmDir;
            const isRepo = (await s.exec(`test -d ${shq(dir + "/.git")} && echo yes || echo no`)).stdout.trim() === "yes";
            if (!isRepo) return { ok: false, detail: `no ${a.stack} checkout at ${dir}` };
            const branch = a.branch || (await s.exec(`cd ${shq(dir)} && git rev-parse --abbrev-ref HEAD`)).stdout.trim();
            const pull = await s.exec(gitSyncCmd(dir, branch), { timeoutMs: 300_000 });
            if (pull.code !== 0) return { ok: false, detail: `git update failed (local edits stashed/safe):\n${lastLines(pull.stdout, 8)}` };

            if (a.stack === "adpix") {
              const dep = await s.exec(`cd ${shq(dir)} && ./scripts/deploy.sh 2>&1`, { timeoutMs: a.timeoutSeconds * 1000 });
              const gate = await s.exec(waitHealthyCmd(150), { timeoutMs: 180_000 });
              return { ok: dep.code === 0 && gate.code === 0, detail: `deploy exit ${dep.code}; ${gate.stdout.trim()}\n${dep.code === 0 ? "" : redactSecrets(lastLines(dep.stdout, 10))}` };
            }
            const b = await s.exec(`${tmCompose(dir)} build 2>&1`, { timeoutMs: a.timeoutSeconds * 1000 });
            if (b.code !== 0) return { ok: false, detail: `tm build exit ${b.code}\n${redactSecrets(lastLines(b.stdout, 10))}` };
            const u = await s.exec(`${tmCompose(dir)} up -d 2>&1`, { timeoutMs: 600_000 });
            const gate = await s.exec(tmHealthGate(150), { timeoutMs: 180_000 });
            return { ok: u.code === 0 && gate.code === 0, detail: `up exit ${u.code}; ${gate.stdout.trim()}` };
          });
          out.push(`\n## ${node} — ${res.ok ? "DEPLOYED + healthy ✅" : "FAILED 🛑"}\n${res.detail}`);
          if (!res.ok) {
            stopped = true;
            out.push(`\n→ Stopping the roll. ${node} is unhealthy on the new version — the VIP/LB should be shedding it. Roll back this node (its tool's rollback, or redeploy the prior commit) before continuing.`);
          }
        } catch (e) {
          stopped = true;
          out.push(`\n## ${node} — UNREACHABLE 🛑\n${(e as Error).message.split("\n")[0]}\n→ Stopping the roll.`);
        }
      }
      out.push(`\n${stopped ? "Roll STOPPED mid-way — fix the failed node, then re-run to finish the remaining ones." : "All nodes rolled to the new version and healthy."}`);
      return out.join("\n");
    },
  },

  {
    name: "ha_quorum",
    title: "HA datastore quorum (PG / Redis / ClickHouse)",
    description:
      "Manage the witness-anchored quorum for the stateful tier (DEPLOYMENT_SRE §4) — the witness carries the 3rd " +
      "vote so the two data nodes never split-brain. mode:status probes every member's Postgres role (primary/" +
      "standby), Redis role + replication link + Sentinel, and ClickHouse replica/Keeper state, and rolls up a " +
      "quorum verdict. mode:plan prints the grounded standup playbook (Patroni/repmgr + Redis Sentinel + CH Keeper). " +
      "mode:keeper-config generates the 3-node ClickHouse Keeper replication.xml with the witness as the tie-break " +
      "vote. Read-only / config-generating — it does not perform a failover.",
    schema: {
      cluster: clusterParam,
      mode: z.enum(["status", "plan", "keeper-config"]).default("status"),
    },
    annotations: { readOnlyHint: true },
    handler: async (deps, args) => {
      const a = args as { cluster?: string; mode: string };
      let cl;
      try {
        cl = resolveCluster(a.cluster);
      } catch (e) {
        return (e as Error).message;
      }
      const members: { name: string; role: string }[] = [
        ...(cl.witness ? [{ name: cl.witness, role: "witness" }] : []),
        ...cl.nodes.map((n) => ({ name: n, role: "node" })),
      ];

      if (a.mode === "plan") {
        return [
          `# HA quorum standup — ${cl.name}`,
          `The witness (${cl.witness ?? "VM1"}) carries the 3rd vote for every quorum so the two data nodes (${cl.nodes.join(", ") || "VM2/VM3"}) never split-brain. It never serves user traffic.`,
          ``,
          `## Postgres (primary + sync standby + witness arbiter)`,
          `  - Run a Patroni (or repmgr) cluster: primary on one node, SYNCHRONOUS standby on the other, the witness as the failover arbiter (a non-data Patroni/etcd member or the repmgr witness).`,
          `  - The VIP / connection string follows the primary; the witness breaks ties so a single node loss auto-promotes without split-brain.`,
          `  - Both product DBs (Analytics + TM) ride the same cluster (separate databases).`,
          ``,
          `## Redis (primary + replica + 3 Sentinels)`,
          `  - primary + replica across the two nodes; Sentinel on BOTH nodes + a 3rd on the witness (quorum=2).`,
          `  - This is the shared cross-replica rate-limiter (ADR-0040) + the TM pointer/purge bus — mandatory at HA scale, not optional.`,
          ``,
          `## ClickHouse (Replicated*MergeTree + 3-node Keeper)`,
          `  - CH_REPLICATED=1 on a FRESH deploy (events_local only converts clean; the irreplaceable truth is raw_events_jsonl — ch_backup first).`,
          `  - A Replicated replica per node + an embedded/standalone Keeper on each node AND the witness = a 3-node raft (mode:keeper-config generates the XML).`,
          ``,
          `Migrations stay expand-then-contract so old + new code run concurrently during a rolling deploy (bluegreen_deploy). Check the live state any time with mode:status.`,
        ].join("\n");
      }

      if (a.mode === "keeper-config") {
        const hosts = members.map((m) => {
          try {
            return { ...m, host: resolveServer(m.name).host };
          } catch {
            return { ...m, host: m.name };
          }
        });
        const servers = hosts.map((h, i) =>
          `      <server>\n        <id>${i + 1}</id>\n        <hostname>${h.host}</hostname>\n        <port>9234</port>\n      </server>`
        ).join("\n");
        const xml =
          `<clickhouse>\n` +
          `  <keeper_server>\n    <tcp_port>9181</tcp_port>\n    <server_id>REPLACE_WITH_THIS_NODES_ID</server_id>\n` +
          `    <log_storage_path>/var/lib/clickhouse/coordination/log</log_storage_path>\n` +
          `    <snapshot_storage_path>/var/lib/clickhouse/coordination/snapshots</snapshot_storage_path>\n` +
          `    <raft_configuration>\n${servers}\n    </raft_configuration>\n  </keeper_server>\n` +
          `  <zookeeper>\n` +
          hosts.map((h) => `    <node><host>${h.host}</host><port>9181</port></node>`).join("\n") +
          `\n  </zookeeper>\n` +
          `  <macros>\n    <shard>01</shard>\n    <replica>REPLACE_WITH_THIS_NODES_REPLICA_NAME</replica>\n  </macros>\n` +
          `  <default_replica_path>/clickhouse/tables/{shard}/{database}/{table}</default_replica_path>\n` +
          `  <default_replica_name>{replica}</default_replica_name>\n</clickhouse>\n`;
        return [
          `# ClickHouse Keeper — 3-node raft for ${cl.name}`,
          `Quorum members (raft ids 1..${hosts.length}): ${hosts.map((h, i) => `${i + 1}=${h.name}(${h.host},${h.role})`).join(", ")}.`,
          ``,
          `Write this to ops/clickhouse/config.d/replication.xml on EACH member, setting <server_id> to that node's raft id and <replica> to a DISTINCT name (e.g. replica-01/02; the witness runs Keeper-only, no CH replica). Then ch_redeploy action:recreate.`,
          ``,
          "```xml\n" + xml + "```",
          ``,
          `The witness is the 3rd Keeper vote (Keeper-only, carries no data) so a single data-node loss keeps quorum. After bring-up: ch_replication mode:status on the data nodes (total_replicas should reach ${cl.nodes.length}).`,
        ].join("\n");
      }

      // status
      if (!members.length) return `Cluster "${cl.name}" has no members. cluster_define witness + nodes first.`;
      const DC = "docker compose -p adanalytics -f compose.yaml -f compose.prod.yaml";
      const rows: string[][] = [];
      const problems: string[] = [];
      let primaries = 0;
      let redisMasters = 0;
      let sentinels = 0;
      for (const m of members) {
        try {
          const probe = await withSession(deps, m.name, async (sess, srv) => {
            const dir = srv.adpixDir;
            const pg = (await sess.exec(`cd ${shq(dir)} && ${DC} exec -T postgres sh -c 'psql -U "\${POSTGRES_USER:-sovereign}" -tAc "SELECT pg_is_in_recovery()" 2>/dev/null' 2>/dev/null || echo "?"`, { timeoutMs: 30_000 })).stdout.trim();
            const redis = (await sess.exec(`cd ${shq(dir)} && ${DC} exec -T redis redis-cli info replication 2>/dev/null | grep -E '^role:|^master_link_status:|^connected_slaves:' | tr '\\r\\n' '  '`, { timeoutMs: 30_000 })).stdout.trim();
            const sentinel = (await sess.exec(`cd ${shq(dir)} && ${DC} exec -T redis redis-cli -p 26379 ping 2>/dev/null || echo none`, { timeoutMs: 20_000 })).stdout.trim();
            const ch = (await sess.exec(`cd ${shq(dir)} && ${DC} exec -T clickhouse sh -c 'clickhouse-client --user "\${CLICKHOUSE_USER:-default}" --password "$CLICKHOUSE_PASSWORD" --query "SELECT countIf(is_readonly), count() FROM system.replicas FORMAT TabSeparated" 2>/dev/null' 2>/dev/null || echo "?"`, { timeoutMs: 30_000 })).stdout.trim();
            return { pg, redis, sentinel, ch };
          });
          const pgRole = probe.pg === "f" ? "primary" : probe.pg === "t" ? "standby" : "?";
          if (pgRole === "primary") primaries++;
          const redisRole = (probe.redis.match(/role:(\w+)/) || [])[1] ?? "?";
          if (redisRole === "master") redisMasters++;
          const link = (probe.redis.match(/master_link_status:(\w+)/) || [])[1];
          if (redisRole === "slave" && link && link !== "up") problems.push(`${m.name}: redis replica link is ${link} (not up)`);
          const sentinelUp = /PONG/i.test(probe.sentinel);
          if (sentinelUp) sentinels++;
          const [chRo = "?", chTot = "?"] = probe.ch.split(/\t|\s+/);
          if (chRo !== "?" && Number(chRo) > 0) problems.push(`${m.name}: ${chRo} ClickHouse replica(s) read-only`);
          rows.push([m.name, m.role, pgRole, `${redisRole}${link ? "/" + link : ""}`, sentinelUp ? "yes" : "no", chTot === "?" ? "-" : `${chRo} ro/${chTot}`]);
        } catch (e) {
          problems.push(`${m.name} (${m.role}) UNREACHABLE: ${(e as Error).message.split("\n")[0]}`);
          rows.push([m.name, m.role, "?", "?", "?", "?"]);
        }
      }
      if (primaries === 0) problems.push("no Postgres PRIMARY found — no writer (failover stuck?)");
      if (primaries > 1) problems.push(`${primaries} Postgres PRIMARIES — SPLIT-BRAIN risk`);
      if (redisMasters > 1) problems.push(`${redisMasters} Redis masters — split-brain risk`);
      if (sentinels < 3) problems.push(`only ${sentinels} Redis Sentinel(s) reachable — need 3 (one on the witness) for a safe quorum`);

      const verdict = problems.length === 0 ? "HEALTHY" : problems.some((p) => /SPLIT-BRAIN|no writer|read-only/.test(p)) ? "NEEDS ATTENTION" : "OK with warnings";
      return [
        `# HA quorum — ${cl.name}  —  ${verdict}`,
        problems.length ? "Findings:\n" + problems.map((p) => `  - ${p}`).join("\n") : "1 PG primary + standby, Redis master + replica, Sentinel quorum, CH replicas writable.",
        ``,
        table(["MEMBER", "ROLE", "POSTGRES", "REDIS", "SENTINEL", "CH(ro/total)"], rows),
        ``,
        `Quorum wants: exactly 1 PG primary (rest standby), 1 Redis master + replica(s), 3 Sentinels (incl. witness), 0 read-only CH replicas. mode:plan for the standup, mode:keeper-config for the CH Keeper XML.`,
      ].join("\n");
    },
  },
];
