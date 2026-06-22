import { execFile } from "node:child_process";
import { resolveServer, type ServerConfig } from "./registry.js";
import { connect, type ConnectOpts, type ExecResult, type Session } from "./ssh.js";

/**
 * Dependency seam: tools talk to servers only through `Deps`, so tests swap in
 * a fake session and never touch the network. `local` runs on the machine
 * hosting THIS MCP process (used by mcp_self_update). connect() accepts optional
 * ConnectOpts for ad-hoc auth (password/key overrides during diagnosis/bootstrap).
 */
export interface Deps {
  resolve(name?: string): ServerConfig;
  connect(server: ServerConfig, opts?: ConnectOpts): Promise<Session>;
  local(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
}

function localExec(cmd: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-c", cmd],
      { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number"
          ? ((err as unknown as { code: number }).code)
          : err
            ? 1
            : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    );
  });
}

export const realDeps: Deps = {
  resolve: resolveServer,
  connect,
  local: localExec,
};

/** Open a session for one tool invocation, always closing it afterwards. */
export async function withSession<T>(
  deps: Deps,
  serverName: string | undefined,
  fn: (s: Session, srv: ServerConfig) => Promise<T>
): Promise<T> {
  const srv = deps.resolve(serverName);
  const session = await deps.connect(srv);
  try {
    return await fn(session, srv);
  } finally {
    session.close();
  }
}
