import type { Deps } from "../deps.js";
import { shq } from "../util.js";

/**
 * End-to-end install verification — the gate. Not just `curl /healthz`: a real MCP
 * handshake through the public URL (proves transport + the Bearer token), DNS resolution
 * of every public host, SSH reachability to each fleet member with the generated identity,
 * and TLS presence on the MCP domain. Runs from the MCP host via deps.local + deps.connect.
 */

export interface VerifyInput {
  url: string; // https://mcp.example.com/mcp or http://<ip>:8930/mcp
  token?: string;
  mcpDomain?: string;
  hosts: string[];
  fleet: { name: string }[];
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "installer", version: "0" } },
});

export async function verifyInstall(deps: Deps, input: VerifyInput): Promise<{ checks: Check[]; verdict: string }> {
  const checks: Check[] = [];
  const base = input.url.replace(/\/mcp$/, "");

  // 1. healthz (no auth)
  const h = await deps.local(`curl -fsS -m 8 ${shq(base + "/healthz")} 2>/dev/null || echo FAIL`);
  checks.push({ name: "healthz", ok: h.stdout.trim() === "ok", detail: h.stdout.trim() || "no response" });

  // 2. real MCP handshake (initialize + Bearer) — proves transport + auth end to end
  const init = await deps.local(
    `curl -sS -m 10 -X POST ${shq(input.url)} ` +
      `-H ${shq("authorization: Bearer " + (input.token ?? ""))} ` +
      `-H 'content-type: application/json' -H 'accept: application/json, text/event-stream' ` +
      `-d ${shq(INIT_BODY)} 2>/dev/null || true`
  );
  const handshakeOk = /adpix-devops-mcp/.test(init.stdout) && !/Unauthorized|"code":-32001|401/.test(init.stdout);
  checks.push({ name: "mcp handshake (initialize + token)", ok: handshakeOk, detail: handshakeOk ? "server responded, token accepted" : "no valid MCP response (auth/transport/TLS?)" });

  // 3. DNS resolution of the public hosts
  for (const host of input.hosts) {
    const d = await deps.local(`dig +short ${shq(host)} A 2>/dev/null | head -1`);
    const v = d.stdout.trim();
    checks.push({ name: `dns ${host}`, ok: !!v, detail: v || "does not resolve" });
  }

  // 4. SSH reachability to each fleet member with the generated identity
  for (const m of input.fleet) {
    try {
      const srv = deps.resolve(m.name);
      const s = await deps.connect(srv);
      try {
        const r = await s.exec("uname -s", { timeoutMs: 20_000 });
        checks.push({ name: `ssh ${m.name}`, ok: r.code === 0, detail: r.stdout.trim() || (r.code === 0 ? "reachable" : `exit ${r.code}`) });
      } finally {
        s.close();
      }
    } catch (e) {
      checks.push({ name: `ssh ${m.name}`, ok: false, detail: (e as Error).message.split("\n")[0] });
    }
  }

  // 5. TLS present on the MCP domain
  if (input.mcpDomain) {
    const t = await deps.local(`echo | timeout 8 openssl s_client -servername ${shq(input.mcpDomain)} -connect ${shq(input.mcpDomain)}:443 2>/dev/null | openssl x509 -noout -subject 2>/dev/null || true`);
    const ok = /subject/i.test(t.stdout);
    checks.push({ name: `tls ${input.mcpDomain}`, ok, detail: ok ? "certificate present" : "no cert (ACME pending? DNS not resolved yet?)" });
  }

  const fails = checks.filter((c) => !c.ok).length;
  return { checks, verdict: fails === 0 ? "READY" : `${fails} CHECK(S) FAILED` };
}

export function renderVerify(result: { checks: Check[]; verdict: string }): string {
  return [
    `# Install verification — ${result.verdict}`,
    ...result.checks.map((c) => `  [${c.ok ? "PASS" : "FAIL"}] ${c.name} — ${c.detail}`),
  ].join("\n");
}
