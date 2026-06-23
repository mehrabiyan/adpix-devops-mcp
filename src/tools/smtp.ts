import { z } from "zod";
import { withSession } from "../deps.js";
import { shq } from "../util.js";
import type { ToolDef } from "./types.js";

/**
 * Standalone SMTP validator. AdPix stores its real mail config in the database (smtp_* columns,
 * password AES-encrypted with SMTP_ENC_KEY) and sets it via the app's admin settings — this tool
 * does NOT write that. It tests an SMTP server end-to-end FROM the target host (so it exercises the
 * same egress path the app uses): DNS → TCP connect → TLS/STARTTLS → AUTH → optional test send.
 * Use it to prove credentials work before entering them in the app, and to diagnose delivery.
 */

// python3 smtplib diagnostic — reads everything from env (so the password never lands in argv),
// prints ONE JSON line {steps:[{step,ok,detail}]}. Quoted heredoc → no shell/JS interpolation.
const PY = `import smtplib, ssl, socket, json, os, sys
H=os.environ; host=H['SH']; port=int(H['SP']); user=H.get('SU',''); pw=H.get('SPW','')
frm=H['SF']; to=H.get('STO',''); sec=H.get('SEC','starttls')
steps=[]
def add(n,ok,d): steps.append({'step':n,'ok':bool(ok),'detail':str(d)})
def done(): print(json.dumps({'steps':steps})); sys.exit(0)
try:
    ip=socket.gethostbyname(host); add('DNS resolve', True, host+' -> '+ip)
except Exception as e:
    add('DNS resolve', False, e); done()
srv=None
try:
    if sec=='tls':
        srv=smtplib.SMTP_SSL(host, port, timeout=15, context=ssl.create_default_context()); srv.ehlo()
        add('TLS connect', True, 'SMTPS on port '+str(port))
    else:
        srv=smtplib.SMTP(host, port, timeout=15); srv.ehlo()
        if sec=='starttls':
            srv.starttls(context=ssl.create_default_context()); srv.ehlo(); add('STARTTLS', True, 'connection upgraded to TLS')
        else:
            add('Connect (plaintext)', True, 'port '+str(port)+' — no encryption')
except Exception as e:
    add('Connect / TLS', False, e); done()
if user:
    try:
        srv.login(user, pw); add('Authenticate', True, 'login accepted for '+user)
    except Exception as e:
        add('Authenticate', False, e)
        try: srv.quit()
        except Exception: pass
        done()
else:
    add('Authenticate', True, 'skipped (no username — open relay)')
if to:
    try:
        msg='From: '+frm+'\\r\\nTo: '+to+'\\r\\nSubject: AdPix SMTP test\\r\\n\\r\\nThis is a test message from the AdPix DevOps control plane. If you received it, outbound email works.'
        srv.sendmail(frm, [to], msg); add('Send test email', True, 'accepted for delivery to '+to)
    except Exception as e:
        add('Send test email', False, e)
try: srv.quit()
except Exception: pass
done()`;

export const smtpTools: ToolDef[] = [
  {
    name: "smtp_test",
    title: "Test an SMTP server",
    description:
      "Diagnose an SMTP server end-to-end FROM a target host: DNS resolution, TCP connect, TLS/STARTTLS, " +
      "authentication, and (optionally) a real test email. Use it to verify credentials + outbound mail before " +
      "entering them in the AdPix admin email settings (which the app stores DB-encrypted). The password is passed " +
      "via env, never argv, and redacted from output.",
    schema: {
      server: z.string().optional().describe("Run the test from this registered server (its egress path). Omit for the default."),
      host: z.string().describe("SMTP server hostname, e.g. smtp.sendgrid.net"),
      port: z.number().int().min(1).max(65535).default(587),
      security: z.enum(["starttls", "tls", "none"]).default("starttls").describe("starttls (587), tls/SMTPS (465), or none (25, unencrypted)"),
      username: z.string().optional().describe("SMTP username (omit for an open relay)"),
      password: z.string().optional().describe("SMTP password / API key (sent via env, never persisted)"),
      from: z.string().describe("Envelope From address, e.g. no-reply@yourdomain.com"),
      to: z.string().optional().describe("Recipient for a real test email. Omit to stop after the auth check."),
    },
    annotations: { openWorldHint: true },
    handler: async (deps, args) => {
      const a = args as { server?: string; host: string; port: number; security: string; username?: string; password?: string; from: string; to?: string };
      return withSession(deps, a.server, async (s, srv) => {
        if ((await s.exec("command -v python3 >/dev/null && echo ok || echo no")).stdout.trim() !== "ok") {
          return `python3 is not available on ${srv.name} — install it (apt-get install -y python3) to run the SMTP diagnostic.`;
        }
        const env =
          `SH=${shq(a.host)} SP=${shq(String(a.port))} SEC=${shq(a.security)} SF=${shq(a.from)}` +
          (a.username ? ` SU=${shq(a.username)}` : "") +
          (a.password ? ` SPW=${shq(a.password)}` : "") +
          (a.to ? ` STO=${shq(a.to)}` : "");
        const r = await s.exec(`${env} python3 - <<'ADPIXSMTP'\n${PY}\nADPIXSMTP`, { timeoutMs: 60_000 });
        const line = r.stdout.split("\n").reverse().find((l) => l.trim().startsWith("{"));
        if (!line) return `SMTP test could not run on ${srv.name}:\n${(r.stderr || r.stdout).slice(0, 600) || "(no output)"}`;
        let steps: { step: string; ok: boolean; detail: string }[];
        try { steps = JSON.parse(line).steps; } catch { return `Unexpected diagnostic output:\n${line.slice(0, 600)}`; }
        const failed = steps.find((x) => !x.ok);
        const body = steps.map((x) => `${x.ok ? "✓" : "✗"} ${x.step} — ${x.detail}`).join("\n");
        const verdict = failed
          ? `FAIL at "${failed.step}". ${a.to ? "Email was NOT sent." : ""}`
          : a.to ? "PASS — test email accepted for delivery." : "PASS — connect + auth OK (no test send requested).";
        return `# SMTP test → ${a.host}:${a.port} (${a.security}) from ${srv.name}\n${body}\n\n${verdict}`;
      });
    },
  },
];
