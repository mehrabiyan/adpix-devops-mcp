import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { allTools } from "../tools/index.js";
import type { ToolDef } from "../tools/types.js";

/**
 * The panel catalog: the single source of truth for what the UI can do, derived from
 * allTools (never hand-maintained). Groups map tools to the panel's nav sections; each
 * entry ships its JSON-Schema params so the UI can render forms generically.
 */

export interface CatalogEntry {
  name: string;
  title: string;
  description: string;
  group: string;
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  params: unknown; // JSON Schema of the tool's args
}

/** tool name → panel nav group. Falls through to a sensible default per prefix. */
const GROUP: Record<string, string> = {
  // dashboard / monitoring
  health_check: "monitoring", system_metrics: "monitoring", performance_report: "monitoring",
  tls_status: "monitoring", uptime_report: "monitoring", obs_deploy: "monitoring", obs_status: "monitoring",
  // servers / fleet
  server_add: "servers", server_list: "servers", server_remove: "servers", run_command: "servers",
  cluster_define: "servers", cluster_list: "servers", cluster_status: "servers",
  // containers (lifecycle)
  adpix_status: "containers", adpix_restart: "containers", adpix_logs: "containers", adpix_install: "containers",
  tm_install: "containers", tm_status: "containers", tm_health: "containers", tm_logs: "containers",
  tm_restart: "containers", tm_update: "containers", pop_add: "containers",
  // backups
  adpix_backup: "backups", adpix_restore: "backups", pg_backup: "backups", pg_restore_db: "backups",
  ch_backup: "backups", ch_restore_db: "backups",
  // databases
  pg_health: "databases", pg_tune: "databases", pg_optimize: "databases", pg_harden: "databases", pg_redeploy: "databases",
  ch_health: "databases", ch_tune: "databases", ch_optimize: "databases", ch_harden: "databases",
  ch_retention: "databases", ch_redeploy: "databases",
  // deploys
  adpix_update: "deploys", bluegreen_deploy: "deploys", cicd_enable: "deploys", cicd_status: "deploys",
  cicd_run_now: "deploys", cicd_disable: "deploys",
  // high availability
  ha_standup: "ha", ha_quorum: "ha", pg_replication: "ha", ch_replication: "ha",
  // dns & connect
  dns_plan: "dns", connect_configs: "dns",
  // security
  security_audit: "security", harden_server: "security", patch_system: "security", launch_gate: "security",
  secrets_preflight: "security", oidc_health: "security", edge_validate: "security", launch_smoke: "security",
  predeploy_gate: "security",
  // settings / self
  ai_setup: "settings", ai_fix: "settings", mcp_self_update: "settings", mcp_status: "settings", stack_update: "deploys", stack_status: "deploys", capacity_plan: "settings",
  consult_topic: "settings", scale_assessment: "settings", watchdog_install: "settings", watchdog_status: "settings",
  // phase-3 ops
  container_control: "containers", metrics_query: "monitoring", schedule_job: "settings",
  server_resize: "servers", data_move: "backups",
};

function entry(t: ToolDef): CatalogEntry {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    group: GROUP[t.name] ?? "settings",
    readOnly: t.annotations?.readOnlyHint === true,
    destructive: t.annotations?.destructiveHint === true,
    idempotent: t.annotations?.idempotentHint === true,
    params: zodToJsonSchema(z.object(t.schema), { target: "openApi3" }),
  };
}

export function buildCatalog(tools: ToolDef[] = allTools): CatalogEntry[] {
  return tools.map(entry);
}
