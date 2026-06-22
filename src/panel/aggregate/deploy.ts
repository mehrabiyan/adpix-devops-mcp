import { withSession, type Deps } from "../../deps.js";
import { shq } from "../../util.js";
import { AUTODEPLOY_TIMER, AUTODEPLOY_LOG_DIR } from "../../remote/autodeploy.js";

/**
 * Deploys aggregator — current version, CI/CD timer state, and deploy history for the Deploys
 * screen. Re-runs the cicd_status one-liner but parses its JSON sections (state.json,
 * deploys.jsonl) + git fields directly into typed JSON. Malformed history lines are skipped.
 */
const FS = "\u001f";
export interface DeployHistory { hash: string; subject: string; when: string; result: string }
export interface DeployView {
  timer: { enabled: boolean; next?: string; lastRun?: { result: string; at: string } };
  version: { hash: string; subject: string; behind: number | "?" };
  autoRollback: boolean;
  history: DeployHistory[];
  error?: string;
}

export async function buildDeployView(deps: Deps, server?: string): Promise<DeployView> {
  try {
    return await withSession(deps, server, async (s, srv) => {
      const dir = srv.adpixDir;
      const r = await s.exec([
        `echo ===TIMER; systemctl is-enabled ${AUTODEPLOY_TIMER} 2>/dev/null || echo not-installed; systemctl list-timers ${AUTODEPLOY_TIMER} --no-pager 2>/dev/null | sed -n 2p`,
        `echo ===STATE; cat ${AUTODEPLOY_LOG_DIR}/state.json 2>/dev/null || echo ''`,
        `echo ===GIT; cd ${shq(dir)} 2>/dev/null && git log -1 --format='%h${FS}%s' 2>/dev/null; b=$(git rev-parse --abbrev-ref HEAD 2>/dev/null); echo "behind:$(git rev-list --count HEAD..origin/$b 2>/dev/null || echo '?')"`,
        `echo ===HISTORY; tail -n 12 ${AUTODEPLOY_LOG_DIR}/deploys.jsonl 2>/dev/null || echo ''`,
      ].join("; "), { timeoutMs: 60_000 });

      const sec: Record<string, string> = {}; let cur = "";
      for (const line of r.stdout.split("\n")) { const m = line.match(/^===(\w+)/); if (m) { cur = m[1]; sec[cur] = ""; } else if (cur) sec[cur] += line + "\n"; }

      const timerTxt = (sec.TIMER ?? "").trim();
      const enabled = /(^|\s)enabled\b/.test(timerTxt) && !/not-installed/.test(timerTxt);
      const next = (timerTxt.match(/\b(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\b/) || [])[1];
      let lastRun: DeployView["timer"]["lastRun"];
      try { const st = JSON.parse((sec.STATE ?? "").trim()); if (st && (st.result || st.status)) lastRun = { result: String(st.result ?? st.status), at: String(st.at ?? st.ts ?? st.time ?? "") }; } catch { /* no state yet */ }

      const gitLine = (sec.GIT ?? "").split("\n").find((l) => l.includes(FS)) ?? "";
      const [hash = "?", subject = ""] = gitLine.split(FS);
      const bm = (sec.GIT ?? "").match(/behind:(\S+)/);
      const behind: number | "?" = bm ? (bm[1] === "?" ? "?" : Number(bm[1])) : "?";

      const history: DeployHistory[] = [];
      for (const line of (sec.HISTORY ?? "").trim().split("\n").reverse()) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          history.push({ hash: String(j.commit ?? j.hash ?? j.sha ?? "").slice(0, 7), subject: String(j.subject ?? j.message ?? j.msg ?? ""), when: String(j.ts ?? j.at ?? j.time ?? ""), result: String(j.result ?? j.status ?? (j.ok ? "success" : "")) });
        } catch { /* skip a malformed line */ }
      }

      return { timer: { enabled, next, lastRun }, version: { hash: hash || "?", subject, behind }, autoRollback: true, history };
    });
  } catch (e) {
    return { timer: { enabled: false }, version: { hash: "?", subject: "", behind: "?" }, autoRollback: false, history: [], error: (e as Error).message };
  }
}
