import * as http from "node:http";
import { guard, newToken, SECURITY_HEADERS, isLoopback } from "./guard.js";

/**
 * The web wizard HTTP server. Binds loopback ONLY (refuses non-loopback without explicit
 * TLS), serves a single-page wizard, and routes every /api/* call through the security
 * guard. The session token is delivered in the URL fragment (never logged), short idle +
 * absolute-life timers kill it, and the secrets handler is invoked once then dropped.
 *
 * Reach it through an SSH local-forward (the launcher prints the recipe) — never a public bind.
 */

export interface SshTestRequest {
  host: string;
  port: number;
  username: string;
  bootstrapAuth: "agent" | "password" | "keyfile";
  password?: string;
}

export interface WizardDeps {
  sshTest(req: SshTestRequest): Promise<{ reachable: boolean; fingerprint?: string; detail: string }>;
  finish(body: unknown): Promise<{ verdict: string; dns: string; connect: string; verify: string }>;
}

export interface WizardOpts {
  port?: number;
  host?: string;
  tls?: boolean;
  idleMs?: number;
  maxLifeMs?: number;
  deps: WizardDeps;
}

export interface WizardHandle {
  server: http.Server;
  token: string;
  port: number;
  host: string;
  url(): string;
  tunnelHint(serverIp: string): string;
  close(): void;
}

const HTML = (port: number) => `<!doctype html><html><head><meta charset=utf-8>
<title>AdPix DevOps MCP — setup</title>
<style>body{font:14px system-ui;margin:2rem;max-width:760px}h1{color:#f07b49}input,select{padding:.4rem;margin:.2rem 0;width:100%}button{padding:.5rem 1rem;background:#f07b49;color:#fff;border:0;border-radius:4px;cursor:pointer}pre{background:#111;color:#0f0;padding:1rem;overflow:auto;border-radius:4px}.ok{color:#2a2}.err{color:#c22}</style>
</head><body>
<h1>AdPix DevOps MCP — setup</h1>
<p>This wizard configures the fleet + emits the DNS plan and client configs. It is reachable only over your SSH tunnel to this host.</p>
<div id=app>Loading…</div>
<script>
// token from the URL fragment -> header; scrub the fragment immediately (never logged/Referer).
const TOKEN=(location.hash||'').replace(/^#t=/,'');history.replaceState(null,'',location.pathname);
async function api(path,body){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json','x-adpix-token':TOKEN},body:JSON.stringify(body||{})});return {status:r.status,body:await r.text()};}
document.getElementById('app').innerHTML='<p>Token loaded. Add servers via /api/ssh-test, then POST /api/finish. (Minimal UI — drive the API directly or extend this page.)</p>';
</script>
</body></html>`;

async function readJson(req: http.IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > limit) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("invalid JSON")); } });
    req.on("error", reject);
  });
}

export function serveWizard(opts: WizardOpts): WizardHandle {
  const port = opts.port ?? 8931;
  const host = opts.host ?? "127.0.0.1";
  if (!isLoopback(host) && !opts.tls) {
    throw new Error(`refusing to bind ${host} without TLS — bind 127.0.0.1 and reach it via 'ssh -L ${port}:127.0.0.1:${port}'`);
  }
  const token = newToken();
  const idleMs = opts.idleMs ?? 5 * 60_000;
  const maxLifeMs = opts.maxLifeMs ?? 30 * 60_000;
  let idleTimer: NodeJS.Timeout;
  let closed = false;
  let boundPort = port;

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    clearTimeout(lifeTimer);
    server.close();
  };
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(close, idleMs);
    idleTimer.unref?.();
  };

  const server = http.createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    resetIdle();

    const g = guard({ method: req.method ?? "GET", path: (req.url ?? "/").split("?")[0], headers: req.headers as Record<string, string | undefined> }, token, boundPort);
    if (!g.ok) {
      res.statusCode = g.status;
      res.setHeader("content-type", "text/plain");
      res.end(g.reason);
      return;
    }

    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(HTML(port));
      return;
    }

    if (path === "/api/ssh-test" && req.method === "POST") {
      readJson(req)
        .then((b) => opts.deps.sshTest(b as SshTestRequest))
        .then((r) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(r)); })
        .catch((e) => { res.statusCode = 400; res.end(JSON.stringify({ error: (e as Error).message })); });
      return;
    }
    if (path === "/api/finish" && req.method === "POST") {
      readJson(req)
        .then((b) => opts.deps.finish(b))
        .then((r) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(r)); setTimeout(close, 2_000).unref?.(); })
        .catch((e) => { res.statusCode = 400; res.end(JSON.stringify({ error: (e as Error).message })); });
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  const lifeTimer = setTimeout(close, maxLifeMs);
  lifeTimer.unref?.();
  server.listen(port, host, () => {
    const a = server.address();
    if (a && typeof a === "object") boundPort = a.port;
  });

  return {
    server, token, port: boundPort, host,
    url: () => `http://127.0.0.1:${boundPort}/#t=${token}`,
    tunnelHint: (serverIp: string) => `ssh -N -L ${boundPort}:127.0.0.1:${boundPort} root@${serverIp}`,
    close,
  };
}
