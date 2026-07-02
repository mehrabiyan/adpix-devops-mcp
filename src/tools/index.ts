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
import { clickhouseTools } from "./clickhouse.js";
import { clusterTools } from "./cluster.js";
import { launchTools } from "./launch.js";
import { tagmanagerTools } from "./tagmanager.js";
import { observabilityTools } from "./observability.js";
import { installTools } from "./install.js";
import { haTools } from "./ha.js";
import { opsTools } from "./ops.js";
import { stackTools } from "./stack.js";
import { smtpTools } from "./smtp.js";
import { doctorTools } from "./doctor.js";
import { readinessTools } from "./readiness.js";
import { relocateTools } from "./relocate.js";
import { networkTools } from "./network.js";
import { certTools } from "./certs.js";
import { offlineTools } from "./offline.js";
import { threatTools } from "./threat.js";
import { secretsTools } from "./secrets.js";
import { honeypotTools } from "./honeypot.js";
import { egressTools } from "./egress.js";
import { kafkaTools } from "./kafka.js";

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
  ...clickhouseTools,
  ...clusterTools,
  ...launchTools,
  ...tagmanagerTools,
  ...observabilityTools,
  ...installTools,
  ...haTools,
  ...opsTools,
  ...stackTools,
  ...smtpTools,
  ...doctorTools,
  ...readinessTools,
  ...relocateTools,
  ...networkTools,
  ...certTools,
  ...offlineTools,
  ...threatTools,
  ...secretsTools,
  ...honeypotTools,
  ...egressTools,
  ...kafkaTools,
];
