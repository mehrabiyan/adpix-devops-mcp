import { describe, expect, it } from "vitest";
import { secretsTools } from "../src/tools/secrets.js";
import type { Deps } from "../src/deps.js";
import type { ExecResult, Session } from "../src/ssh.js";
import type { ServerConfig } from "../src/registry.js";

const SRV: ServerConfig = { name: "prod1", host: "10.0.0.1", port: 22, username: "root", adpixDir: "/opt/adpix" };
const rotate = secretsTools.find((t) => t.name === "secret_rotate")!;

const ENV_INVENTORY = [
  "POSTGRES_USER|9", "POSTGRES_PASSWORD|44", "DATABASE_URL|88", "REDIS_PASSWORD|44",
  "CLICKHOUSE_PASSWORD|0", "MINIO_ROOT_PASSWORD|40", "SERVER_API_KEY|48",
  "OIDC_PRIVATE_KEY_PEM|1700", "SMTP_PASSWORD|24", "SITE_ADDRESS|20",
].join("\n");

// responder keyed on the real shell strings the handler emits; records every command
function deps(extra: (cmd: string) => string | undefined = () => undefined) {
  const seen: string[] = [];
  const session: Session = {
    server: SRV, authMethod: "publickey", close: () => {},
    exec: async (cmd: string): Promise<ExecResult> => {
      seen.push(cmd);
      const e = extra(cmd); if (e !== undefined) return { code: 0, stdout: e, stderr: "" };
      if (/while IFS=/.test(cmd)) return { code: 0, stdout: ENV_INVENTORY, stderr: "" };
      if (/grep \^POSTGRES_USER=/.test(cmd)) return { code: 0, stdout: "sovereign", stderr: "" };
      if (/\.bak-/.test(cmd) && /cp /.test(cmd)) return { code: 0, stdout: "/opt/adpix/.env.bak-20260626-101500", stderr: "" };
      if (/echo ROTATED/.test(cmd)) return { code: 0, stdout: "ROTATED", stderr: "" };
      if (/up -d --no-deps/.test(cmd)) return { code: 0, stdout: "Recreated", stderr: "" };
      return { code: 0, stdout: "front door HTTP 200", stderr: "" };
    },
  };
  const d: Deps = { resolve: () => SRV, connect: async () => session, local: async () => ({ code: 0, stdout: "", stderr: "" }) };
  return { d, seen };
}

describe("secret_rotate — dry run", () => {
  it("classifies each .env secret (AUTO vs assisted) and never prints values", async () => {
    const { d } = deps();
    const out = await rotate.handler(d, { server: "prod1", stack: "analytics", confirm: false, timeoutSeconds: 600 });
    expect(out).toMatch(/rotation plan/i);
    expect(out).toMatch(/POSTGRES_PASSWORD.*\[AUTO\]/);
    expect(out).toMatch(/REDIS_PASSWORD.*\[AUTO\]/);
    expect(out).toMatch(/SERVER_API_KEY.*\[AUTO\]/);
    expect(out).toMatch(/CLICKHOUSE_PASSWORD.*\[assisted\]/);
    expect(out).toMatch(/OIDC_PRIVATE_KEY_PEM.*\[assisted\]/);
    // derived URL + plain key are not listed as rotatable secrets
    expect(out).not.toMatch(/DATABASE_URL\s+\d/);
    expect(out).not.toMatch(/SITE_ADDRESS/);
  });
});

describe("secret_rotate — execute", () => {
  it("refuses confirm without a selection", async () => {
    const { d } = deps();
    const out = await rotate.handler(d, { server: "prod1", stack: "analytics", confirm: true, timeoutSeconds: 600 });
    expect(out).toMatch(/REFUSED/);
  });

  it("rotates Postgres: ALTER ROLE in the container + rewrites DATABASE_URL, never echoes the secret", async () => {
    const { d, seen } = deps();
    const out = await rotate.handler(d, { server: "prod1", stack: "analytics", keys: ["POSTGRES_PASSWORD"], confirm: true, timeoutSeconds: 600 });
    expect(out).toMatch(/Rotated \(1\): POSTGRES_PASSWORD/);
    expect(out).toMatch(/backed up/);
    const pg = seen.find((c) => /ALTER ROLE/.test(c))!;
    expect(pg).toBeTruthy();
    expect(pg).toMatch(/ALTER ROLE .*sovereign.* WITH PASSWORD '\$NP'/);   // value is a shell var, generated on-box
    expect(pg).toMatch(/sed -i -E "s#\(:\/\/\[\^:\/@\]\+:\)\[\^@\]\*@#/);   // DATABASE_URL password rewrite
    expect(seen.some((c) => /up -d --no-deps/.test(c))).toBe(true);        // consumers restarted
    // no generated secret value can appear — the only var is $NP, never an actual hex literal in output
    expect(out).not.toMatch(/[0-9a-f]{32}/);
  });

  it("scope=self rotates only app secrets, skips datastore/assisted", async () => {
    const { d, seen } = deps();
    const out = await rotate.handler(d, { server: "prod1", stack: "analytics", scope: "self", confirm: true, timeoutSeconds: 600 });
    expect(out).toMatch(/Rotated.*SERVER_API_KEY/);
    expect(out).not.toMatch(/Rotated.*POSTGRES_PASSWORD/);
    expect(seen.some((c) => /ALTER ROLE/.test(c))).toBe(false);
  });

  it("reports an assisted key (ClickHouse) as skipped with its coordinated-path hint", async () => {
    const { d } = deps();
    const out = await rotate.handler(d, { server: "prod1", stack: "analytics", keys: ["CLICKHOUSE_PASSWORD"], confirm: true, timeoutSeconds: 600 });
    expect(out).toMatch(/Assisted \/ skipped/);
    expect(out).toMatch(/CLICKHOUSE_PASSWORD.*ch_redeploy/);
    expect(out).toMatch(/Rotated: none/);
  });

  it("handles a missing .env", async () => {
    const { d } = deps((cmd) => (/while IFS=/.test(cmd) ? "__NOENV__" : undefined));
    const out = await rotate.handler(d, { server: "prod1", stack: "analytics", confirm: false, timeoutSeconds: 600 });
    expect(out).toMatch(/No \.env/);
  });
});
