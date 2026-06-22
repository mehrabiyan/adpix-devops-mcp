import { withSession, type Deps } from "../../deps.js";
import { HEALTH_ROUTES, localProbeCmd, readSiteAddress } from "../../adpix.js";
import { daysUntil, shq } from "../../util.js";
import { resolveCluster } from "../../registry.js";

/**
 * Monitoring aggregator — structured front-door probes + TLS cert expiry for the Monitoring
 * screen. Reuses the health_check probe (localProbeCmd over HEALTH_ROUTES) and the tls_status
 * openssl probe, but returns typed rows. Host CPU/MEM/DISK comes from the fleet model
 * (/api/fleet) the dashboard already loads, so it isn't re-probed here.
 */
export interface ProbeRow { path: string; service: string; http: string; ms: number; ok: boolean }
export interface CertRow { host: string; notAfter: string; days: number; level: "pos" | "warn" | "neg" }
export interface MonitorView { probes: ProbeRow[]; certs: CertRow[]; error?: string }

export async function buildMonitorView(deps: Deps, server?: string, cluster?: string): Promise<MonitorView> {
  try {
    return await withSession(deps, server, async (s, srv) => {
      const dir = srv.adpixDir;
      const site = await readSiteAddress(s, dir);

      const probes: ProbeRow[] = [];
      for (const route of HEALTH_ROUTES) {
        const r = await s.exec(localProbeCmd(site, route.path), { timeoutMs: 15_000 });
        const [code = "000", time = "0"] = r.stdout.trim().split(/\s+/);
        probes.push({ path: route.path, service: route.service, http: code, ms: Math.round(parseFloat(time) * 1000) || 0, ok: /^[23]/.test(code) });
      }

      let hosts: string[] = [];
      try { hosts = resolveCluster(cluster).hosts; } catch { /* no cluster */ }
      if (!hosts.length && site.domain) hosts = [site.domain];
      const certs: CertRow[] = [];
      for (const host of hosts.slice(0, 12)) {
        const r = await s.exec(`echo | openssl s_client -servername ${shq(host)} -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null`, { timeoutMs: 12_000 });
        const m = r.stdout.match(/notAfter=(.+)/);
        if (!m) { certs.push({ host, notAfter: "no cert served", days: -1, level: "neg" }); continue; }
        const notAfter = m[1].trim();
        const days = daysUntil(Date.parse(notAfter));
        certs.push({ host, notAfter, days, level: days < 0 ? "neg" : days < 14 ? "warn" : "pos" });
      }
      return { probes, certs };
    });
  } catch (e) {
    return { probes: [], certs: [], error: (e as Error).message };
  }
}
