import { resolveServer, type ServerConfig } from "./registry.js";
import { connect, type Session } from "./ssh.js";

/**
 * Dependency seam: tools talk to servers only through `Deps`, so tests swap in
 * a fake session and never touch the network.
 */
export interface Deps {
  resolve(name?: string): ServerConfig;
  connect(server: ServerConfig): Promise<Session>;
}

export const realDeps: Deps = {
  resolve: resolveServer,
  connect,
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
