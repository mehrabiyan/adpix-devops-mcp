import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildDnsView } from "../src/panel/aggregate/dns.js";
import { saveRegistry, loadRegistry } from "../src/registry.js";

let tmp: string; const SAVED = process.env.ADPIX_DEVOPS_HOME;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adpix-aggdns-")); process.env.ADPIX_DEVOPS_HOME = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (SAVED === undefined) delete process.env.ADPIX_DEVOPS_HOME; else process.env.ADPIX_DEVOPS_HOME = SAVED; });

describe("buildDnsView", () => {
  it("returns structured records with control-plane direct + data-plane proxied (no cluster → defaults)", () => {
    const v = buildDnsView();
    expect(v.error).toBeUndefined();
    expect(v.records.length).toBeGreaterThan(0);
    expect(v.records.some((r) => r.proxied === false)).toBe(true); // control plane
    expect(v.records.some((r) => r.proxied === true)).toBe(true); // data plane
    for (const r of v.records) { expect(r.name).toBeTruthy(); expect(r.type).toMatch(/A|AAAA|CNAME/); expect(r.zone).toBeTruthy(); }
  });
  it("uses the cluster's hosts + VIP when a cluster is defined", () => {
    saveRegistry({ version: 1, servers: {} });
    const reg = loadRegistry();
    reg.clusters = { prod: { nodes: [], hosts: ["app.adpix.io"], idpIssuer: "x", vip: "203.0.113.9" } };
    saveRegistry(reg);
    const v = buildDnsView("prod");
    const app = v.records.find((r) => r.name === "app.adpix.io")!;
    expect(app).toBeTruthy();
    expect(app.proxied).toBe(false); // control plane
    expect(app.value).toBe("203.0.113.9"); // the VIP
  });
});
