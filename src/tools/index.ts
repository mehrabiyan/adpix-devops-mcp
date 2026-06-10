import type { ToolDef } from "./types.js";
import { serverTools } from "./servers.js";
import { lifecycleTools } from "./lifecycle.js";
import { monitorTools } from "./monitor.js";
import { securityTools } from "./security.js";
import { watchdogTools } from "./watchdog.js";

export const allTools: ToolDef[] = [
  ...serverTools,
  ...lifecycleTools,
  ...monitorTools,
  ...securityTools,
  ...watchdogTools,
];
