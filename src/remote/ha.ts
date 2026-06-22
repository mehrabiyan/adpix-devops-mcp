import { createHash } from "node:crypto";

/**
 * HA-quorum standup templates: keepalived (the floating VIP + failover) and Redis Sentinel
 * (the 3-vote quorum), rendered + applied by the ha_standup tool. These are host-level
 * config + service (no data mutation), so they're safe to automate. The Postgres primary/
 * standby (pg_replication) and the ClickHouse Keeper (ha_quorum keeper-config) cover the
 * data tier. All bash here is `bash -n`-tested.
 */

/** Deterministic VRRP shared secret so both nodes agree without storing a secret. */
export function vrrpAuthPass(cluster: string, vip: string): string {
  return createHash("sha256").update(`adpix-vrrp:${cluster}:${vip}`).digest("hex").slice(0, 16);
}

export interface KeepalivedOpts {
  role: "MASTER" | "BACKUP";
  vip: string;
  iface: string;
  vrid: number;
  priority: number;
  authPass: string;
  selfIp: string;
  peerIp: string;
}

/** /etc/keepalived/keepalived.conf — unicast VRRP between the two serving nodes, VIP gated on the front door. */
export function renderKeepalivedConf(o: KeepalivedOpts): string {
  return (
    `# adpix HA VIP — managed by adpix-devops-mcp (ha_standup). Do not edit in place.\n` +
    `vrrp_script chk_frontdoor {\n` +
    `    script "/usr/bin/curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:80/"\n` +
    `    interval 2\n    weight -40\n    fall 2\n    rise 2\n}\n` +
    `vrrp_instance ADPIX {\n` +
    `    state ${o.role}\n` +
    `    interface ${o.iface}\n` +
    `    virtual_router_id ${o.vrid}\n` +
    `    priority ${o.priority}\n` +
    `    advert_int 1\n` +
    (o.role === "BACKUP" ? `    nopreempt\n` : ``) +
    `    authentication {\n        auth_type PASS\n        auth_pass ${o.authPass}\n    }\n` +
    `    unicast_src_ip ${o.selfIp}\n` +
    `    unicast_peer {\n        ${o.peerIp}\n    }\n` +
    `    virtual_ipaddress {\n        ${o.vip}\n    }\n` +
    `    track_script {\n        chk_frontdoor\n    }\n}\n`
  );
}

/** Install + start keepalived (the conf is uploaded to /etc/keepalived/keepalived.conf first). */
export function keepalivedSetup(): string {
  return [
    "export DEBIAN_FRONTEND=noninteractive",
    "command -v keepalived >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq keepalived)",
    // let services bind the VIP before this node actually holds it
    "sysctl -w net.ipv4.ip_nonlocal_bind=1 >/dev/null 2>&1 || true",
    "grep -q '^net.ipv4.ip_nonlocal_bind' /etc/sysctl.conf || echo 'net.ipv4.ip_nonlocal_bind=1' >> /etc/sysctl.conf",
    "systemctl enable keepalived >/dev/null 2>&1 || true",
    "systemctl restart keepalived",
    "sleep 2",
    "systemctl is-active keepalived",
  ].join(" && ");
}

export interface SentinelOpts {
  name: string;
  primaryIp: string;
  port: number;
  quorum: number;
  authPass?: string;
}

/** /etc/redis/sentinel.conf — Sentinel monitoring the Redis primary (Sentinel rewrites this at runtime). */
export function renderSentinelConf(o: SentinelOpts): string {
  return (
    [
      "# adpix Redis Sentinel — managed by adpix-devops-mcp (ha_standup)",
      "port 26379",
      "bind 0.0.0.0",
      "sentinel resolve-hostnames yes",
      `sentinel monitor ${o.name} ${o.primaryIp} ${o.port} ${o.quorum}`,
      `sentinel down-after-milliseconds ${o.name} 5000`,
      `sentinel failover-timeout ${o.name} 15000`,
      `sentinel parallel-syncs ${o.name} 1`,
      o.authPass ? `sentinel auth-pass ${o.name} ${o.authPass}` : "",
    ]
      .filter(Boolean)
      .join("\n") + "\n"
  );
}

/** Install + start redis-sentinel (the conf is uploaded to /etc/redis/sentinel.conf first; Sentinel rewrites it so it must be writable by the redis user). */
export function sentinelSetup(): string {
  return [
    "export DEBIAN_FRONTEND=noninteractive",
    "command -v redis-sentinel >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq redis-sentinel)",
    "chown redis:redis /etc/redis/sentinel.conf 2>/dev/null || true",
    "chmod 640 /etc/redis/sentinel.conf 2>/dev/null || true",
    "systemctl enable redis-sentinel >/dev/null 2>&1 || true",
    "systemctl restart redis-sentinel",
    "sleep 2",
    "redis-cli -p 26379 ping 2>/dev/null || systemctl is-active redis-sentinel",
  ].join(" && ");
}
