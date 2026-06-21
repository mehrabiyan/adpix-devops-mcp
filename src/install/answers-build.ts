import { defaultAnswers, DEFAULT_CLUSTER_HOSTS, type InstallAnswers, type FleetRole, type BootstrapAuth } from "./answers.js";

/**
 * Build an InstallAnswers object from the shell wizard's environment variables. The fleet
 * arrives as TAB-delimited records (one server per line) in FLEET_RECORDS; secrets are NOT
 * here (they stay in env and reach the install core separately). Pure + unit-tested; the
 * wizard runs this file to emit the answers JSON it hands to cli.js.
 */
export function buildFromEnv(env: NodeJS.ProcessEnv): InstallAnswers {
  const a = defaultAnswers();
  a.mcp.domain = env.DOMAIN || undefined;
  a.mcp.port = Number(env.PORT || 8930);
  a.mcp.bindHost = env.DOMAIN ? "127.0.0.1" : "0.0.0.0";
  a.mcp.tokenMode = "preserve";
  a.mcp.apiKeyMode = env.ANTHROPIC_API_KEY ? "provided" : "preserve";

  a.fleet = (env.FLEET_RECORDS || "")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.includes("\t"))
    .map((line) => {
      const [name, host, port, username, role, adpixDir, auth] = line.split("\t");
      return {
        name, host,
        port: Number(port) || 22,
        username: username || "root",
        role: (role as FleetRole) || "standalone",
        adpixDir: adpixDir || "/opt/adpix",
        authorizeKey: true,
        bootstrapAuth: (auth as BootstrapAuth) || "agent",
      };
    });

  if (env.CLUSTER_NAME) {
    a.cluster = { name: env.CLUSTER_NAME, vip: env.CLUSTER_VIP || undefined, idpIssuer: "https://account.adpix.io", hosts: DEFAULT_CLUSTER_HOSTS };
  }
  a.emit = { clients: ["claude-code", "claude-desktop"], dnsPlan: true };
  return a;
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(buildFromEnv(process.env), null, 2) + "\n");
}
