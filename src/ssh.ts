import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client, type ConnectConfig } from "ssh2";
import type { ServerConfig } from "./registry.js";
import { shq } from "./util.js";
import { makeHostVerifier, hostKeyError, type HostKeyOutcome } from "./knownhosts.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOpts {
  /** Kill + fail the call after this long. Default 120s. */
  timeoutMs?: number;
  /** Wrap with `sudo -n` when the SSH user is not root. Default true. */
  sudo?: boolean;
}

export interface Session {
  readonly server: ServerConfig;
  readonly authMethod: "publickey" | "agent" | "password";
  exec(cmd: string, opts?: ExecOpts): Promise<ExecResult>;
  close(): void;
}

const MAX_CAPTURE = 2 * 1024 * 1024; // 2 MiB per stream — plenty for build logs we tail anyway.

function expandHome(p: string): string {
  return p.startsWith("~/") || p === "~" ? path.join(os.homedir(), p.slice(1)) : p;
}

function defaultKeyPaths(): string[] {
  const ssh = path.join(os.homedir(), ".ssh");
  return ["id_ed25519", "id_rsa", "id_ecdsa"].map((f) => path.join(ssh, f));
}

interface Auth {
  method: Session["authMethod"];
  config: Partial<ConnectConfig>;
}

function buildAuth(server: ServerConfig, opts: ConnectOpts = {}): Auth {
  const passphrase = process.env.ADPIX_SSH_PASSPHRASE;
  // explicit overrides (ad-hoc connect for diagnosis / bootstrap) take precedence over the
  // persisted config + agent/default keys, so a password connect is never silently replaced
  // by the operator's own SSH key.
  if (opts.password) {
    return { method: "password", config: { password: opts.password } };
  }
  const keyPath = opts.privateKeyPathOverride ?? server.privateKeyPath;
  if (keyPath) {
    const p = expandHome(keyPath);
    if (!fs.existsSync(p)) {
      throw new Error(`Private key not found at ${p} (server "${server.name}").`);
    }
    return { method: "publickey", config: { privateKey: fs.readFileSync(p), passphrase } };
  }
  if (process.env.SSH_AUTH_SOCK) {
    return { method: "agent", config: { agent: process.env.SSH_AUTH_SOCK } };
  }
  for (const p of defaultKeyPaths()) {
    if (fs.existsSync(p)) {
      return { method: "publickey", config: { privateKey: fs.readFileSync(p), passphrase } };
    }
  }
  if (process.env.ADPIX_SSH_PASSWORD) {
    return { method: "password", config: { password: process.env.ADPIX_SSH_PASSWORD } };
  }
  throw new Error(
    `No SSH credentials for "${server.name}": set privateKeyPath on the server entry, ` +
      `run an ssh-agent, keep a key at ~/.ssh/id_ed25519, or set ADPIX_SSH_PASSWORD.`
  );
}

/** Per-connection host-key strictness + ad-hoc auth overrides (diagnosis / password bootstrap). */
export interface ConnectOpts {
  strictHostKey?: boolean;
  /** Ad-hoc password auth (never persisted) — forces password method, bypassing keys/agent. */
  password?: string;
  /** Ad-hoc private-key path (e.g. the MCP key) — overrides the server's stored path. */
  privateKeyPathOverride?: string;
}

export async function connect(server: ServerConfig, opts: ConnectOpts = {}): Promise<Session> {
  const auth = buildAuth(server, opts);
  const conn = new Client();
  // Host-key verification: TOFU-pin by default, strict on demand. Before this the MCP
  // verified NOTHING and accepted any host key — MITM-able.
  const hk: { value?: HostKeyOutcome } = {};
  const tofu = opts.strictHostKey ? false : undefined;

  await new Promise<void>((resolve, reject) => {
    conn
      .once("ready", () => resolve())
      .once("error", (err) => {
        const o = hk.value;
        if (o && (o.status === "mismatch" || o.status === "unpinned-strict")) {
          return reject(new Error(hostKeyError(server.host, server.port, o)));
        }
        reject(new Error(`SSH connect to ${server.username}@${server.host}:${server.port} failed: ${err.message}`));
      })
      .connect({
        host: server.host,
        port: server.port,
        username: server.username,
        readyTimeout: 20_000,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 12,
        hostVerifier: makeHostVerifier(server.host, server.port, tofu === false ? { tofu: false } : {}, hk),
        ...auth.config,
      });
  });

  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      conn.end();
    }
  };

  const exec = (cmd: string, opts: ExecOpts = {}): Promise<ExecResult> => {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const sudo = opts.sudo ?? true;
    // Run through bash for a consistent shell; non-root users get `sudo -n`
    // (passwordless sudo is a documented requirement for non-root accounts).
    const wrapped =
      server.username !== "root" && sudo ? `sudo -n bash -c ${shq(cmd)}` : `bash -c ${shq(cmd)}`;

    return new Promise<ExecResult>((resolve, reject) => {
      conn.exec(wrapped, (err, stream) => {
        if (err) return reject(new Error(`exec failed on ${server.name}: ${err.message}`));
        let stdout = "";
        let stderr = "";
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          // A stuck remote command holds the channel — drop the connection.
          conn.end();
          closed = true;
          reject(
            new Error(
              `Command timed out after ${Math.round(timeoutMs / 1000)}s on ${server.name}.\n` +
                `Partial stdout:\n${stdout.slice(-2000)}\nPartial stderr:\n${stderr.slice(-2000)}`
            )
          );
        }, timeoutMs);

        stream.on("data", (d: Buffer) => {
          if (stdout.length < MAX_CAPTURE) stdout += d.toString("utf8");
        });
        stream.stderr.on("data", (d: Buffer) => {
          if (stderr.length < MAX_CAPTURE) stderr += d.toString("utf8");
        });
        stream.on("close", (code: number | null) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (server.username !== "root" && sudo && code === 1 && /sudo: a password is required/.test(stderr)) {
            return reject(
              new Error(
                `sudo on ${server.name} requires a password. Use a root SSH user or grant ` +
                  `${server.username} passwordless sudo (NOPASSWD) for this tool to manage the server.`
              )
            );
          }
          resolve({ code: code ?? -1, stdout, stderr });
        });
      });
    });
  };

  return { server, authMethod: auth.method, exec, close };
}
