import type { Deps } from "../deps.js";
import type { InstallAnswers, SecretsBag } from "./answers.js";
import { type InstallJournal, setStep, saveJournal } from "./journal.js";

/**
 * The reconcile engine. An install is an ordered list of idempotent steps, each with a
 * detect→apply→verify shape. The engine skips already-satisfied steps (unless forced),
 * journals every outcome before declaring success (so a partial run resumes exactly),
 * aborts on a hard failure, and continues past a soft (per-target) failure.
 */

export interface InstallContext {
  answers: InstallAnswers;
  secrets: SecretsBag;
  deps: Deps;
  journal: InstallJournal;
  log: (msg: string) => void;
  force: boolean;
  /** Scratch shared between steps within a run (pubkey, token, host IP). Not persisted, never secrets beyond the in-memory run. */
  runtime: Record<string, string>;
}

export interface StepResult {
  ok: boolean;
  detail: string;
  /** soft = a non-fatal (e.g. per-target) failure: report it but keep going. */
  soft?: boolean;
}

export interface InstallStep {
  id: string;
  title: string;
  isDone(ctx: InstallContext): Promise<boolean>;
  apply(ctx: InstallContext): Promise<StepResult>;
  verify(ctx: InstallContext): Promise<StepResult>;
}

export async function runStep(step: InstallStep, ctx: InstallContext): Promise<StepResult> {
  if (!ctx.force) {
    try {
      if (await step.isDone(ctx)) {
        setStep(ctx.journal, step.id, "done", "already satisfied");
        return { ok: true, detail: "already satisfied" };
      }
    } catch {
      /* a failing isDone probe just means "not known done" — fall through to apply */
    }
  }
  const a = await step.apply(ctx).catch((e) => ({ ok: false, detail: `apply threw: ${(e as Error).message}` }) as StepResult);
  if (!a.ok) {
    setStep(ctx.journal, step.id, "failed", a.detail);
    return a;
  }
  const v = await step.verify(ctx).catch((e) => ({ ok: false, detail: `verify threw: ${(e as Error).message}` }) as StepResult);
  setStep(ctx.journal, step.id, v.ok ? "done" : "failed", v.detail);
  return { ...v, soft: a.soft || v.soft };
}

export interface PlanOutcome {
  results: { id: string; result: StepResult }[];
  aborted: boolean;
}

export async function runPlan(steps: InstallStep[], ctx: InstallContext, persist = true): Promise<PlanOutcome> {
  const results: { id: string; result: StepResult }[] = [];
  for (const step of steps) {
    ctx.log(`▶ ${step.title}`);
    const result = await runStep(step, ctx);
    results.push({ id: step.id, result });
    if (persist) saveJournal(ctx.journal);
    ctx.log(`${result.ok ? "✓" : "✗"} ${step.title} — ${result.detail}`);
    if (!result.ok && !result.soft) return { results, aborted: true };
  }
  return { results, aborted: false };
}

/** Dry-run: report each step's detect (done vs would-apply) without mutating anything. */
export async function planDryRun(steps: InstallStep[], ctx: InstallContext): Promise<{ id: string; title: string; done: boolean }[]> {
  const out: { id: string; title: string; done: boolean }[] = [];
  for (const step of steps) {
    let done = false;
    try {
      done = await step.isDone(ctx);
    } catch {
      done = false;
    }
    out.push({ id: step.id, title: step.title, done });
  }
  return out;
}
