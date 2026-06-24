import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";
import { allTools } from "../src/tools/index.js";
import { summarizeProbe } from "../src/tools/network.js";
import { saveCert, getCert, listCerts, deleteCert } from "../src/certstore.js";

const tool = (n: string) => { const t = allTools.find((t) => t.name === n); if (!t) throw new Error(n); return t; };
const SRV: ServerConfig = { name: "prod", host: "10.0.0.1", port: 22, username: "root", adpixDir: "/opt/adpix" };
function deps(stdout: string): Deps {
  const session: Session = { server: SRV, authMethod: "publickey", close: () => {}, exec: async (): Promise<ExecResult> => ({ code: 0, stdout, stderr: "" }) };
  return { resolve: () => SRV, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) };
}

// ── net_probe ─────────────────────────────────────────────────────────────────────────────────────
describe("net_probe", () => {
  const rows = (m: Record<string, boolean>) => Object.entries(m).map(([name, ok]) => ({ name, target: "h:443", ok }));
  it("verdict: online when GitHub + a registry + npm reach", () => {
    expect(summarizeProbe(rows({ internet: true, dns: true, dockerhub: true, npm: true }), true).verdict).toBe("online");
  });
  it("verdict: filtered when internet works but GitHub/registries blocked", () => {
    const v = summarizeProbe(rows({ internet: true, dns: false, dockerhub: false, npm: false }), true);
    expect(v.verdict).toBe("filtered");
    expect(v.recommend).toMatch(/net_bridge/);
  });
  it("verdict: offline with no egress", () => {
    expect(summarizeProbe(rows({ internet: false, dns: false }), false).verdict).toBe("offline");
  });
  it("tool renders a verdict from the probe output", async () => {
    const out = await tool("net_probe").handler(deps("internet OK\ndns OK\ndockerhub OK\nghcr NO\napt OK\nnpm OK\ndocker yes\ngit yes"), { server: "prod", timeoutSeconds: 6 });
    expect(out).toMatch(/ONLINE/);
    expect(out).toMatch(/✓ docker installed/);
  });
});

// ── certificate store ───────────────────────────────────────────────────────────────────────────
describe("certificate store", () => {
  let tmp: string; const SAVED = process.env.ADPIX_DEVOPS_HOME;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-certs-")); process.env.ADPIX_DEVOPS_HOME = tmp; });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

  it("saves, lists, reads + deletes a bundle; parses the X509; key file is mode 600", () => {
    const meta = saveCert("tag.internal", { key: FIXTURE_KEY, cert: FIXTURE_CERT, chain: FIXTURE_CERT });
    expect(meta.domain).toBe("tag.internal");
    expect(meta.hasChain).toBe(true);
    expect(meta.subject).toMatch(/adpix-test/);            // parsed the X509
    expect(typeof meta.daysLeft).toBe("number");
    expect(listCerts().map((c) => c.domain)).toContain("tag.internal");
    const keyPath = path.join(tmp, "certs", "tag.internal", "key.pem");
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(getCert("tag.internal")?.cert).toContain("BEGIN CERTIFICATE");
    deleteCert("tag.internal");
    expect(getCert("tag.internal")).toBeNull();
  });

  it("rejects a non-PEM key + a non-PEM cert", () => {
    expect(() => saveCert("x", { key: "not a key", cert: FIXTURE_CERT })).toThrow(/private key is not PEM/);
    expect(() => saveCert("x", { key: FIXTURE_KEY, cert: "nope" })).toThrow(/certificate is not PEM/);
  });

  it("cert_install reports nothing to push when the domain has no stored cert", async () => {
    const out = await tool("cert_install").handler(deps(""), { server: "prod", domain: "absent.internal", reload: false });
    expect(out).toMatch(/No stored certificate/);
  });

  it("cert_install pushes the fullchain + key (mode 600) and returns the Caddy tls directive", async () => {
    saveCert("tag.internal", { key: FIXTURE_KEY, cert: FIXTURE_CERT });
    const calls: string[] = [];
    const d: Deps = { resolve: () => SRV, connect: async () => ({ server: SRV, authMethod: "publickey", close: () => {}, exec: async (cmd: string) => { calls.push(cmd); return { code: 0, stdout: "", stderr: "" }; } }), local: async () => ({ code: 0, stdout: "", stderr: "" }) };
    const out = await tool("cert_install").handler(d, { server: "prod", domain: "tag.internal", reload: false });
    expect(calls.some((c) => /fullchain\.pem/.test(c))).toBe(true);
    expect(calls.some((c) => /chmod 600 .*key\.pem/.test(c))).toBe(true);
    expect(out).toMatch(/tls \/etc\/adpix\/tls\/tag\.internal\/fullchain\.pem/);
  });
});

// real self-signed cert + key (CN=adpix-test), so X509Certificate parses for real
const FIXTURE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCOR3aRd20E84d3
MYn0/swSKffQVSypI6ilM0AuFw4Okf3lj+WoAtZw1Vuzis2YLEbBNVmA3X/moxe9
9CxfCw9gABoD7M5Yx8vCm4MWQaZnpsNJXXjfVpkKlkkbhAZU6Nhewdniyfgq8Ohu
lZ/yS/namgd/L669/7ssP+4H/ScvPNW5/afY+trXZFRTukub+k4ZsaqEsaMPIJbO
jrEJ0RRvZfSFtCoyYLcZN7GBDTELCTNRTdX8KTMdSOh1SQblB53ZUQn5Ma129UT4
M8OYyroU89pNWBOyLJudsIhGnM+Ww/zqEoPEbfZd2als0wSZzO762wT4AmT0F/8u
cjjjoWJdAgMBAAECggEARPg9cMycq27F9zCreHjfQdrYR0RSrvcbNGHAtdb1OHjq
xBJaOHSPsQisOD+L5D1qWxRae85jxtC+nJU1wSjiXh4OfmKXsI/BpWevRuWyHcLI
HdNS2ajn7Srm65C3ZQeug1ijH33acC5x7dFYRKMxzhcmlS/vHClQeWXQJE1CZnH0
/RWogw4Br7S8SNgAJTBzlLPxtISBtRm956mgFEcMlGKNlGxXkYc24aiIBRyb3+G1
zRMCk7MNv6pceMrEeto11d/kqlvUhDdqq7gZGXnaPXaI1cUyTC989GfF/4wmEDqP
w69C/hWTcx/EdSz7otyV1sv4RSzAS3MjZawXvoUy3QKBgQC+/TdewCh69T2IiD27
CgWPtmdjpFcjWEdn24ttdtQEsp14FAkokoXwMqPVSGvcne3zZYa/5EetTR+rprbf
PvsZGSu1wi8mC8ukgjtU7et6FdmJcrJfSXg3O4Xxi8LYJnui421RR7eOTdCpiOCD
0ZDpmbTYwHv2kizI/COewtiB3wKBgQC+tal7F5e+0atQEKfWUfQHQ8MpiGm6HW7t
ppGU1WMFzFen6PQmgfoF8uc7j2+QCV2irPUsfUF1rMTKlMSKWSDLoSoSJNe/yP4S
w85gz5PR2tnU+0AZRSErEQn1P+ggveLFOtiN9fFvtEZn/H85ccbNHUCkrWRNEYLJ
gFrCLBc7QwKBgHAUsbXNFvRxjxbcvT1SeEkKRkpXWzvGxsDQOlaW8X2ARKD/QRCq
TCfV0AeOZJ4noEjCP/3EvbuaEwfs4kzI7RqhhuE3f+vX6D42nxMMPLB8uhjLUppQ
x1fCeqxx1Hp8uvmwdarJZ5L/X4DebsNs7JnqNhMtgpIE3ntkXJMCzYQJAoGAbC4w
jZq8gYn+W9SW4IRsoRJXSuAO2XyIyFaMjpjdKxTXRHBozs88PNOlR6v95P7rFrR1
/16uG0p990yckL4uVFR/wPsVR72EIrDgCRq3B3vVxXMg0TTds8helbhCvQ/561eO
MDkrU+o3ZhVdNgDMfN3zJXcWRoGAZz1gPnU0WHECgYAcFfHKhJl2KvCDd4zleWAN
h2y5zvmjaC4VF/aWfPFGyiavaIzBZwh3p529UmoaoK97w3NlUhLk8L/e/rUE+esf
ZLe4zN7y9qJFATLasFSA8A89g8Vdue+03gvDirOYyLdICpg/rDdROlnuXH6zrEIj
OCxdlVfcnl5/Iu4v3IiCpQ==
-----END PRIVATE KEY-----`;
const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIDCzCCAfOgAwIBAgIUP5JhlYBYHA21ApXj6U+Ubb+pkYUwDQYJKoZIhvcNAQEL
BQAwFTETMBEGA1UEAwwKYWRwaXgtdGVzdDAeFw0yNjA2MjQxMDI1MjBaFw0zNjA2
MjExMDI1MjBaMBUxEzARBgNVBAMMCmFkcGl4LXRlc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCOR3aRd20E84d3MYn0/swSKffQVSypI6ilM0AuFw4O
kf3lj+WoAtZw1Vuzis2YLEbBNVmA3X/moxe99CxfCw9gABoD7M5Yx8vCm4MWQaZn
psNJXXjfVpkKlkkbhAZU6Nhewdniyfgq8OhulZ/yS/namgd/L669/7ssP+4H/Scv
PNW5/afY+trXZFRTukub+k4ZsaqEsaMPIJbOjrEJ0RRvZfSFtCoyYLcZN7GBDTEL
CTNRTdX8KTMdSOh1SQblB53ZUQn5Ma129UT4M8OYyroU89pNWBOyLJudsIhGnM+W
w/zqEoPEbfZd2als0wSZzO762wT4AmT0F/8ucjjjoWJdAgMBAAGjUzBRMB0GA1Ud
DgQWBBTiQnANZ2YR21/335cZCum1GRLKTDAfBgNVHSMEGDAWgBTiQnANZ2YR21/3
35cZCum1GRLKTDAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAm
vTh8T1zfgixNwt5Kn/qInmQF3VOooDoY7PsVDWhbQWw0dLjCVSDeU30DvjMs9CKh
6XeFSILg84kh5jMhhCvoAn/MgLRFrNs9O4ESLnFrNL+xYSEL4M1VIMACw4A4ZG20
Kjdd4PLhnYqZzTTxaQDMKf0/u22GZ7PoUN+yq7L7k60TdJhparYZFDBr3U4Y56OO
t421sD9pceAwFLxhRgBzX/eMPNUj3bxzRs2Tgyy8HzhzdAfHzb4PaWdFWCYjlzog
reh9zn1WPlbOxR+9rd2tY0K5aQLCvPEQS7VIh/pML7kTsCp6JpDGRR+Kpi5EpdVE
Hmoi0JbB9CYk9Fiwxzr3
-----END CERTIFICATE-----`;
