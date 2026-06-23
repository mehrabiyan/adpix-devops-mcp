import type { Session } from "./ssh.js";
import { shq } from "./util.js";

/** How AdPix is deployed in production — mirrors scripts/deploy.sh in the adpix repo. */
export const ADPIX_REPO_URL = "https://github.com/mehrabiyan/adpix.git";
export const COMPOSE_PROJECT = "adanalytics";

/** Front-door routes (served by Caddy) worth probing, mapped to the backing service. */
export const HEALTH_ROUTES: { path: string; service: string }[] = [
  { path: "/_apx_health", service: "ingest (collect path)" },
  { path: "/api/v1/version", service: "api (reports)" },
  { path: "/", service: "web (dashboard)" },
  { path: "/t.js", service: "tracker script" },
];

/**
 * Guard for ops that cd into the AdPix checkout (logs/restart/container control). Returns a clear
 * "not installed" message when the checkout is absent — instead of the raw `cd: No such file or
 * directory` that confuses operators on a freshly-added-but-not-yet-provisioned server. null = ok.
 */
export async function notInstalledMsg(s: Session, dir: string, server: string): Promise<string | null> {
  const r = await s.exec(`test -d ${shq(dir + "/.git")} && echo yes || echo no`);
  if (r.stdout.trim() === "yes") return null;
  return `AdPix is not installed at ${dir} on ${server}. Provision it first — Deploys → Install (or run adpix_install) — then retry.`;
}

/** The production compose invocation, run from the AdPix checkout dir. */
export function composeCmd(dir: string): string {
  return `cd ${shq(dir)} && docker compose -p ${COMPOSE_PROJECT} -f compose.yaml -f compose.prod.yaml`;
}

/** Read one KEY from the server-side .env (root-only file — runs under sudo). */
export async function readEnvVar(s: Session, dir: string, key: string): Promise<string> {
  const r = await s.exec(`grep ^${key}= ${shq(dir + "/.env")} 2>/dev/null | head -1 | cut -d= -f2-`);
  return r.stdout.trim();
}

export interface SiteAddress {
  /** Domain (https via Caddy) or empty when serving plain HTTP on the IP. */
  domain: string;
  publicBaseUrl: string;
}

export async function readSiteAddress(s: Session, dir: string): Promise<SiteAddress> {
  const site = await readEnvVar(s, dir, "SITE_ADDRESS");
  const publicBaseUrl = (await readEnvVar(s, dir, "PUBLIC_BASE_URL")) || "http://127.0.0.1";
  const domain = site && site !== ":80" ? site : "";
  return { domain, publicBaseUrl };
}

/**
 * curl command that probes a front-door path *via the local Caddy*:
 *  - domain mode: pin DNS to 127.0.0.1 with --resolve and hit https (exercises TLS + routing)
 *  - IP mode: plain http to 127.0.0.1:80
 * Prints "<http_code> <time_total>".
 */
export function localProbeCmd(site: SiteAddress, urlPath: string, maxSeconds = 10): string {
  const w = `-o /dev/null -w '%{http_code} %{time_total}'`;
  if (site.domain) {
    return `curl -ksS -m ${maxSeconds} --resolve ${shq(site.domain + ":443:127.0.0.1")} ${w} https://${site.domain}${urlPath} 2>/dev/null || echo '000 0'`;
  }
  return `curl -ksS -m ${maxSeconds} ${w} http://127.0.0.1:80${urlPath} 2>/dev/null || echo '000 0'`;
}

/**
 * Single remote loop that waits for the front door to answer (2xx/3xx) —
 * one SSH round-trip instead of polling over the wire.
 */
export function waitHealthyCmd(timeoutSec = 120): string {
  const tries = Math.max(1, Math.floor(timeoutSec / 5));
  return (
    `code=000; for i in $(seq 1 ${tries}); do ` +
    `code=$(curl -ksS -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:80/_apx_health 2>/dev/null || echo 000); ` +
    `case "$code" in 2*|3*) echo "healthy after ~$((i*5))s (HTTP $code)"; exit 0;; esac; sleep 5; done; ` +
    `echo "NOT healthy after ${timeoutSec}s (last HTTP $code)"; exit 1`
  );
}

/** Upload arbitrary file content via base64 (immune to shell quoting issues). */
export async function uploadFile(
  s: Session,
  remotePath: string,
  content: string,
  mode: string
): Promise<void> {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const r = await s.exec(
    `mkdir -p $(dirname ${shq(remotePath)}) && echo ${shq(b64)} | base64 -d > ${shq(remotePath)} && chmod ${mode} ${shq(remotePath)}`
  );
  if (r.code !== 0) {
    throw new Error(`Failed to write ${remotePath}: ${r.stderr || r.stdout}`);
  }
}
