import type { Role } from "./admins.js";

/**
 * Server-side, default-deny authorization. Roles map to allowed tools using the tool's own
 * readOnly/destructive annotations as the floor; a hard OWNER_ONLY set covers the
 * fleet-shaping / security-downgrading / arbitrary-exec tools that no operator may run. Never
 * trust the SPA to hide actions — every API call is checked here.
 */

/** Tools only an owner may ever run (topology, arbitrary exec, security posture, key/AI changes, restores). */
export const OWNER_ONLY = new Set<string>([
  "run_command", "server_remove", "cluster_define",
  "ha_standup", "bluegreen_deploy", "pg_redeploy", "ch_redeploy",
  "harden_server", "patch_system", "security_audit",
  "ai_setup", "ai_fix", "mcp_self_update",
  "pg_restore_db", "ch_restore_db", "adpix_restore",
  "container_control", "server_resize", "data_move", "schedule_job",
]);

export interface ToolGate {
  name: string;
  readOnly: boolean;
  destructive: boolean;
}

/** True if `role` may invoke this tool at all. */
export function roleAllows(role: Role, tool: ToolGate): boolean {
  if (role === "owner") return true;
  if (OWNER_ONLY.has(tool.name)) return false;
  if (role === "operator") return true; // any non-owner-only tool, incl. ordinary destructive ops
  return tool.readOnly; // viewer
}

/** True if the actor's tenant scopes cover the target named in the args. */
export function targetAllowed(scopes: string[], args: Record<string, unknown>): boolean {
  if (scopes.includes("*")) return true;
  const target = args.cluster ?? args.server;
  if (target === undefined) return true; // unscoped (default-server / global read) — role gate still applies
  return scopes.includes(String(target));
}

/** Combined decision + reason (for the audit trail + the 403 body). */
export function authorize(role: Role, scopes: string[], tool: ToolGate, args: Record<string, unknown>): { ok: boolean; reason: string } {
  if (!roleAllows(role, tool)) return { ok: false, reason: `role "${role}" may not run ${tool.name}` };
  if (!targetAllowed(scopes, args)) return { ok: false, reason: `target "${args.cluster ?? args.server}" is outside your scope` };
  return { ok: true, reason: "ok" };
}
