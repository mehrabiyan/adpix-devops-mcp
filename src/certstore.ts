import * as fs from "node:fs";
import * as path from "node:path";
import { X509Certificate } from "node:crypto";
import { registryDir } from "./registry.js";

/**
 * MCP-side TLS certificate store for the Certificate Manager UI. Operators upload a private key +
 * leaf cert (+ optional intermediate chain) for a domain — e.g. an internal CA or a commercial cert —
 * and cert_install pushes them to a server's front door. This is the air-gap / no-Let's-Encrypt path;
 * when a server has internet, the installers still issue a DV Let's Encrypt cert by default.
 *
 * Files live under $ADPIX_DEVOPS_HOME/certs/<domain>/ — key.pem mode 600, cert/chain mode 644.
 */
export interface CertMeta { domain: string; subject?: string; issuer?: string; notAfter?: string; daysLeft?: number; hasChain: boolean; sans: string[] }
export interface CertBundle { key: string; cert: string; chain: string }

/** Does a cert DNS name (possibly a one-level wildcard) cover an FQDN? `*.adpix.io` covers `auth.adpix.io`. */
export function dnsMatch(pattern: string, fqdn: string): boolean {
  const p = pattern.toLowerCase(), f = fqdn.toLowerCase();
  if (p === f) return true;
  if (p.startsWith("*.")) { const suf = p.slice(1); return f.endsWith(suf) && !f.slice(0, f.length - suf.length).includes("."); }
  return false;
}

function certsRoot(): string { return path.join(registryDir(), "certs"); }
function safeDomain(domain: string): string { return domain.trim().toLowerCase().replace(/[^a-z0-9.\-_*]/g, "_"); }
function domDir(domain: string): string { return path.join(certsRoot(), safeDomain(domain)); }

export function saveCert(domain: string, b: { key: string; cert: string; chain?: string }): CertMeta {
  if (!/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(b.key)) throw new Error("private key is not PEM (expected -----BEGIN PRIVATE KEY-----)");
  if (!/-----BEGIN CERTIFICATE-----/.test(b.cert)) throw new Error("certificate is not PEM (expected -----BEGIN CERTIFICATE-----)");
  new X509Certificate(b.cert); // throws on a malformed cert
  if (b.chain && b.chain.trim() && !/-----BEGIN CERTIFICATE-----/.test(b.chain)) throw new Error("chain is not PEM");
  const d = domDir(domain);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(d, "key.pem"), b.key.trim() + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(d, "cert.pem"), b.cert.trim() + "\n", { mode: 0o644 });
  if (b.chain && b.chain.trim()) fs.writeFileSync(path.join(d, "chain.pem"), b.chain.trim() + "\n", { mode: 0o644 });
  else fs.rmSync(path.join(d, "chain.pem"), { force: true });
  return metaOf(safeDomain(domain));
}

export function getCert(domain: string): CertBundle | null {
  const d = domDir(domain);
  const rd = (f: string) => (fs.existsSync(path.join(d, f)) ? fs.readFileSync(path.join(d, f), "utf8") : "");
  const key = rd("key.pem"), cert = rd("cert.pem");
  if (!key || !cert) return null;
  return { key, cert, chain: rd("chain.pem") };
}

export function metaOf(domain: string): CertMeta {
  const c = getCert(domain);
  const m: CertMeta = { domain, hasChain: !!(c && c.chain), sans: [] };
  if (c) {
    try {
      const x = new X509Certificate(c.cert);
      m.subject = x.subject; m.issuer = x.issuer; m.notAfter = x.validTo;
      m.daysLeft = Math.round((new Date(x.validTo).getTime() - Date.now()) / 86_400_000);
      // the FQDNs this cert actually serves (SAN), e.g. "DNS:auth.adpix.io, DNS:*.adpix.io"
      m.sans = (x.subjectAltName || "").split(",").map((s) => s.trim().replace(/^DNS:/i, "")).filter((s) => /^[*a-z0-9.\-_]+$/i.test(s));
    } catch { /* unparseable — still listed */ }
  }
  if (!m.sans.length) m.sans = [domain]; // fall back to the store key
  return m;
}

export function listCerts(): CertMeta[] {
  try {
    return fs.readdirSync(certsRoot()).filter((d) => fs.existsSync(path.join(certsRoot(), d, "cert.pem"))).map(metaOf);
  } catch { return []; }
}

/** Find the stored cert that serves a given FQDN — exact or wildcard SAN match (e.g. *.adpix.io). */
export function resolveCert(fqdn: string): { domain: string; sans: string[]; bundle: CertBundle } | null {
  for (const meta of listCerts()) {
    if (meta.sans.some((s) => dnsMatch(s, fqdn))) {
      const bundle = getCert(meta.domain);
      if (bundle) return { domain: meta.domain, sans: meta.sans, bundle };
    }
  }
  return null;
}

export function deleteCert(domain: string): void { fs.rmSync(domDir(domain), { recursive: true, force: true }); }
