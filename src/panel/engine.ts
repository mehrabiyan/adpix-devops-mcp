import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Deps } from "../deps.js";
import type { ToolDef } from "../tools/types.js";
import { observedDeps } from "./observed-deps.js";
import { type JobRecord, type JobStatus, loadJobs, saveJobs, redactArgs } from "./store.js";

/**
 * The async job engine: turns a tool invocation into a tracked, persisted, cancellable JOB.
 * Read-only tools run inline elsewhere; everything mutating/slow comes here. Bounded worker
 * pool + per-target mutex (same server/cluster serializes; independent targets run in
 * parallel). Live logs stream via subscribe(). On boot, in-flight jobs are reconciled to
 * 'interrupted' (resumable, like the install ledger).
 */

export interface JobEvent {
  type: "log" | "status" | "done";
  line?: string;
  status?: JobStatus;
  job?: JobRecord;
}

const MAX_LIVE_LOG = 2000;

export class JobEngine {
  private jobs = new Map<string, JobRecord>();
  private subs = new Map<string, Set<(e: JobEvent) => void>>();
  private aborters = new Map<string, AbortController>();
  private queue: string[] = [];
  private running = new Set<string>();
  private lockedKeys = new Set<string>();

  constructor(private deps: Deps, private concurrency = Number(process.env.ADPIX_PANEL_CONCURRENCY) || 2) {
    // boot reconciliation: anything left running/queued from a previous process is interrupted
    for (const j of loadJobs()) {
      if (j.status === "running" || j.status === "queued") j.status = "interrupted";
      this.jobs.set(j.id, j);
    }
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  /** Validate + enqueue. Returns the job, or an error string the caller maps to 4xx. */
  enqueue(tool: ToolDef, rawArgs: Record<string, unknown>, opts: { confirm?: boolean; idempotencyKey?: string; actor?: string } = {}): JobRecord | { error: string } {
    if (tool.annotations?.destructiveHint && opts.confirm !== true) {
      return { error: `${tool.name} is destructive — confirm:true required` };
    }
    const parsed = z.object(tool.schema).safeParse(rawArgs);
    if (!parsed.success) return { error: `invalid args: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
    const args = parsed.data as Record<string, unknown>;

    // idempotency: an in-flight/queued job with the same key returns the existing one (anti double-click)
    if (opts.idempotencyKey) {
      const dup = [...this.jobs.values()].find(
        (j) => j.idempotencyKey === opts.idempotencyKey && (j.status === "queued" || j.status === "running")
      );
      if (dup) return dup;
    }

    const key = String(args.cluster ?? args.server ?? "_global");
    const job: JobRecord = {
      id: randomUUID(),
      tool: tool.name,
      args: redactArgs(args),
      status: "queued",
      key,
      idempotencyKey: opts.idempotencyKey,
      actor: opts.actor,
      createdAt: new Date().toISOString(),
      logTail: [],
    };
    this.jobs.set(job.id, job);
    // run with the VALIDATED (unredacted) args, kept out of the persisted record
    this.queue.push(job.id);
    this.realArgs.set(job.id, { tool, args });
    this.persist();
    this.pump();
    return job;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === "queued") {
      job.status = "canceled";
      job.finishedAt = new Date().toISOString();
      this.queue = this.queue.filter((q) => q !== id);
      this.realArgs.delete(id);
      this.emit(id, { type: "status", status: "canceled" });
      this.persist();
      return true;
    }
    if (job.status === "running") {
      this.aborters.get(id)?.abort();
      return true;
    }
    return false;
  }

  /** Subscribe to a job's live events; immediately replays the buffered log tail. */
  subscribe(id: string, fn: (e: JobEvent) => void): () => void {
    let set = this.subs.get(id);
    if (!set) {
      set = new Set();
      this.subs.set(id, set);
    }
    set.add(fn);
    const job = this.jobs.get(id);
    if (job) {
      for (const line of job.logTail) fn({ type: "log", line });
      if (job.status !== "running" && job.status !== "queued") fn({ type: "done", status: job.status, job });
    }
    return () => {
      this.subs.get(id)?.delete(fn);
    };
  }

  // ---- internals ----
  private realArgs = new Map<string, { tool: ToolDef; args: Record<string, unknown> }>();

  private emit(id: string, e: JobEvent): void {
    if (e.type === "log" && e.line) {
      const job = this.jobs.get(id);
      if (job) {
        job.logTail.push(e.line);
        if (job.logTail.length > MAX_LIVE_LOG) job.logTail.splice(0, job.logTail.length - MAX_LIVE_LOG);
      }
    }
    for (const fn of this.subs.get(id) ?? []) fn(e);
  }

  private persist(): void {
    saveJobs([...this.jobs.values()]);
  }

  private pump(): void {
    while (this.running.size < this.concurrency) {
      const idx = this.queue.findIndex((id) => {
        const job = this.jobs.get(id);
        return job && !this.lockedKeys.has(job.key);
      });
      if (idx === -1) break;
      const id = this.queue.splice(idx, 1)[0];
      void this.run(id);
    }
  }

  private async run(id: string): Promise<void> {
    const job = this.jobs.get(id);
    const work = this.realArgs.get(id);
    if (!job || !work) return;
    this.running.add(id);
    this.lockedKeys.add(job.key);
    const ac = new AbortController();
    this.aborters.set(id, ac);
    job.status = "running";
    job.startedAt = new Date().toISOString();
    this.emit(id, { type: "status", status: "running" });
    this.persist();

    try {
      const obs = observedDeps(this.deps, (line) => this.emit(id, { type: "log", line }), ac.signal);
      const result = await work.tool.handler(obs, work.args);
      job.status = ac.signal.aborted ? "canceled" : "succeeded";
      job.result = result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (ac.signal.aborted || msg === "canceled") {
        job.status = "canceled";
      } else {
        job.status = "failed";
        job.isError = true;
        job.error = `ERROR (${job.tool}): ${msg}`;
        this.emit(id, { type: "log", line: job.error });
      }
    } finally {
      job.finishedAt = new Date().toISOString();
      this.running.delete(id);
      this.lockedKeys.delete(job.key);
      this.aborters.delete(id);
      this.realArgs.delete(id);
      this.emit(id, { type: "done", status: job.status, job });
      this.persist();
      this.pump();
    }
  }
}
