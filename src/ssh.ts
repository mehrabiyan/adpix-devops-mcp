import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
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
  /** Stream a LOCAL file (on the MCP host) to the target over SFTP — for large artifacts (offline
   *  bundles, image tarballs) that base64-in-exec can't carry. Creates the remote dir + chmods. */
  putFile?(localPath: string, remotePath: string, mode?: string): Promise<void>;
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

// ─── connection pool ────────────────────────────────────────────────────────────────────────────
// connect() used to open a fresh SSH connection (TCP + handshake + auth, ~1–3s) on EVERY call. The
// panel fires many sequential calls per server, so each one paid that cost. We now reuse one live
// ssh2 client per server (ssh2 multiplexes many exec channels over one connection); close() releases
// it to the pool, idle connections are evicted after a TTL, and a broken/timed-out one is dropped so
// the next connect() reconnects. Password connects are NOT pooled (one-shot, per the secret convention).
interface Pooled { client: Client; key: string; server: ServerConfig; authMethod: Session["authMethod"]; refs: number; idle?: ReturnType<typeof setTimeout>; broken: boolean }
const POOL = new Map<string, Pooled>();
const POOL_IDLE_MS = 120_000;

function evictPooled(p: Pooled): void {
  if (p.idle) { clearTimeout(p.idle); p.idle = undefined; }
  if (POOL.get(p.key) === p) POOL.delete(p.key);
  if (!p.broken) { p.broken = true; try { p.client.end(); } catch { /* already gone */ } }
}
function releasePooled(p: Pooled): void {
  p.refs = Math.max(0, p.refs - 1);
  if (p.refs === 0 && !p.broken) {
    if (p.idle) clearTimeout(p.idle);
    p.idle = setTimeout(() => { if (p.refs === 0) evictPooled(p); }, POOL_IDLE_MS);
    if (typeof p.idle.unref === "function") p.idle.unref(); // don't keep the process alive
  }
}
/** End every pooled connection — clean shutdown / between tests. */
export function closeAllSessions(): void { for (const p of [...POOL.values()]) evictPooled(p); }

function makeSession(pooled: Pooled): Session {
  const { server } = pooled;
  let released = false;
  const close = (): void => {
    if (released) return;
    released = true;
    if (POOL.get(pooled.key) === pooled) releasePooled(pooled); // pooled → return for reuse
    else if (!pooled.broken) { try { pooled.client.end(); } catch { /* */ } } // one-shot (password) → end
  };

  const exec = (cmd: string, opts: ExecOpts = {}): Promise<ExecResult> => {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const sudo = opts.sudo ?? true;
    const wrapped =
      server.username !== "root" && sudo ? `sudo -n bash -c ${shq(cmd)}` : `bash -c ${shq(cmd)}`;

    return new Promise<ExecResult>((resolve, reject) => {
      pooled.client.exec(wrapped, (err, stream) => {
        if (err) { evictPooled(pooled); return reject(new Error(`exec failed on ${server.name}: ${err.message}`)); }
        let stdout = "";
        let stderr = "";
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          // A stuck remote command holds the channel — drop the connection (and evict from the pool).
          evictPooled(pooled);
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

  const putFile = async (localPath: string, remotePath: string, mode = "644"): Promise<void> => {
    await exec(`mkdir -p $(dirname ${shq(remotePath)})`, { timeoutMs: 30_000 });
    await new Promise<void>((resolve, reject) => {
      pooled.client.sftp((err, sftp) => {
        if (err) return reject(new Error(`sftp open failed on ${server.name}: ${err.message}`));
        sftp.fastPut(localPath, remotePath, (e) => { sftp.end(); if (e) return reject(new Error(`upload to ${server.name}:${remotePath} failed: ${e.message}`)); resolve(); });
      });
    });
    await exec(`chmod ${mode} ${shq(remotePath)}`, { timeoutMs: 30_000 });
  };

  return { server, authMethod: pooled.authMethod, exec, close, putFile };
}

export async function connect(server: ServerConfig, opts: ConnectOpts = {}): Promise<Session> {
  const auth = buildAuth(server, opts);
  const poolable = auth.method !== "password"; // never reuse a password connection
  const key = `${server.username}@${server.host}:${server.port}|${opts.privateKeyPathOverride ?? server.privateKeyPath ?? auth.method}|${opts.strictHostKey ? "strict" : "tofu"}`;
  if (poolable) {
    const hit = POOL.get(key);
    if (hit && !hit.broken) {
      if (hit.idle) { clearTimeout(hit.idle); hit.idle = undefined; }
      hit.refs++;
      return makeSession(hit);
    }
  }

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

  const pooled: Pooled = { client: conn, key, server, authMethod: auth.method, refs: 1, broken: false };
  // A dropped/errored connection must leave the pool so the next connect() makes a fresh one.
  conn.on("error", () => { pooled.broken = true; if (POOL.get(key) === pooled) POOL.delete(key); });
  conn.on("close", () => { pooled.broken = true; if (POOL.get(key) === pooled) POOL.delete(key); });
  if (poolable) POOL.set(key, pooled);
  return makeSession(pooled);
}

// ─── reverse-proxy tunnel (give an intranet-only target the MCP host's internet) ──────────────────
// The MCP holds a dedicated SSH connection to the target and remote-forwards a localhost port on the
// TARGET back to an inline HTTP/CONNECT proxy here — so the target's apt/docker/git, pointed at
// http://127.0.0.1:<port>, egress through the MCP host. net_bridge sets the proxy config + tears down.
interface Tunnel { client: Client; proxyPort: number; server: ServerConfig; close: () => void }
const TUNNELS = new Map<string, Tunnel>();
export function activeTunnel(name: string): { proxyPort: number } | null { const t = TUNNELS.get(name); return t ? { proxyPort: t.proxyPort } : null; }
export function closeTunnel(name: string): boolean { const t = TUNNELS.get(name); if (!t) return false; t.close(); return true; }

/** Handle one forwarded connection from the target as an HTTP forward proxy (CONNECT for https, absolute-form for http). */
function handleProxyChannel(ch: NodeJS.ReadWriteStream): void {
  let buf = Buffer.alloc(0); let wired = false;
  const fail = (code: string) => { try { ch.end(`HTTP/1.1 ${code}\r\n\r\n`); } catch { /* */ } };
  const onData = (d: Buffer) => {
    if (wired) return;
    buf = Buffer.concat([buf, d]);
    const i = buf.indexOf("\r\n\r\n");
    if (i === -1) { if (buf.length > 32_768) fail("400 Bad Request"); return; }
    (ch as NodeJS.EventEmitter).removeListener("data", onData);
    const head = buf.slice(0, i).toString("utf8");
    const [reqLine, ...headerLines] = head.split("\r\n");
    const m = reqLine.match(/^(\S+)\s+(\S+)\s+HTTP/);
    if (!m) return fail("400 Bad Request");
    const [, method, target] = m;
    if (method.toUpperCase() === "CONNECT") {
      const [host, port] = target.split(":");
      const sock = net.connect(parseInt(port || "443", 10), host, () => { ch.write("HTTP/1.1 200 Connection Established\r\n\r\n"); wired = true; (ch as NodeJS.ReadableStream).pipe(sock); sock.pipe(ch as NodeJS.WritableStream); });
      sock.on("error", () => fail("502 Bad Gateway"));
    } else {
      let u: URL; try { u = new URL(target); } catch { return fail("400 Bad Request"); }
      const sock = net.connect(parseInt(u.port || "80", 10), u.hostname, () => {
        const origin = (u.pathname || "/") + (u.search || "");
        sock.write(`${method} ${origin} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`);
        if (buf.length > i + 4) sock.write(buf.slice(i + 4));
        wired = true; (ch as NodeJS.ReadableStream).pipe(sock); sock.pipe(ch as NodeJS.WritableStream);
      });
      sock.on("error", () => fail("502 Bad Gateway"));
    }
  };
  (ch as NodeJS.EventEmitter).on("data", onData);
  (ch as NodeJS.EventEmitter).on("error", () => { /* channel closed */ });
}

/** Open (or reuse) a reverse-proxy tunnel to `server`. Returns the target-localhost port apt/docker/git point at. */
export async function openReverseProxy(server: ServerConfig, opts: ConnectOpts = {}): Promise<{ proxyPort: number }> {
  const existing = TUNNELS.get(server.name);
  if (existing) return { proxyPort: existing.proxyPort };
  const auth = buildAuth(server, opts);
  const conn = new Client();
  const hk: { value?: HostKeyOutcome } = {};
  await new Promise<void>((resolve, reject) => {
    conn.once("ready", () => resolve())
      .once("error", (err) => reject(new Error(`tunnel SSH connect to ${server.username}@${server.host}:${server.port} failed: ${err.message}`)))
      .connect({ host: server.host, port: server.port, username: server.username, readyTimeout: 20_000, keepaliveInterval: 10_000, keepaliveCountMax: 12, hostVerifier: makeHostVerifier(server.host, server.port, opts.strictHostKey ? {} : { tofu: false }, hk), ...auth.config });
  });
  const proxyPort = await new Promise<number>((resolve, reject) => {
    conn.forwardIn("127.0.0.1", 0, (err, port) => (err ? reject(new Error(`remote port-forward refused on ${server.name} (sshd AllowTcpForwarding?): ${err.message}`)) : resolve(port)));
  });
  conn.on("tcp connection", (_info, accept) => { try { handleProxyChannel(accept()); } catch { /* */ } });
  const t: Tunnel = { client: conn, proxyPort, server, close: () => { TUNNELS.delete(server.name); try { conn.end(); } catch { /* */ } } };
  conn.on("close", () => TUNNELS.delete(server.name));
  TUNNELS.set(server.name, t);
  return { proxyPort };
}
