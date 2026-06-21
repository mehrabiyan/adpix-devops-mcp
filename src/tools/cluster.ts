import { z } from "zod";
import { loadRegistry, saveRegistry, registryPath, resolveCluster } from "../registry.js";
import { withSession } from "../deps.js";
import { waitHealthyCmd } from "../adpix.js";
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
            const pull = await s.exec(
              `cd ${shq(dir)} && git fetch origin ${shq(branch)} && git checkout ${shq(branch)} && git pull --ff-only origin ${shq(branch)} 2>&1`,
              { timeoutMs: 300_000 }
            );
            if (pull.code !== 0) return { ok: false, detail: `git update failed:\n${lastLines(pull.stdout, 8)}` };

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
];
