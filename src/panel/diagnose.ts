import type { Deps } from "../deps.js";
import { loadHostPins } from "../knownhosts.js";
import { classifyError } from "./errors.js";

/**
 * Pre-add connectivity diagnosis: run a full checklist against a (usually not-yet-registered)
 * host using key OR root password — SSH auth, host-key fingerprint, identity, root/sudo, OS,
 * Docker, disk — so the operator sees exactly why a server will/won't work before it is added.
 * The password is transient (never stored). Every step is exception-guarded.
 */
export interface Check { name: string; ok: boolean; detail: string; soft: boolean }
export interface Diagnosis { reachable: boolean; fingerprint: string; checks: Check[]; summary: string; canAdd: boolean }

export interface DiagnoseParams { host: string; port?: number; username?: string; password?: string; privateKeyPath?: string }

export async function diagnoseServer(deps: Deps, p: DiagnoseParams): Promise<Diagnosis> {
  const srv = { name: p.host, host: p.host, port: p.port ?? 22, username: p.username || "root", adpixDir: "/opt/adpix" };
  const opts = p.password ? { password: p.password } : p.privateKeyPath ? { privateKeyPathOverride: p.privateKeyPath } : {};
  const checks: Check[] = [];
  let session;
  try {
    session = await deps.connect(srv, opts);
  } catch (e) {
    const c = classifyError(e);
    return { reachable: false, fingerprint: "", checks: [{ name: "SSH connection", ok: false, detail: c.message, soft: false }], summary: c.message, canAdd: false };
  }
  try {
    checks.push({ name: "SSH connection", ok: true, detail: `connected as ${srv.username}@${srv.host}:${srv.port}`, soft: false });
    const fp = loadHostPins()[`${srv.host}:${srv.port}`] ?? "pinned on first connect";
    checks.push({ name: "Host key", ok: true, detail: fp, soft: false });

    const safe = async (cmd: string, ms = 8000): Promise<string> => {
      try { return (await session!.exec(cmd, { timeoutMs: ms })).stdout.trim(); } catch (e) { return "ERR:" + classifyError(e).message; }
    };
    const who = await safe("id -un 2>/dev/null; echo '==='; sudo -n true 2>/dev/null && echo SUDO_OK || echo NO_SUDO");
    const user = who.split("===")[0].trim();
    const root = user === "root" || /SUDO_OK/.test(who);
    checks.push({ name: "Privilege", ok: root, detail: root ? (user === "root" ? "root access" : "passwordless sudo ok") : `user "${user}" lacks root / NOPASSWD sudo — grant it or use root`, soft: false });

    const os = await safe(". /etc/os-release 2>/dev/null; echo $PRETTY_NAME");
    checks.push({ name: "Operating system", ok: !!os && !os.startsWith("ERR:"), detail: os || "unknown", soft: true });

    const docker = await safe("docker --version 2>/dev/null || echo NONE");
    const hasDocker = !/NONE|ERR:/.test(docker);
    checks.push({ name: "Docker", ok: hasDocker, detail: hasDocker ? docker : "not installed (the installer can add it)", soft: true });

    const disk = await safe("df -h / | awk 'END{print $4\" free, \"$5\" used\"}'");
    const usedPct = parseInt((disk.match(/(\d+)% used/) || [])[1] || "0", 10);
    checks.push({ name: "Disk space", ok: usedPct < 90, detail: disk || "unknown", soft: true });

    const hardFail = checks.some((c) => !c.ok && !c.soft);
    const fingerprint = loadHostPins()[`${srv.host}:${srv.port}`] ?? "pinned on first connect";
    return { reachable: true, fingerprint, checks, summary: hardFail ? "Reachable, but a required check failed." : "Reachable and ready to add.", canAdd: !hardFail };
  } catch (e) {
    return { reachable: true, fingerprint: "", checks: [...checks, { name: "Diagnostics", ok: false, detail: classifyError(e).message, soft: false }], summary: "Diagnostics error.", canAdd: false };
  } finally {
    try { session.close(); } catch { /* ignore */ }
  }
}
