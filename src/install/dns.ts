import { classifyHost } from "../launch/hosts.js";
import { table } from "../util.js";

/**
 * DNS plan generator (pure). Given the cluster's public hosts + the VIP + the CDN origin
 * + the MCP's own domain/host IP, produce the exact records the operator must create:
 * control-plane *.adpix.io -> the VIP (un-proxied), data-plane *.adpix.net -> the CDN
 * origin (proxied), and mcp.<domain> -> this host. Renders a table, a BIND snippet, and
 * dig verification commands. Plan-only — never touches a provider API.
 */

export interface DnsRecord {
  name: string;
  type: "A" | "AAAA" | "CNAME";
  value: string;
  ttl: number;
  proxied: boolean;
  zone: string;
}

export interface DnsPlanInput {
  hosts: string[];
  vip?: string;
  cdnOrigin?: string;
  mcpDomain?: string;
  mcpHostIp?: string;
  ttl?: number;
}

function apexZone(host: string): string {
  return host.split(".").slice(-2).join(".");
}

export function buildDnsPlan(input: DnsPlanInput): DnsRecord[] {
  const ttl = input.ttl ?? 300;
  const recs: DnsRecord[] = [];
  for (const h of input.hosts) {
    const cls = classifyHost(h);
    if (cls.plane === "control") {
      recs.push({ name: h, type: "A", value: input.vip || input.mcpHostIp || "<VIP>", ttl, proxied: false, zone: apexZone(h) });
    } else {
      recs.push({ name: h, type: "A", value: input.cdnOrigin || input.vip || input.mcpHostIp || "<CDN-origin>", ttl, proxied: true, zone: apexZone(h) });
    }
  }
  if (input.mcpDomain) {
    recs.push({ name: input.mcpDomain, type: "A", value: input.mcpHostIp || "<this-host-ip>", ttl, proxied: false, zone: apexZone(input.mcpDomain) });
  }
  return recs;
}

export function renderDnsTable(recs: DnsRecord[]): string {
  if (!recs.length) return "(no records)";
  return table(
    ["NAME", "TYPE", "VALUE", "TTL", "PROXIED", "ZONE"],
    recs.map((r) => [r.name, r.type, r.value, String(r.ttl), r.proxied ? "yes" : "no", r.zone])
  );
}

/** BIND-style zone snippets grouped by zone (sub-label relative names, @ for apex). */
export function renderBindSnippet(recs: DnsRecord[]): string {
  const byZone = new Map<string, DnsRecord[]>();
  for (const r of recs) (byZone.get(r.zone) ?? byZone.set(r.zone, []).get(r.zone)!).push(r);
  const out: string[] = [];
  for (const [zone, rs] of byZone) {
    out.push(`; --- zone: ${zone} ---`);
    out.push(`$ORIGIN ${zone}.`);
    for (const r of rs) {
      const sub = r.name === zone ? "@" : r.name.slice(0, -(zone.length + 1));
      out.push(`${sub.padEnd(24)} ${String(r.ttl).padEnd(6)} IN  ${r.type.padEnd(5)} ${r.value}${r.proxied ? "   ; proxied at the CDN" : ""}`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}

export function providerNotes(): string {
  return [
    "Provider notes:",
    "  - Cloudflare: control-plane (*.adpix.io) records DNS-only (grey cloud); data-plane (*.adpix.net) proxied (orange cloud).",
    "  - Route53: plain A records to the VIP / CDN origin; front the data plane with CloudFront if used.",
    "  - ArvanCloud: enable CDN on the *.adpix.net hosts; point control-plane + mcp at the origin/VIP directly.",
  ].join("\n");
}

/** dig commands to confirm each record resolves to its expected value (the verify loop). */
export function digVerifyCommands(recs: DnsRecord[]): { host: string; expect: string; cmd: string }[] {
  return recs.map((r) => ({ host: r.name, expect: r.value, cmd: `dig +short ${r.name} ${r.type}` }));
}

export function renderDnsPlan(input: DnsPlanInput): string {
  const recs = buildDnsPlan(input);
  return [
    `# DNS plan (${recs.length} records)`,
    renderDnsTable(recs),
    ``,
    "## BIND zone snippet",
    "```",
    renderBindSnippet(recs),
    "```",
    ``,
    providerNotes(),
    ``,
    `Create the records, then verify they resolve (Caddy needs them for TLS):`,
    digVerifyCommands(recs).map((d) => `  ${d.cmd}   # expect ${d.expect}`).join("\n"),
  ].join("\n");
}
