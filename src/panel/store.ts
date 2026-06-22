import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The panel job ledger — persisted record of every async tool invocation the panel ran.
 * Cloned from the install-state journal pattern (atomic tmp+rename, mode 600, lives next to
 * servers.json under $ADPIX_DEVOPS_HOME). NEVER stores secret arg values — args are redacted
 * before they land here. Bounded so the file can't grow without limit.
 */

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled" | "interrupted";

export interface JobRecord {
  id: string;
  tool: string;
  /** Redacted — secret-looking values are masked before persistence/serialization. */
  args: Record<string, unknown>;
  status: JobStatus;
  /** Mutex key (target) so same-target jobs serialize. */
  key: string;
  idempotencyKey?: string;
  actor?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: string;
  error?: string;
  isError?: boolean;
  /** Capped tail of the live log (full stream is over SSE only). */
  logTail: string[];
}

const MAX_PERSISTED_JOBS = 200;
const MAX_PERSISTED_LOG = 120;
const SECRET_KEY = /(pass|passphrase|secret|token|api_?key|private_?key|pwd)/i;

/** Mask secret-looking arg VALUES by key name (defence-in-depth; the panel holds no secrets anyway). */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    out[k] = SECRET_KEY.test(k) && typeof v === "string" && v.length > 0 ? "[redacted]" : v;
  }
  return out;
}

export function jobsPath(): string {
  const home = process.env.ADPIX_DEVOPS_HOME || path.join(os.homedir(), ".adpix-devops");
  return path.join(home, "jobs.json");
}

export function loadJobs(): JobRecord[] {
  try {
    const raw = JSON.parse(fs.readFileSync(jobsPath(), "utf8")) as { version: number; jobs: JobRecord[] };
    return raw && raw.version === 1 && Array.isArray(raw.jobs) ? raw.jobs : [];
  } catch {
    return [];
  }
}

export function saveJobs(jobs: JobRecord[]): void {
  const p = jobsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  // keep newest, cap log tails
  const trimmed = jobs.slice(-MAX_PERSISTED_JOBS).map((j) => ({ ...j, logTail: j.logTail.slice(-MAX_PERSISTED_LOG) }));
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, jobs: trimmed }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
}
