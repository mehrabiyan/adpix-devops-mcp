import type { Deps } from "../deps.js";
import type { ExecResult } from "../ssh.js";
import { redactSecrets, lastLines } from "../util.js";

/**
 * Wrap a real Deps so every exec/local emits a REDACTED log line to a sink before delegating,
 * and aborts cleanly when the job is canceled. Because all SSH/local traffic funnels through
 * the Deps seam, this gives live progress + cooperative cancellation for ALL tools with zero
 * per-tool changes. The handler still returns its single string; the engine streams the rest.
 */
export function observedDeps(real: Deps, onLog: (line: string) => void, signal: AbortSignal): Deps {
  const wrap = (target: string, exec: (cmd: string, opts?: { timeoutMs?: number }) => Promise<ExecResult>) => {
    return async (cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult> => {
      if (signal.aborted) throw new Error("canceled");
      onLog(`$ [${target}] ${redactSecrets(cmd).split("\n")[0].slice(0, 400)}`);
      const r = await exec(cmd, opts);
      const out = [r.stdout, r.stderr].filter(Boolean).join("\n");
      const tail = lastLines(redactSecrets(out), 6).trim();
      if (tail) onLog(tail);
      if (signal.aborted) throw new Error("canceled");
      return r;
    };
  };
  return {
    resolve: real.resolve,
    local: wrap("local", real.local),
    connect: async (srv) => {
      const s = await real.connect(srv);
      return { ...s, exec: wrap(srv.name ?? srv.host, s.exec.bind(s)) };
    },
  };
}
