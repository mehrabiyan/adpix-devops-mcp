import { buildDnsPlan, type DnsRecord } from "../../install/dns.js";
import { DEFAULT_LAUNCH_HOSTS } from "../../launch/hosts.js";
import { resolveCluster } from "../../registry.js";

/**
 * DNS aggregator — structured records for the DNS & connect screen. Pure computation (no SSH):
 * reuses buildDnsPlan() over the cluster's hosts + VIP, exactly like the dns_plan tool, but
 * returns the structured DnsRecord[] the UI renders into a table instead of rendered text.
 */
export interface DnsView { records: DnsRecord[]; error?: string }

export function buildDnsView(cluster?: string): DnsView {
  try {
    let hosts: string[] = DEFAULT_LAUNCH_HOSTS;
    let vip: string | undefined;
    try {
      const cl = resolveCluster(cluster);
      hosts = cl.hosts.length ? cl.hosts : DEFAULT_LAUNCH_HOSTS;
      vip = cl.vip;
    } catch { /* no cluster — use the default launch hosts */ }
    return { records: buildDnsPlan({ hosts, vip }) };
  } catch (e) {
    return { records: [], error: (e as Error).message };
  }
}
