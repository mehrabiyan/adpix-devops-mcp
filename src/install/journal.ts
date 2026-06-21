import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The install-state ledger — the declarative record of what the installer owns + did,
 * so the whole run is idempotent, resumable, and reversible. Per-step status + per-target
 * verify/authorize/host-key-pin status. NEVER stores secrets. mode 600, atomic writes.
 */

export type StepStatus = "pending" | "done" | "failed";

export interface TargetState {
  verified?: boolean;
  authorized?: boolean;
  hostKeyPinned?: boolean;
  detail?: string;
}

export interface InstallJournal {
  version: 1;
  startedAt?: string;
  lastRun?: string;
  steps: Record<string, { status: StepStatus; at?: string; detail?: string }>;
  targets: Record<string, TargetState>;
}

export function emptyJournal(): InstallJournal {
  return { version: 1, steps: {}, targets: {} };
}

/** Lives next to the registry: $ADPIX_DEVOPS_HOME/install-state.json (on the server STATE_DIR). */
export function journalPath(): string {
  const home = process.env.ADPIX_DEVOPS_HOME || path.join(os.homedir(), ".adpix-devops");
  return path.join(home, "install-state.json");
}

export function loadJournal(): InstallJournal {
  try {
    const j = JSON.parse(fs.readFileSync(journalPath(), "utf8")) as InstallJournal;
    return j && j.version === 1 && j.steps && j.targets ? j : emptyJournal();
  } catch {
    return emptyJournal();
  }
}

export function saveJournal(j: InstallJournal): void {
  const p = journalPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function setStep(j: InstallJournal, id: string, status: StepStatus, detail?: string, now = new Date().toISOString()): void {
  j.steps[id] = { status, at: now, detail };
  j.lastRun = now;
}

export function setTarget(j: InstallJournal, name: string, patch: Partial<TargetState>): void {
  j.targets[name] = { ...(j.targets[name] ?? {}), ...patch };
}
