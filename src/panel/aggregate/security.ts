import { withSession, type Deps } from "../../deps.js";
import { runAudit, type AuditFinding } from "../../tools/security.js";
import { loadRegistry } from "../../registry.js";
import { ANALYTICS_P1_BLOCKERS } from "../../launch/hosts.js";
import { classifyError } from "../errors.js";

/**
 * Security aggregator — structured audit findings + score + launch-gate state for the Security
 * screen. Reuses runAudit() (already structured {level,what}) so there's no prose parsing, and
 * reads the launch gate straight from the registry.
 */
export interface GateView { cleared: boolean; reference?: string; at?: string; blockers: string[] }
export interface SecurityView {
  findings: AuditFinding[];
  counts: { pass: number; warn: number; fail: number };
  score: number;
  verdict: string;
  launchGate: GateView;
  error?: string;
}

function gate(): GateView {
  const g = loadRegistry().launchGate;
  return { cleared: !!g?.resolved, reference: g?.reference, at: g?.at, blockers: g?.resolved ? [] : [...ANALYTICS_P1_BLOCKERS] };
}

export async function buildSecurityView(deps: Deps, server?: string): Promise<SecurityView> {
  const launchGate = gate();
  let findings: AuditFinding[];
  try {
    findings = await withSession(deps, server, (s, srv) => runAudit(s, srv));
  } catch (e) {
    return { findings: [], counts: { pass: 0, warn: 0, fail: 0 }, score: 0, verdict: "", launchGate, error: classifyError(e).message };
  }
  const counts = { pass: findings.filter((f) => f.level === "PASS").length, warn: findings.filter((f) => f.level === "WARN").length, fail: findings.filter((f) => f.level === "FAIL").length };
  const total = counts.pass + counts.warn + counts.fail || 1;
  const score = Math.round((counts.pass / total) * 100);
  const verdict = counts.fail > 0 ? "ACTION REQUIRED" : counts.warn > 0 ? "ROOM TO HARDEN" : "GOOD";
  // FAIL first, then WARN, then PASS — surface the worst at the top
  const order = { FAIL: 0, WARN: 1, PASS: 2 } as const;
  findings.sort((a, b) => order[a.level] - order[b.level]);
  return { findings, counts, score, verdict, launchGate };
}
