import type { ToolDef } from "./types.js";
import { serverTools } from "./servers.js";
import { lifecycleTools } from "./lifecycle.js";
import { monitorTools } from "./monitor.js";
import { securityTools } from "./security.js";
import { watchdogTools } from "./watchdog.js";
import { cicdTools } from "./cicd.js";
import { aiTools } from "./ai.js";
import { selfTools } from "./self.js";
import { consultTools } from "./consult.js";
import { postgresTools } from "./postgres.js";

export const allTools: ToolDef[] = [
  ...serverTools,
  ...lifecycleTools,
  ...monitorTools,
  ...securityTools,
  ...watchdogTools,
  ...cicdTools,
  ...aiTools,
  ...selfTools,
  ...consultTools,
  ...postgresTools,
];
