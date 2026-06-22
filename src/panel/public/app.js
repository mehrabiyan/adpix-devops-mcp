// AdPix Cloud — control panel SPA. Faithful implementation of the AdPix Cloud design over the
// panel API: topbar (logo, cluster switcher, ⌘K palette), pill sidebar, 11 bespoke screens,
// dark/light, EN/FA + RTL, live jobs drawer (SSE), destructive preview→nonce, login + TOTP.

// ============================================================ token + api
const TOKEN = (location.hash.match(/token=([a-f0-9]+)/) || [])[1] || sessionStorage.getItem("adpix_token") || "";
if (TOKEN) sessionStorage.setItem("adpix_token", TOKEN);
history.replaceState(null, "", location.pathname);

function authHeaders(mut) {
  if (S.mode === "session") return mut ? { "x-adpix-csrf": S.csrf } : {};
  return TOKEN ? { "x-adpix-token": TOKEN } : {};
}
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, credentials: "same-origin", headers: { ...(opts.body ? { "content-type": "application/json" } : {}), ...authHeaders(!!opts.body), ...(opts.headers || {}) } });
  if (!res.ok && res.status !== 202) { let m = res.statusText; try { m = (await res.json()).error || m; } catch {} const e = new Error(m); e.status = res.status; throw e; }
  return res.status === 204 ? null : res.json();
}
const runTool = (name, args = {}) => api(`/api/tools/${name}`, { method: "POST", body: JSON.stringify({ args }) });
const startJob = (tool, args = {}) => api("/api/jobs", { method: "POST", body: JSON.stringify({ tool, args, idempotencyKey: `${tool}:${Date.now()}` }) });
async function startDestructive(tool, args = {}) {
  const pv = await api("/api/preview", { method: "POST", body: JSON.stringify({ tool, args }) });
  return api("/api/jobs", { method: "POST", body: JSON.stringify({ tool, args, nonce: pv.nonce, idempotencyKey: `${tool}:${Date.now()}` }) });
}
const listJobs = () => api("/api/jobs");
const cancelJob = (id) => api(`/api/jobs/${id}/cancel`, { method: "POST", body: "{}" });
async function streamJob(id, onEvent, signal) {
  const res = await fetch(`/api/jobs/${id}/stream`, { headers: { "x-adpix-token": TOKEN }, credentials: "same-origin", signal });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf("\n\n")) !== -1) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const line = chunk.split("\n").find((l) => l.startsWith("data: ")); if (line) { try { onEvent(JSON.parse(line.slice(6))); } catch {} } } }
}

// ============================================================ i18n
const STR = {
  en: { nav: { dashboard: "Dashboard", servers: "Servers", ha: "High availability", databases: "Databases", backups: "Backups", deploys: "Deploys", dns: "DNS & connect", monitoring: "Monitoring", jobs: "Jobs & audit", security: "Security", settings: "Settings" },
    grp: { overview: "Overview", fleet: "Fleet", data: "Data", delivery: "Delivery", observe: "Observe", govern: "Govern" },
    run: "Run", refresh: "Refresh", cancel: "Cancel", confirm: "Confirm", close: "Close", activity: "Activity", collapse: "Collapse",
    fleetOverview: "Fleet overview", backupAll: "Backup all", deploy: "Deploy", addServer: "Add server", search: "Search servers, screens, actions…",
    recentJobs: "Recent jobs", activeAlerts: "Active alerts", viewAll: "View all", nodeHealth: "Node health", clusterTopology: "Cluster topology",
    quorumHealthy: "Quorum healthy", noJobs: "No active jobs. Everything is idle.", containers: "Containers", logs: "Logs", follow: "Follow",
    typeToConfirm: "This is irreversible. Type the target name to confirm:", destructive: "Destructive action", soon: "Soon" },
  fa: { nav: { dashboard: "داشبورد", servers: "سرورها", ha: "دسترس‌پذیری بالا", databases: "پایگاه‌داده", backups: "پشتیبان‌گیری", deploys: "استقرار", dns: "DNS و اتصال", monitoring: "پایش", jobs: "کارها و ممیزی", security: "امنیت", settings: "تنظیمات" },
    grp: { overview: "نمای کلی", fleet: "فلیت", data: "داده", delivery: "تحویل", observe: "مشاهده", govern: "حاکمیت" },
    run: "اجرا", refresh: "تازه‌سازی", cancel: "لغو", confirm: "تأیید", close: "بستن", activity: "فعالیت", collapse: "جمع کردن",
    fleetOverview: "نمای کلی فلیت", backupAll: "پشتیبان‌گیری همه", deploy: "استقرار", addServer: "افزودن سرور", search: "جستجوی سرور، صفحه، عملیات…",
    recentJobs: "کارهای اخیر", activeAlerts: "هشدارهای فعال", viewAll: "مشاهده همه", nodeHealth: "سلامت گره‌ها", clusterTopology: "توپولوژی خوشه",
    quorumHealthy: "حد نصاب سالم", noJobs: "کار فعالی نیست.", containers: "کانتینرها", logs: "لاگ‌ها", follow: "دنبال‌کردن",
    typeToConfirm: "این عمل بازگشت‌ناپذیر است. نام هدف را بنویسید:", destructive: "عملیات مخرب", soon: "به‌زودی" },
};
const t = (k) => STR[S.lang][k] ?? k;

// ============================================================ icons
const IP = {
  dashboard: "M12 13a2 2 0 100-4 2 2 0 000 4zM12 4a8 8 0 108 8M12 11l4-3",
  servers: "M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01", ha: "M6 9a3 3 0 100-6 3 3 0 000 6zm12 0a3 3 0 100-6 3 3 0 000 6zM12 21a3 3 0 100-6 3 3 0 000 6zM7.5 7.5l3 6m6-6l-3 6",
  databases: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  backups: "M3 5h18v4H3zM5 9v10h14V9M9 13h6", deploys: "M12 19V8M9 11l3-3 3 3M7 19a4 4 0 010-8 5 5 0 019.6-1.5A4 4 0 0117 19",
  dns: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.5 2.5 15.5 0 18M12 3c-2.5 2.5-2.5 15.5 0 18", monitoring: "M3 12h4l2 6 4-12 2 6h6",
  jobs: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", security: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  settings: "M12 9a3 3 0 100 6 3 3 0 000-6zM19.4 13a7.5 7.5 0 000-2l2-1.5-2-3.5-2.3 1a7.5 7.5 0 00-1.7-1L15 3h-4l-.4 2.5a7.5 7.5 0 00-1.7 1l-2.3-1-2 3.5L6.6 11a7.5 7.5 0 000 2l-2 1.5 2 3.5 2.3-1a7.5 7.5 0 001.7 1L11 21h4l.4-2.5a7.5 7.5 0 001.7-1l2.3 1 2-3.5z",
  search: "M11 4a7 7 0 100 14 7 7 0 000-14zm9 16l-3.5-3.5", sun: "M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19",
  moon: "M21 12.8A8 8 0 1111.2 3a6.3 6.3 0 009.8 9.8z", bell: "M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6M10 20a2 2 0 004 0",
  wave: "M3 12h4l2 6 4-12 2 6h6", copy: "M9 9h11v11H9zM5 15V5a2 2 0 012-2h10", play: "M6 4l14 8-14 8z", x: "M18 6L6 18M6 6l12 12",
  menu: "M4 6h16M4 12h16M4 18h16", chevron: "M6 9l6 6 6-6", check: "M20 6L9 17l-5-5", plus: "M12 5v14M5 12h14",
  restart: "M3 12a9 9 0 103-6.7M3 4v4h4", stop: "M6 6h12v12H6z", bolt: "M13 2L4 14h7l-1 8 9-12h-7z", lock: "M4 10h16v11H4zM8 10V7a4 4 0 018 0v3",
};
const ic = (n, sz = 18, sw = 1.9) => `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${(IP[n] || "").split(/(?=M)/).map((d) => `<path d="${d}"/>`).join("")}</svg>`;
const LOGO = `<svg viewBox="0 0 150 130" width="26" height="22"><rect x="6" y="44" width="22" height="48" rx="11" fill="var(--c-brand)"/><rect x="36" y="10" width="22" height="116" rx="11" fill="var(--c-text)"/><rect x="66" y="30" width="22" height="76" rx="11" fill="var(--c-brand)"/><rect x="96" y="10" width="22" height="116" rx="11" fill="var(--amber-300)"/><rect x="126" y="48" width="22" height="40" rx="11" fill="var(--c-text)"/></svg>`;

// ============================================================ nav
const NAV = [
  { grp: "overview", items: ["dashboard"] }, { grp: "fleet", items: ["servers", "ha"] },
  { grp: "data", items: ["databases", "backups"] }, { grp: "delivery", items: ["deploys", "dns"] },
  { grp: "observe", items: ["monitoring", "jobs"] }, { grp: "govern", items: ["security", "settings"] },
];
const SCREEN_GROUPS = { security: ["security"] };

// ============================================================ state + utils
const S = { lang: localStorage.getItem("adpix_lang") || "en", theme: localStorage.getItem("adpix_theme") || "light", screen: "dashboard", collapsed: false, catalog: [], drawer: false, mode: "token", csrf: "", me: { username: "local", role: "owner" }, sd: null, runningJobs: 0 };
const el = (h) => { const d = document.createElement("div"); d.innerHTML = h.trim(); return d.firstElementChild; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function toast(msg, err = false) { let w = document.querySelector(".toasts"); if (!w) { w = el(`<div class="toasts"></div>`); document.body.appendChild(w); } const tt = el(`<div class="toast ${err ? "err" : ""}">${esc(msg)}</div>`); w.appendChild(tt); setTimeout(() => tt.remove(), 4200); }
// status → {color var, bg var, label}
function stat(s) { const k = /healthy|up|ok|running|pass|success|active/i.test(s) ? "pos" : /degraded|warn|lag|behind/i.test(s) ? "warn" : /down|fail|error|unreach|crit/i.test(s) ? "neg" : "idle"; return { color: `var(--c-${k})`, bg: `var(--c-${k}-bg)`, k }; }
function badge(label, s) { const c = stat(s || label); return `<span class="badge b-${c.k}"><span class="dot"></span>${esc(label)}</span>`; }
function parseServers(text) { const out = []; for (const line of String(text).split("\n")) { const m = line.match(/^-\s+([\w.-]+):\s+([^@]+)@([\d.]+):(\d+)/); if (m) out.push({ name: m[1], user: m[2], host: m[3], port: m[4], def: /\[default\]/.test(line) }); } return out; }
function parseCluster(text) { const c = { name: "", witness: "", nodes: [], vip: "" }; const nm = text.match(/cluster[^\n]*?"?([\w.-]+)"?/i); const w = text.match(/witness[:\s=]+"?([\w.-]+)/i); const v = text.match(/vip[:\s=]+"?([\d.]+)/i); const n = text.match(/nodes[:\s=]+\[?([^\]\n]+)/i); if (nm) c.name = nm[1]; if (w) c.witness = w[1]; if (v) c.vip = v[1]; if (n) c.nodes = n[1].split(/[,\s]+/).map((x) => x.replace(/["']/g, "")).filter(Boolean); return c; }

// ============================================================ shell
function render() {
  document.documentElement.dataset.theme = S.theme; document.body.dir = S.lang === "fa" ? "rtl" : "ltr"; document.body.lang = S.lang;
  const app = document.getElementById("app");
  app.innerHTML = `<div style="height:100vh;display:flex;flex-direction:column;overflow:hidden">
    <header class="topbar" style="gap:14px">
      <div style="display:flex;align-items:center;gap:10px;min-width:180px">${LOGO}<span style="font-family:var(--font-display);font-weight:600;font-size:17px;letter-spacing:-.2px">AdPix <span style="color:var(--c-muted);font-weight:500">Cloud</span></span></div>
      <button class="search-pill" id="palette">${ic("search", 16)}<span style="flex:1;text-align:start">${esc(t("search"))}</span><kbd>⌘K</kbd></button>
      <div style="flex:1"></div>
      <button class="icon-btn" id="lang" title="Language">${S.lang === "en" ? "EN" : "فا"}</button>
      <button class="icon-btn" id="theme">${ic(S.theme === "dark" ? "sun" : "moon", 16)}</button>
      <button class="icon-btn" id="activity" title="${t("activity")}" style="position:relative">${ic("wave", 16)}${S.runningJobs ? `<span class="pulse" style="position:absolute;top:5px;inset-inline-end:5px;width:8px;height:8px;border-radius:50%;background:var(--c-brand);border:2px solid var(--c-card)"></span>` : ""}</button>
      <button class="icon-btn" id="account" title="${esc(S.me.username)} · ${esc(S.me.role)}" style="background:var(--c-brand-tint);color:var(--c-brand);border-color:transparent;font-weight:700">${esc((S.me.username[0] || "?").toUpperCase())}</button>
    </header>
    <div style="flex:1;display:flex;min-height:0">
      <aside class="sidebar ${S.collapsed ? "collapsed" : ""}">
        <nav class="nav">${NAV.map((g) => `<div class="nav-group"><div class="nav-group-label">${esc(STR[S.lang].grp[g.grp])}</div>${g.items.map((id) => `<div class="nav-item ${S.screen === id ? "active" : ""}" data-nav="${id}"><span class="ic">${ic(id)}</span><span class="label">${esc(STR[S.lang].nav[id])}</span>${id === "jobs" && S.runningJobs ? `<span class="badge b-warn" style="padding:1px 7px;font-size:11px">${S.runningJobs}</span>` : ""}</div>`).join("")}</div>`).join("")}</nav>
        <div style="border-top:1px solid var(--c-border);padding:10px"><button class="nav-item" id="collapse" style="width:100%"><span class="ic">${ic("chevron", 16)}</span><span class="label">${t("collapse")}</span></button></div>
      </aside>
      <main class="main"><div class="content" id="content"></div></main>
    </div>
  </div>`;
  app.querySelectorAll("[data-nav]").forEach((n) => (n.onclick = () => { S.screen = n.dataset.nav; S.sd = null; render(); }));
  app.querySelector("#collapse").onclick = () => { S.collapsed = !S.collapsed; render(); };
  app.querySelector("#theme").onclick = () => { S.theme = S.theme === "dark" ? "light" : "dark"; localStorage.setItem("adpix_theme", S.theme); render(); };
  app.querySelector("#lang").onclick = () => { S.lang = S.lang === "en" ? "fa" : "en"; localStorage.setItem("adpix_lang", S.lang); render(); };
  app.querySelector("#activity").onclick = () => openDrawer();
  app.querySelector("#palette").onclick = openPalette;
  app.querySelector("#account").onclick = async () => { if (S.mode !== "session") return toast(`${S.me.username} · ${S.me.role} (token mode)`); if (confirm(`Log out ${S.me.username}?`)) { try { await api("/api/logout", { method: "POST", body: "{}" }); } catch {} location.reload(); } };
  renderScreen(document.getElementById("content"));
  refreshJobBadge();
}
function head(title, sub, actions = "") { return `<div class="h1row"><div class="grow"><h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div><div style="display:flex;gap:8px;flex-wrap:wrap">${actions}</div></div>`; }
function btn(id, label, icon, kind = "") { return `<button class="btn ${kind} btn-sm" data-act="${id}">${icon ? ic(icon, 14) : ""}${esc(label)}</button>`; }
async function refreshJobBadge() { try { const { jobs } = await listJobs(); const n = jobs.filter((j) => j.status === "running" || j.status === "queued").length; if (n !== S.runningJobs) { S.runningJobs = n; } } catch {} }

// ============================================================ screen router
const SCREENS = {};
function renderScreen(c) { (SCREENS[S.screen] || (() => { c.innerHTML = head(STR[S.lang].nav[S.screen] || S.screen); }))(c); }

// helper: a card that loads a read tool's text
function toolPanel(title, tool, args = {}, actions = "") {
  const card = el(`<div class="panel"><div class="head">${esc(title)}<button class="btn btn-sm refresh">${t("refresh")}</button></div><div class="card-pad"><div class="body"><div class="skel" style="width:70%"></div><div class="skel" style="width:50%;margin-top:8px"></div></div></div></div>`);
  const body = card.querySelector(".body");
  const load = async () => { body.innerHTML = `<div class="skel" style="width:60%"></div>`; try { const r = await runTool(tool, args); body.innerHTML = `<pre class="out">${esc(r.result)}</pre>`; } catch (e) { body.innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre>`; } };
  card.querySelector(".refresh").onclick = load; load();
  return card;
}
// run an action tool (job); destructive→preview modal
async function action(tool, args = {}, destructive = false) {
  try { if (destructive) return destructiveModal({ name: tool, title: tool, destructive: true }, args); const r = await startJob(tool, args); toast(`Started ${tool}`); openDrawer(r.job.id); refreshJobBadge(); }
  catch (e) { toast(e.message, true); }
}

// ============================================================ DASHBOARD
SCREENS.dashboard = async (c) => {
  c.innerHTML = head(t("fleetOverview"), "Live fleet health, cluster quorum, and recent activity.",
    btn("backup", t("backupAll"), "backups") + btn("deploy", t("deploy"), "deploys") + `<button class="btn btn-primary btn-sm" data-act="add">${ic("plus", 14)}${t("addServer")}</button>`);
  c.querySelector('[data-act="backup"]').onclick = () => action("adpix_backup");
  c.querySelector('[data-act="deploy"]').onclick = () => action("adpix_update", {}, false);
  c.querySelector('[data-act="add"]').onclick = () => { S.screen = "servers"; render(); };
  const kpis = el(`<div class="gridcards autofit" style="margin-bottom:16px"></div>`); c.appendChild(kpis);
  const row2 = el(`<div style="display:grid;grid-template-columns:1.35fr 1fr;gap:16px;margin-bottom:16px"></div>`); c.appendChild(row2);
  const topo = el(`<div class="panel"></div>`); const nodeH = el(`<div class="panel"><div class="head">${t("nodeHealth")}</div><div class="body card-pad"><div class="skel" style="width:60%"></div></div></div>`); row2.append(topo, nodeH);
  const row3 = el(`<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px"></div>`); c.appendChild(row3);
  const jobsC = el(`<div class="panel"><div class="head">${t("recentJobs")}<button class="btn btn-sm" data-go="jobs">${t("viewAll")} →</button></div><div class="rj"></div></div>`);
  const alertsC = el(`<div class="panel"><div class="head">${t("activeAlerts")}<span class="al-count"></span></div><div class="al"></div></div>`);
  row3.append(jobsC, alertsC); jobsC.querySelector("[data-go]").onclick = () => { S.screen = "jobs"; render(); };

  const [srvText, cluText] = await Promise.all([runTool("server_list").then((r) => r.result).catch(() => ""), runTool("cluster_list").then((r) => r.result).catch(() => "")]);
  const servers = parseServers(srvText); const clu = parseCluster(cluText);
  const kpiData = [["Servers", servers.length, "registered", "var(--c-brand)"], ["Cluster", clu.name || "—", clu.nodes.length ? `${clu.nodes.length} nodes` : "none", "var(--c-pos)"], ["Witness", clu.witness || "—", "quorum", "var(--c-pos)"], ["VIP", clu.vip || "—", "front door", "var(--c-brand)"]];
  kpis.innerHTML = kpiData.map(([l, v, s, col]) => `<div class="accent-card"><div class="bar" style="background:${col}"></div><div class="kpi-label">${esc(l)}</div><div style="display:flex;align-items:baseline;gap:8px;margin-top:8px"><span class="kpi mono">${esc(v)}</span><span style="font-size:12px;color:var(--c-muted)">${esc(s)}</span></div></div>`).join("");

  // topology
  if (clu.nodes.length || clu.witness) topo.innerHTML = topologySvg(clu, t("clusterTopology"), t("quorumHealthy"));
  else topo.innerHTML = `<div class="head">${t("clusterTopology")}</div><div class="empty">No cluster defined. Define one on the High availability screen.</div>`;
  // node health = host metrics per server (live, one probe)
  nodeH.querySelector(".body").innerHTML = servers.length ? servers.map((s) => `<div class="mono" style="padding:10px 0;border-bottom:1px solid var(--c-divider)"><b>${esc(s.name)}</b> <span class="muted">${esc(s.host)}</span></div>`).join("") + `<div class="hint" style="margin-top:8px">Open a server for live CPU/RAM/disk.</div>` : `<div class="empty">No servers yet.</div>`;
  // recent jobs + alerts
  try { const { jobs } = await listJobs(); jobsC.querySelector(".rj").innerHTML = jobs.length ? jobs.slice(0, 5).map((j) => `<div style="display:flex;align-items:center;gap:11px;padding:11px 16px;border-bottom:1px solid var(--c-divider)"><span class="dot ${j.status === "running" ? "pulse" : ""}" style="background:${stat(j.status).color}"></span><div style="flex:1;min-width:0"><div class="mono" style="font-size:13px;font-weight:500">${esc(j.tool)}</div><div class="mono muted" style="font-size:11.5px">${esc(j.key || "")}</div></div>${badge(j.status, j.status)}</div>`).join("") : `<div class="empty">${t("noJobs")}</div>`; } catch { jobsC.querySelector(".rj").innerHTML = `<div class="empty">${t("noJobs")}</div>`; }
  alertsC.querySelector(".al").innerHTML = `<div class="empty">Run a health check from Monitoring to surface alerts.</div>`;
};
function topologySvg(clu, title, healthy) {
  const A = clu.nodes[0] || "node-a", B = clu.nodes[1] || "node-b", W = clu.witness || "witness";
  return `<div class="head">${esc(title)}<span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--c-pos);font-weight:500"><span class="dot" style="background:var(--c-pos)"></span>${esc(healthy)}</span></div>
  <div style="padding:8px 12px 14px"><svg viewBox="0 0 560 230" width="100%" style="display:block">
    <line x1="280" y1="60" x2="150" y2="165" stroke="var(--c-border)" stroke-width="2"/><line x1="280" y1="60" x2="410" y2="165" stroke="var(--c-border)" stroke-width="2"/><line x1="150" y1="165" x2="410" y2="165" stroke="var(--c-brand)" stroke-width="2" stroke-dasharray="5 5"/>
    <rect x="232" y="18" width="96" height="44" rx="9" fill="var(--c-card)" stroke="var(--c-pos)" stroke-width="2"/><circle cx="248" cy="40" r="5" fill="var(--c-pos)"/><text x="262" y="37" font-size="12" font-weight="600" fill="var(--c-text)" font-family="var(--font-mono)">${esc(W)}</text><text x="262" y="50" font-size="9.5" fill="var(--c-muted)">3rd vote</text>
    <rect x="78" y="163" width="148" height="50" rx="9" fill="var(--c-card)" stroke="var(--c-pos)" stroke-width="2"/><circle cx="96" cy="183" r="5" fill="var(--c-pos)"/><text x="110" y="181" font-size="12" font-weight="600" fill="var(--c-text)" font-family="var(--font-mono)">${esc(A)}</text><text x="110" y="194" font-size="9.5" fill="var(--c-muted)">pg primary · ch r1</text>
    <rect x="334" y="163" width="148" height="50" rx="9" fill="var(--c-card)" stroke="var(--c-pos)" stroke-width="2"/><circle cx="352" cy="183" r="5" fill="var(--c-pos)"/><text x="366" y="181" font-size="12" font-weight="600" fill="var(--c-text)" font-family="var(--font-mono)">${esc(B)}</text><text x="366" y="194" font-size="9.5" fill="var(--c-muted)">pg standby · ch r2</text>
    ${clu.vip ? `<rect x="244" y="147" width="72" height="34" rx="8" fill="var(--c-brand-tint)" stroke="var(--c-brand)" stroke-width="1.5"/><text x="280" y="168" text-anchor="middle" font-size="10" font-weight="700" fill="var(--c-brand)" font-family="var(--font-mono)">VIP</text>` : ""}
  </svg></div>`;
}

// ============================================================ SERVERS
SCREENS.servers = async (c) => {
  c.innerHTML = head(STR[S.lang].nav.servers, "Every registered server in the fleet.", `<button class="btn btn-primary btn-sm" data-act="add">${ic("plus", 14)}${t("addServer")}</button>`);
  c.querySelector('[data-act="add"]').onclick = () => addServerModal();
  const panel = el(`<div class="panel"><div class="gridhead" style="grid-template-columns:1.4fr .9fr 1.1fr 1fr .8fr"><span>Name</span><span>Role</span><span>Host</span><span>adpixDir</span><span style="text-align:end">Status</span></div><div class="rows"><div class="card-pad"><div class="skel" style="width:60%"></div></div></div></div>`);
  c.appendChild(panel);
  const [srvText, cluText] = await Promise.all([runTool("server_list").then((r) => r.result).catch((e) => e.message), runTool("cluster_list").then((r) => r.result).catch(() => "")]);
  const servers = parseServers(srvText); const clu = parseCluster(cluText);
  const roleOf = (n) => n === clu.witness ? "witness" : clu.nodes.includes(n) ? "node" : "—";
  const rows = panel.querySelector(".rows");
  rows.innerHTML = servers.length ? "" : `<div class="empty">${esc(srvText)}</div>`;
  servers.forEach((s) => { const r = el(`<button class="gridrow" style="grid-template-columns:1.4fr .9fr 1.1fr 1fr .8fr"><span style="display:flex;align-items:center;gap:9px"><span class="dot" style="background:var(--c-idle)"></span><span class="mono" style="font-weight:500">${esc(s.name)}</span></span><span class="muted">${esc(roleOf(s.name))}</span><span class="mono muted">${esc(s.host)}</span><span class="muted">${esc("/opt/adpix")}</span><span style="text-align:end">${badge("open →", "idle")}</span></button>`); r.onclick = () => { S.sd = s.name; S.screen = "serverDetail"; render(); }; rows.appendChild(r); });
};

// ============================================================ SERVER DETAIL / CONTAINERS
SCREENS.serverDetail = async (c) => {
  const name = S.sd;
  c.innerHTML = `<button class="btn btn-sm" data-back style="margin-bottom:12px;background:transparent;border:0;color:var(--c-muted)">${ic("chevron", 15)} ${STR[S.lang].nav.servers}</button>`
    + head(name, "Containers, resources, and live logs.", `<button class="btn btn-sm" data-act="backup">Backup now</button><button class="btn btn-sm" data-act="restart">Restart all</button>`);
  c.querySelector("[data-back]").onclick = () => { S.screen = "servers"; S.sd = null; render(); };
  c.querySelector('[data-act="backup"]').onclick = () => action("adpix_backup", { server: name });
  c.querySelector('[data-act="restart"]').onclick = () => destructiveModal({ name: "adpix_restart", title: `Restart all services on ${name}`, destructive: true }, { server: name });
  const grid = el(`<div style="display:grid;grid-template-columns:1.05fr 1fr;gap:16px;align-items:start"></div>`); c.appendChild(grid);
  // containers (live status text) + per-service controls for known services
  const known = ["ingest", "api", "web", "worker", "identity-job", "postgres", "clickhouse", "caddy", "redis"];
  const contCard = el(`<div class="panel"><div class="head">${t("containers")}</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--c-divider)" class="cc"></div></div>`);
  contCard.querySelector(".cc").innerHTML = known.map((svc) => `<div class="cont-card"><div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span class="dot" style="background:var(--c-idle)"></span><span class="mono" style="font-size:13px;font-weight:500">${esc(svc)}</span></div><div class="muted" style="font-size:11px;margin-bottom:9px">tap a control</div><div style="display:flex;gap:5px"><button class="iconbtn-sm" data-svc="${svc}" data-a="restart" style="flex:1" title="Restart">${ic("restart", 13)}</button><button class="iconbtn-sm" data-svc="${svc}" data-a="stop" style="flex:1" title="Stop">${ic("stop", 12)}</button><button class="iconbtn-sm" data-svc="${svc}" data-a="status" style="flex:1" title="Status">${ic("wave", 13)}</button></div></div>`).join("");
  contCard.querySelectorAll("[data-svc]").forEach((b) => (b.onclick = () => { const svc = b.dataset.svc, a = b.dataset.a; if (a === "status") action("container_control", { server: name, service: svc, action: "status" }); else destructiveModal({ name: "container_control", title: `${a} ${svc} on ${name}`, destructive: true }, { server: name, service: svc, action: a }); }));
  // log viewer (live)
  const logCard = el(`<div class="panel" style="display:flex;flex-direction:column"><div class="head">${t("logs")}<button class="btn btn-sm" data-load>${t("refresh")}</button></div><div class="log-view" style="height:420px">click refresh to tail logs…</div></div>`);
  logCard.querySelector("[data-load]").onclick = async () => { const lv = logCard.querySelector(".log-view"); lv.textContent = "loading…"; try { const r = await runTool("adpix_logs", { server: name, lines: 120 }); lv.innerHTML = String(r.result).split("\n").map((l) => `<div class="row"><span style="color:var(--c-text)">${esc(l)}</span></div>`).join(""); lv.scrollTop = lv.scrollHeight; } catch (e) { lv.textContent = e.message; } };
  grid.append(contCard, logCard);
};

// ============================================================ JOBS & AUDIT
SCREENS.jobs = async (c) => {
  c.innerHTML = head(STR[S.lang].nav.jobs, "Live jobs and the immutable audit trail.", `<button class="btn btn-sm" data-r>${t("refresh")}</button>`);
  const live = el(`<div class="panel" style="margin-bottom:16px"><div class="head">Live jobs</div><div class="lj"><div class="card-pad"><div class="skel" style="width:50%"></div></div></div></div>`); c.appendChild(live);
  const audit = el(`<div class="panel"><div class="head">${ic("security", 15)} Audit log<span class="hint" style="margin-inline-start:auto">Immutable · hash-chained</span></div><div class="au"></div></div>`); c.appendChild(audit);
  const loadJobs2 = async () => { try { const { jobs } = await listJobs(); live.querySelector(".lj").innerHTML = jobs.length ? jobs.slice(0, 30).map((j) => `<div style="padding:13px 16px;border-bottom:1px solid var(--c-divider)"><div style="display:flex;align-items:center;gap:11px"><span class="dot ${j.status === "running" ? "pulse" : ""}" style="background:${stat(j.status).color}"></span><span class="mono" style="font-size:13px;font-weight:500;flex:1">${esc(j.tool)}</span><span class="mono muted" style="font-size:11.5px">${esc(j.key || "")} · ${esc(j.id.slice(0, 8))}</span>${badge(j.status, j.status)}<button class="btn btn-sm" data-v="${j.id}">View</button></div></div>`).join("") : `<div class="empty">${t("noJobs")}</div>`; live.querySelectorAll("[data-v]").forEach((b) => (b.onclick = () => openDrawer(b.dataset.v))); } catch (e) { live.querySelector(".lj").innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre>`; } };
  c.querySelector("[data-r]").onclick = loadJobs2; loadJobs2();
  if (S.me.role === "owner") { try { const { entries, chain } = await api("/api/admin/audit"); audit.querySelector(".au").innerHTML = `<div style="padding:8px 16px">${chain.ok ? badge("chain intact", "pos") : badge("TAMPERED @ " + chain.brokenAtSeq, "neg")}</div><div class="gridhead" style="grid-template-columns:.5fr 1fr 1.4fr 1fr .8fr"><span>#</span><span>Who</span><span>Action</span><span>Target</span><span style="text-align:end">Outcome</span></div>` + entries.slice(0, 40).map((e) => `<div class="gridrow" style="grid-template-columns:.5fr 1fr 1.4fr 1fr .8fr;cursor:default"><span class="muted">${e.seq}</span><span class="mono">${esc(e.actor)}</span><span class="mono" style="font-size:11.5px">${esc(e.tool)}</span><span>${esc(e.target)}</span><span style="text-align:end" class="muted">${esc(e.outcome)}</span></div>`).join(""); } catch (e) { audit.querySelector(".au").innerHTML = `<div class="empty">${esc(e.message)}</div>`; } }
  else audit.querySelector(".au").innerHTML = `<div class="empty">Audit log is owner-only.</div>`;
};

// ============================================================ BACKUPS
SCREENS.backups = (c) => {
  let tab = "list";
  const draw = () => {
    c.innerHTML = head(STR[S.lang].nav.backups, "On-demand + scheduled snapshots.", `<button class="btn btn-primary btn-sm" data-act="create">${ic("plus", 14)}Create backup</button>`);
    c.appendChild(el(`<div class="seg"><button class="${tab === "list" ? "on" : ""}" data-tab="list">Run / restore</button><button class="${tab === "sched" ? "on" : ""}" data-tab="sched">Schedule</button></div>`));
    c.querySelector('[data-act="create"]').onclick = () => action("adpix_backup");
    c.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; draw(); }));
    if (tab === "list") {
      const g = el(`<div class="gridcards cols-2" style="grid-template-columns:1fr 1fr"></div>`); c.appendChild(g);
      g.append(actionCardEl("adpix_backup", "Create a verified app backup", false), actionCardEl("pg_backup", "Postgres dump", false), actionCardEl("ch_backup", "ClickHouse backup", false),
        actionCardEl("adpix_restore", "Restore the app from a backup dir", true), actionCardEl("pg_restore_db", "Restore Postgres from a dump", true), actionCardEl("ch_restore_db", "Restore ClickHouse", true));
    } else {
      const card = el(`<div class="panel" style="max-width:560px"><div class="head" style="display:block">Backup schedule<div class="sub">Verified snapshots on a systemd timer.</div></div><div class="card-pad">
        <label class="fld"><span class="lab">Name</span><input class="input mono" id="sname" value="nightly-backup"></label>
        <label class="fld"><span class="lab">OnCalendar</span><input class="input mono" id="ssched" value="daily"></label>
        <div style="display:flex;justify-content:flex-end"><button class="btn btn-primary" id="ssave">Save schedule</button></div></div></div>`);
      c.appendChild(card);
      card.querySelector("#ssave").onclick = () => destructiveModal({ name: "schedule_job", title: "Create a scheduled backup timer", destructive: true }, { action: "add", task: "backup", name: card.querySelector("#sname").value.trim(), schedule: card.querySelector("#ssched").value.trim() });
    }
  };
  draw();
};

// ============================================================ DATABASES
SCREENS.databases = (c) => {
  let db = "pg";
  const draw = () => {
    const pfx = db === "pg" ? "pg" : "ch";
    c.innerHTML = head(STR[S.lang].nav.databases, "Health, tuning, and retention for Postgres + ClickHouse.", btn("opt", "Optimize", "bolt"));
    c.appendChild(el(`<div class="seg"><button class="${db === "pg" ? "on" : ""}" data-db="pg" style="font-family:var(--font-mono)">Postgres</button><button class="${db === "ch" ? "on" : ""}" data-db="ch" style="font-family:var(--font-mono)">ClickHouse</button></div>`));
    c.querySelectorAll("[data-db]").forEach((b) => (b.onclick = () => { db = b.dataset.db; draw(); }));
    c.querySelector('[data-act="opt"]').onclick = () => action(`${pfx}_optimize`, { apply: false });
    c.appendChild(toolPanel(`${db === "pg" ? "Postgres" : "ClickHouse"} health`, `${pfx}_health`, {}));
    const g = el(`<div style="display:grid;grid-template-columns:1.1fr 1fr;gap:16px;align-items:start;margin-top:16px"></div>`); c.appendChild(g);
    g.appendChild(toolPanel("Tune (dry-run diff)", `${pfx}_tune`, { apply: false }, ""));
    const ret = el(`<div class="panel"><div class="head" style="display:block">Retention<div class="sub">Drops partitions older than the window. Permanent.</div></div><div class="card-pad">${db === "ch" ? `<label class="fld"><span class="lab">Keep months</span><input class="input mono" id="rmon" value="12"></label><div class="badge b-neg" style="margin-bottom:12px"><span class="dot"></span>This permanently deletes older partitions</div><button class="btn btn-danger" id="rapply" style="width:100%;justify-content:center">Apply retention</button>` : `<div class="muted">Retention applies to ClickHouse (raw events). Switch to the ClickHouse tab.</div>`}</div></div>`);
    g.appendChild(ret);
    const ra = ret.querySelector("#rapply"); if (ra) ra.onclick = () => destructiveModal({ name: "ch_retention", title: "Apply ClickHouse retention (drops old partitions)", destructive: true }, { mode: "apply", months: Number(ret.querySelector("#rmon").value) });
    // tune apply button
    const tuneApply = el(`<div style="margin-top:10px"><button class="btn btn-primary btn-sm" id="tapply">Apply tuning (restarts engine)</button></div>`); g.children[0].querySelector(".card-pad").appendChild(tuneApply);
    tuneApply.querySelector("#tapply").onclick = () => destructiveModal({ name: `${pfx}_tune`, title: `Apply ${pfx} tuning (restarts engine)`, destructive: true }, { apply: true });
  };
  draw();
};

// ============================================================ DEPLOYS
SCREENS.deploys = (c) => {
  c.innerHTML = head(STR[S.lang].nav.deploys, "Releases, rollback, and blue-green across the cluster.");
  const g = el(`<div style="display:grid;grid-template-columns:1.1fr 1fr;gap:16px;align-items:start"></div>`); c.appendChild(g);
  const left = el(`<div style="display:flex;flex-direction:column;gap:16px"></div>`);
  const cur = el(`<div class="panel card-pad"><div class="kpi-label">Current deploy</div><div style="display:flex;gap:8px;margin-top:14px"><button class="btn btn-primary" data-a="update">Update</button><button class="btn" data-a="bg">Blue-green</button><button class="btn" data-a="rb">Rollback</button></div></div>`);
  cur.querySelector('[data-a="update"]').onclick = () => action("adpix_update");
  cur.querySelector('[data-a="bg"]').onclick = () => destructiveModal({ name: "bluegreen_deploy", title: "Blue-green deploy across the cluster", destructive: true }, {});
  cur.querySelector('[data-a="rb"]').onclick = () => destructiveModal({ name: "adpix_update", title: "Rollback (redeploy previous)", destructive: false }, {});
  left.append(cur, toolPanel("CI/CD status", "cicd_status", {}));
  g.append(left, toolPanel("Cluster status", "cluster_status", {}));
};

// ============================================================ HIGH AVAILABILITY
SCREENS.ha = async (c) => {
  c.innerHTML = head(STR[S.lang].nav.ha, "Witness-anchored quorum: VIP, Postgres, Redis, ClickHouse.", `<button class="btn btn-sm" data-a="standup">Stand up HA</button><button class="btn btn-danger btn-sm" data-a="fail">Failover</button>`);
  c.querySelector('[data-a="standup"]').onclick = () => destructiveModal({ name: "ha_standup", title: "Stand up the HA quorum (keepalived + sentinel)", destructive: true }, { mode: "keepalived" });
  c.querySelector('[data-a="fail"]').onclick = () => toast("Failover: use ha_quorum status, then promote via pg_replication.", false);
  const topo = el(`<div class="panel" style="margin-bottom:16px"></div>`); c.appendChild(topo);
  const cluText = await runTool("cluster_list").then((r) => r.result).catch(() => ""); const clu = parseCluster(cluText);
  topo.innerHTML = clu.nodes.length || clu.witness ? topologySvg(clu, "Topology", "Quorum 3/3") : `<div class="head">Topology</div><div class="empty">No cluster defined. cluster_define first.</div>`;
  c.appendChild(toolPanel("Quorum status", "ha_quorum", { mode: "status" }));
};

// ============================================================ DNS & CONNECT
SCREENS.dns = (c) => {
  c.innerHTML = head(STR[S.lang].nav.dns, "Required DNS records and client connection configs.");
  c.appendChild(toolPanel("Required DNS records", "dns_plan", {}));
  const cc = el(`<div style="margin-top:16px"></div>`); c.appendChild(cc); cc.appendChild(toolPanel("Client connect configs", "connect_configs", {}));
};

// ============================================================ MONITORING
SCREENS.monitoring = (c) => {
  c.innerHTML = head(STR[S.lang].nav.monitoring, "Health probes, TLS expiry, host metrics.");
  const g = el(`<div style="display:grid;grid-template-columns:1.2fr 1fr;gap:16px;align-items:start;margin-bottom:16px"></div>`); c.appendChild(g);
  g.append(toolPanel("Health probes", "health_check", {}), toolPanel("TLS certificates", "tls_status", {}));
  c.appendChild(toolPanel("Host metrics", "system_metrics", {}));
  const m = el(`<div style="margin-top:16px"></div>`); c.appendChild(m);
  const mq = el(`<div class="panel"><div class="head">PromQL query<span class="badge b-warn" style="padding:1px 8px">metrics_query</span></div><div class="card-pad"><label class="fld"><span class="lab">PromQL (against the witness Prometheus)</span><input class="input mono" id="pq" value="up"></label><button class="btn btn-primary btn-sm" id="pqrun">Run</button><div class="pqout" style="margin-top:10px"></div></div></div>`);
  m.appendChild(mq);
  mq.querySelector("#pqrun").onclick = async () => { const o = mq.querySelector(".pqout"); o.innerHTML = `<span class="spin"></span>`; try { const r = await runTool("metrics_query", { query: mq.querySelector("#pq").value }); o.innerHTML = `<pre class="out">${esc(r.result)}</pre>`; } catch (e) { o.innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre>`; } };
};

// ============================================================ SECURITY
SCREENS.security = (c) => {
  c.innerHTML = head(STR[S.lang].nav.security, "Audit findings, hardening, patching, launch gate.", `<button class="btn btn-sm" data-a="harden">Harden (dry-run)</button><button class="btn btn-primary btn-sm" data-a="patch">Apply patches</button>`);
  c.querySelector('[data-a="harden"]').onclick = () => action("harden_server", { apply: false });
  c.querySelector('[data-a="patch"]').onclick = () => destructiveModal({ name: "patch_system", title: "Apply system patches", destructive: true }, {});
  c.appendChild(toolPanel("Launch gate", "launch_gate", { mode: "status" }));
  const g = el(`<div style="margin-top:16px"></div>`); c.appendChild(g); g.appendChild(toolPanel("Security audit", "security_audit", {}));
};

// ============================================================ SETTINGS
SCREENS.settings = (c) => {
  c.innerHTML = head(STR[S.lang].nav.settings, "Admins, sessions, audit, secrets, integrations.");
  const grid = el(`<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start"></div>`); c.appendChild(grid);
  const colA = el(`<div style="display:flex;flex-direction:column;gap:16px"></div>`); const colB = el(`<div style="display:flex;flex-direction:column;gap:16px"></div>`); grid.append(colA, colB);
  if (S.me.role === "owner") { colA.append(adminUsers(), adminSessions()); colB.append(adminAudit(), adminKill()); }
  else { colA.appendChild(el(`<div class="panel card-pad muted">Signed in as <b>${esc(S.me.username)}</b> · role <b>${esc(S.me.role)}</b>. Admin controls are owner-only.</div>`)); }
  // integrations (visual, like the design's "Soon")
  colB.appendChild(el(`<div class="panel"><div class="head">SMTP / email <span class="badge b-warn" style="padding:1px 8px">${t("soon")}</span></div><div class="card-pad muted" style="font-size:13px">Alert digests + reports. Wire an SMTP host in a future release.</div></div>`));
};

// ============================================================ generic action card (used by backups)
function actionCardEl(name, label, destructive) {
  const card = el(`<div class="panel card-pad" style="display:flex;flex-direction:column;gap:10px"><div style="display:flex;align-items:center;gap:8px"><strong class="mono" style="font-size:13px">${esc(name)}</strong>${destructive ? badge("destructive", "neg") : `<span class="tag">job</span>`}</div><div class="muted" style="font-size:13px;flex:1">${esc(label)}</div><div class="argform"></div><button class="btn ${destructive ? "btn-danger" : "btn-primary"} btn-sm run">${ic("play", 14)} ${t("run")}</button><div class="result"></div></div>`);
  const cat = S.catalog.find((x) => x.name === name); const props = (cat && cat.params && cat.params.properties) || {};
  const af = card.querySelector(".argform"); af.appendChild(argForm(props));
  card.querySelector(".run").onclick = async () => { const args = readArgs(af); if (destructive) return destructiveModal({ name, title: label, destructive: true }, args); try { const r = await startJob(name, args); toast(`Started ${name}`); openDrawer(r.job.id); } catch (e) { card.querySelector(".result").innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre>`; } };
  return card;
}
function argForm(props) { const w = el(`<div></div>`); Object.entries(props).forEach(([k, sc]) => { if (k === "confirm") return; let f; if (sc.enum) f = `<select class="input" data-k="${k}"><option value="">—</option>${sc.enum.map((o) => `<option>${esc(o)}</option>`).join("")}</select>`; else if (sc.type === "boolean") f = `<select class="input" data-k="${k}" data-bool="1"><option value="">—</option><option>true</option><option>false</option></select>`; else f = `<input class="input" data-k="${k}" data-num="${sc.type === "number" || sc.type === "integer" ? 1 : ""}" placeholder="${esc(sc.type || "")}">`; w.appendChild(el(`<label class="fld"><span class="lab">${esc(k)}</span>${f}</label>`)); }); return w; }
function readArgs(af) { const a = {}; af.querySelectorAll("[data-k]").forEach((i) => { const v = i.value.trim(); if (!v) return; a[i.dataset.k] = i.dataset.bool ? v === "true" : i.dataset.num ? Number(v) : v; }); return a; }

// ============================================================ command palette
function openPalette() {
  const items = [...NAV.flatMap((g) => g.items.map((id) => ({ label: STR[S.lang].nav[id], kind: "screen", id }))), ...S.catalog.filter((t) => t.readOnly).slice(0, 40).map((t) => ({ label: `Run ${t.name}`, kind: "tool", id: t.name }))];
  const pal = el(`<div class="palette"><div class="box"><input placeholder="${esc(t("search"))}" autofocus><div class="opts"></div></div></div>`);
  const inp = pal.querySelector("input"); const opts = pal.querySelector(".opts"); let sel = 0, filtered = items;
  const draw = () => { opts.innerHTML = filtered.slice(0, 8).map((o, i) => `<div class="opt ${i === sel ? "sel" : ""}" data-i="${i}">${ic(o.kind === "screen" ? o.id : "play", 16)} <span>${esc(o.label)}</span></div>`).join(""); opts.querySelectorAll("[data-i]").forEach((e) => (e.onclick = () => pick(filtered[+e.dataset.i]))); };
  const pick = (o) => { pal.remove(); if (!o) return; if (o.kind === "screen") { S.screen = o.id; S.sd = null; render(); } else action(o.id); };
  inp.oninput = () => { const q = inp.value.toLowerCase(); filtered = items.filter((o) => o.label.toLowerCase().includes(q)); sel = 0; draw(); };
  inp.onkeydown = (e) => { if (e.key === "ArrowDown") { sel = Math.min(sel + 1, Math.min(filtered.length, 8) - 1); draw(); } else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); draw(); } else if (e.key === "Enter") pick(filtered[sel]); else if (e.key === "Escape") pal.remove(); };
  pal.onclick = (e) => { if (e.target === pal) pal.remove(); };
  document.body.appendChild(pal); draw(); inp.focus();
}
document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); if (S.mode && document.querySelector(".sidebar")) openPalette(); } });

// ============================================================ activity drawer + SSE
let drawerAbort = null;
async function openDrawer(focusId) {
  S.drawer = true;
  let scrim = document.querySelector(".scrim"), drawer = document.querySelector(".drawer");
  if (!scrim) { scrim = el(`<div class="scrim"></div>`); document.body.appendChild(scrim); scrim.onclick = closeDrawer; }
  if (!drawer) { drawer = el(`<aside class="drawer"><div class="drawer-head"><strong>${t("activity")}</strong><button class="icon-btn" id="dc">${ic("x", 16)}</button></div><div class="drawer-body" id="db"></div></aside>`); document.body.appendChild(drawer); drawer.querySelector("#dc").onclick = closeDrawer; }
  requestAnimationFrame(() => { scrim.classList.add("show"); drawer.classList.add("show"); });
  const db = drawer.querySelector("#db");
  try { const { jobs } = await listJobs(); db.innerHTML = jobs.length ? "" : `<div class="empty">${t("noJobs")}</div>`; jobs.slice(0, 12).forEach((j) => db.appendChild(jobItem(j, j.id === focusId))); if (focusId) { const it = db.querySelector(`[data-job="${focusId}"]`); if (it) liveStream(focusId, it); } } catch (e) { db.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function closeDrawer() { S.drawer = false; if (drawerAbort) drawerAbort.abort(); document.querySelector(".scrim")?.classList.remove("show"); document.querySelector(".drawer")?.classList.remove("show"); refreshJobBadge(); }
function jobItem(j, open) {
  const it = el(`<div class="job-item" data-job="${j.id}"><div class="top"><strong class="mono" style="font-size:12.5px">${esc(j.tool)}</strong>${badge(j.status, j.status)}</div>${j.status === "running" ? `<div class="bar"><i></i></div>` : ""}<div class="log" style="display:${open ? "block" : "none"};margin-top:8px"></div><div style="margin-top:8px;display:flex;gap:6px"><button class="btn btn-sm toggle">${open ? "Hide" : "Logs"}</button>${j.status === "running" ? `<button class="btn btn-sm btn-danger kill">${t("cancel")}</button>` : ""}</div></div>`);
  const log = it.querySelector(".log");
  it.querySelector(".toggle").onclick = () => { const sh = log.style.display === "none"; log.style.display = sh ? "block" : "none"; it.querySelector(".toggle").textContent = sh ? "Hide" : "Logs"; if (sh && !log.dataset.s) liveStream(j.id, it); };
  it.querySelector(".kill")?.addEventListener("click", async () => { try { await cancelJob(j.id); toast("Canceled"); } catch (e) { toast(e.message, true); } });
  if (open) liveStream(j.id, it);
  return it;
}
function liveStream(id, it) { const log = it.querySelector(".log"); log.dataset.s = "1"; log.style.display = "block"; drawerAbort = new AbortController(); streamJob(id, (ev) => { if (ev.type === "log") { log.appendChild(document.createTextNode(ev.line + "\n")); log.scrollTop = log.scrollHeight; } if (ev.type === "status" || ev.type === "done") { const b = it.querySelector(".badge"); if (b && ev.status) b.outerHTML = badge(ev.status, ev.status); if (ev.type === "done") { it.querySelector(".bar")?.remove(); it.querySelector(".kill")?.remove(); refreshJobBadge(); } } }, drawerAbort.signal).catch(() => {}); }

// ============================================================ modals
function modalShell(title, body, ok, onOk, danger = false) {
  const m = el(`<div class="modal"><div class="box"><div class="mhead ${danger ? "danger" : ""}">${esc(title)}</div><div class="mbody"></div><div class="mfoot"><button class="btn cancel">${t("cancel")}</button><button class="btn ${danger ? "btn-danger" : "btn-primary"} ok">${esc(ok)}</button></div></div></div>`);
  m.querySelector(".mbody").appendChild(body); m.querySelector(".cancel").onclick = () => m.remove(); m.querySelector(".ok").onclick = async () => { if ((await onOk()) !== false) m.remove(); }; return m;
}
function destructiveModal(tool, args) {
  const target = args.cluster || args.server || args.name || args.service || "";
  const body = el(`<div><p>${esc(tool.title)}</p><p class="mono" style="background:var(--c-sunken);padding:8px 10px;border-radius:8px;font-size:12px">${esc(tool.name)} ${esc(JSON.stringify(args))}</p>${tool.destructive ? `<p class="muted">${t("typeToConfirm")}</p><input class="input ci" placeholder="${esc(target || "confirm")}">` : ""}</div>`);
  const m = modalShell(tool.destructive ? t("destructive") : "Confirm", body, t("confirm"), async () => {
    if (tool.destructive && target && body.querySelector(".ci").value.trim() !== target) { toast(`Type "${target}" to confirm`, true); return false; }
    try { const r = tool.destructive ? await startDestructive(tool.name, args) : await startJob(tool.name, args); toast(`Started ${tool.name}`); openDrawer(r.job.id); refreshJobBadge(); return true; } catch (e) { toast(e.message, true); return false; }
  }, tool.destructive);
  document.body.appendChild(m);
}
function addServerModal() {
  const props = (S.catalog.find((t) => t.name === "server_add")?.params?.properties) || {}; const af = argForm(props);
  document.body.appendChild(modalShell("Add a server", af, "Add", async () => { const a = readArgs(af); if (!a.name || !a.host) { toast("name + host required", true); return false; } try { const r = await startJob("server_add", a); toast("Adding…"); openDrawer(r.job.id); setTimeout(() => render(), 1500); return true; } catch (e) { toast(e.message, true); return false; } }));
}
// admin (settings)
function panelCard(title, extra = "") { return el(`<div class="panel"><div class="head">${esc(title)}${extra}<button class="btn btn-sm refresh">${t("refresh")}</button></div><div class="card-pad"><div class="body"><div class="skel" style="width:60%"></div></div></div></div>`); }
function adminUsers() { const c = panelCard("Users & roles"); const body = c.querySelector(".body"); const load = async () => { try { const { users } = await api("/api/admin/users"); body.innerHTML = `<table class="t"><thead><tr><th>User</th><th>Role</th><th>Scopes</th><th></th></tr></thead><tbody>${users.map((u) => `<tr><td class="mono">${esc(u.username)}</td><td><span class="tag">${esc(u.role)}</span></td><td class="muted">${esc((u.scopes || []).join(", "))}</td><td>${u.username === S.me.username ? "" : `<button class="btn btn-sm rm" data-u="${esc(u.username)}">Remove</button>`}</td></tr>`).join("")}</tbody></table><div style="margin-top:12px"><button class="btn btn-primary btn-sm add">+ Add user</button></div>`; body.querySelector(".add").onclick = () => addUserModal(load); body.querySelectorAll(".rm").forEach((b) => (b.onclick = async () => { if (confirm(`Remove ${b.dataset.u}?`)) { await api("/api/admin/users/remove", { method: "POST", body: JSON.stringify({ username: b.dataset.u }) }); load(); } })); } catch (e) { body.innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre>`; } }; c.querySelector(".refresh").onclick = load; load(); return c; }
function addUserModal(after) { const body = el(`<div><label class="fld"><span class="lab">Username</span><input class="input" data-k="username"></label><label class="fld"><span class="lab">Password</span><input class="input" type="password" data-k="password"></label><label class="fld"><span class="lab">Role</span><select class="input" data-k="role"><option>viewer</option><option>operator</option><option>owner</option></select></label><label class="fld"><span class="lab">Scopes (comma; blank=all)</span><input class="input" data-k="scopes" placeholder="*"></label></div>`); document.body.appendChild(modalShell("Add user", body, "Create", async () => { const g = (k) => body.querySelector(`[data-k="${k}"]`).value.trim(); if (!g("username") || !g("password")) { toast("username + password required", true); return false; } try { const r = await api("/api/admin/users", { method: "POST", body: JSON.stringify({ username: g("username"), password: g("password"), role: g("role"), scopes: g("scopes") ? g("scopes").split(",").map((s) => s.trim()) : ["*"] }) }); showTotp(r); after && after(); return true; } catch (e) { toast(e.message, true); return false; } })); }
function showTotp(r) { document.body.appendChild(modalShell("TOTP secret (shown once)", el(`<div><p>User <b>${esc(r.username)}</b> created. Add to an authenticator:</p><pre class="out">${esc(r.totpSecret)}</pre><p class="muted" style="word-break:break-all;font-size:12px">${esc(r.totpUri)}</p></div>`), t("close"), async () => true)); }
function adminSessions() { const c = panelCard("Active sessions"); const body = c.querySelector(".body"); const load = async () => { try { const { sessions } = await api("/api/admin/sessions"); body.innerHTML = sessions.length ? `<table class="t"><thead><tr><th>User</th><th>IP</th><th>Last seen</th></tr></thead><tbody>${sessions.map((s) => `<tr><td class="mono">${esc(s.username)}</td><td class="muted">${esc(s.ip)}</td><td class="muted">${new Date(s.lastSeen).toLocaleTimeString()}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">No active sessions.</div>`; } catch (e) { body.innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre>`; } }; c.querySelector(".refresh").onclick = load; load(); return c; }
function adminAudit() { const c = panelCard("Audit log"); const body = c.querySelector(".body"); const load = async () => { try { const { entries, chain } = await api("/api/admin/audit"); body.innerHTML = `<div style="margin-bottom:8px">${chain.ok ? badge("chain intact", "pos") : badge("TAMPERED @ " + chain.brokenAtSeq, "neg")}</div><table class="t"><thead><tr><th>#</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>${entries.slice(0, 30).map((e) => `<tr><td class="muted">${e.seq}</td><td class="mono">${esc(e.actor)}</td><td class="mono">${esc(e.tool)}</td><td>${esc(e.target)}</td></tr>`).join("")}</tbody></table>`; } catch (e) { body.innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre>`; } }; c.querySelector(".refresh").onclick = load; load(); return c; }
function adminKill() { const c = el(`<div class="panel card-pad"><div style="display:flex;align-items:center;justify-content:space-between;gap:12px"><div><h3 style="margin:0 0 4px;font-size:14px;font-weight:600">Kill-switch</h3><div class="muted" style="font-size:13px">Disable destructive ops + revoke every session.</div></div><button class="btn btn-danger" id="k">${ic("security", 14)} Engage</button></div></div>`); c.querySelector("#k").onclick = async () => { if (!confirm("Engage the kill-switch? Revokes ALL sessions + blocks destructive ops.")) return; try { await api("/api/admin/kill", { method: "POST", body: JSON.stringify({ on: true }) }); toast("Kill-switch engaged — logging out"); setTimeout(() => location.reload(), 800); } catch (e) { toast(e.message, true); } }; return c; }

// ============================================================ auth gate
function authShell(inner) { document.documentElement.dataset.theme = S.theme; document.getElementById("app").innerHTML = `<div style="min-height:100vh;display:grid;place-items:center;background:var(--c-bg);padding:24px"><div class="card" style="width:380px;max-width:92vw;padding:26px"><div style="display:flex;align-items:center;gap:10px;margin-bottom:18px">${LOGO}<span style="font-family:var(--font-display);font-weight:600;font-size:18px">AdPix Cloud</span></div>${inner}</div></div>`; }
function renderLogin(msg = "") {
  authShell(`${msg ? `<div class="badge b-neg" style="margin-bottom:12px"><span class="dot"></span>${esc(msg)}</div>` : ""}<label class="fld"><span class="lab">Username</span><input class="input" id="u"></label><label class="fld"><span class="lab">Password</span><input class="input" type="password" id="p"></label><label class="fld"><span class="lab">Authenticator code</span><input class="input mono" id="totp" inputmode="numeric" placeholder="000000"></label><button class="btn btn-primary" id="go" style="width:100%;justify-content:center;margin-top:6px">Sign in</button>`);
  const go = async () => { try { const r = await api("/api/login", { method: "POST", body: JSON.stringify({ username: u.value.trim(), password: p.value, totp: totp.value.trim() }) }); S.csrf = r.csrf; sessionStorage.removeItem("adpix_token"); boot(); } catch (e) { renderLogin(e.message); } };
  const u = document.getElementById("u"), p = document.getElementById("p"), totp = document.getElementById("totp");
  document.getElementById("go").onclick = go; totp.onkeydown = (e) => { if (e.key === "Enter") go(); };
}
function renderSetup(msg = "") {
  authShell(`<p class="muted" style="margin-top:0">First run — create the owner account. You'll get a TOTP secret for an authenticator app.</p>${msg ? `<div class="badge b-neg" style="margin-bottom:12px"><span class="dot"></span>${esc(msg)}</div>` : ""}<label class="fld"><span class="lab">Username</span><input class="input" id="u"></label><label class="fld"><span class="lab">Password</span><input class="input" type="password" id="p"></label><button class="btn btn-primary" id="go" style="width:100%;justify-content:center;margin-top:6px">Create owner</button>`);
  document.getElementById("go").onclick = async () => { const u = document.getElementById("u").value.trim(), p = document.getElementById("p").value; if (!u || !p) return renderSetup("username + password required"); try { const r = await api("/api/setup", { method: "POST", body: JSON.stringify({ username: u, password: p }) }); authShell(`<p>Owner <b>${esc(r.username)}</b> created. Add this TOTP secret to your authenticator (shown once):</p><pre class="out">${esc(r.totpSecret)}</pre><p class="muted" style="word-break:break-all;font-size:12px">${esc(r.totpUri)}</p><button class="btn btn-primary" id="c" style="width:100%;justify-content:center;margin-top:10px">Continue to sign in</button>`); document.getElementById("c").onclick = () => renderLogin(); } catch (e) { renderSetup(e.message); } };
}

// ============================================================ boot
async function boot() {
  let me = null; try { me = await api("/api/me"); } catch {}
  if (me) {
    S.me = me.actor; S.mode = me.mode; if (me.csrf) S.csrf = me.csrf;
    if (me.killed) { authShell(`<div class="badge b-neg"><span class="dot"></span>Kill-switch engaged</div><p class="muted">Destructive ops disabled, sessions revoked. An owner must release it.</p><button class="btn" id="r" style="width:100%;justify-content:center;margin-top:8px">Reload</button>`); document.getElementById("r").onclick = () => location.reload(); return; }
    try { const { tools } = await api("/api/catalog"); S.catalog = tools; } catch (e) { authShell(`<div class="empty">Failed to load: ${esc(e.message)}</div>`); return; }
    render(); return;
  }
  let status = {}; try { status = await fetch("/api/status").then((r) => r.json()); } catch {}
  if (status.adminsExist) return renderLogin();
  if (TOKEN) return renderSetup();
  authShell(`<div class="empty">No session token. Open the URL printed by <code>--panel</code> (it carries <code>#token=…</code>), or have an owner create your account.</div>`);
}
boot();
