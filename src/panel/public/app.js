// AdPix Cloud — control panel SPA. Pixel-faithful to the AdPix Cloud design, driven by the
// panel API (/api/fleet, /api/db, tools, jobs). Slide-in panels + a stepper wizard for actions,
// SSE job drawer, login + TOTP. Inline styles mirror the design tokens exactly.

// ============================================================ api
const TOKEN = (location.hash.match(/token=([a-f0-9]+)/) || [])[1] || sessionStorage.getItem("adpix_token") || "";
if (TOKEN) sessionStorage.setItem("adpix_token", TOKEN);
history.replaceState(null, "", location.pathname);
function authHeaders(mut) { if (S.mode === "session") return mut ? { "x-adpix-csrf": S.csrf } : {}; return TOKEN ? { "x-adpix-token": TOKEN } : {}; }
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, credentials: "same-origin", headers: { ...(opts.body ? { "content-type": "application/json" } : {}), ...authHeaders(!!opts.body), ...(opts.headers || {}) } });
  if (!res.ok && res.status !== 202) { let m = res.statusText; try { m = (await res.json()).error || m; } catch {} const e = new Error(m); e.status = res.status; throw e; }
  return res.status === 204 ? null : res.json();
}
const runTool = (n, a = {}) => api(`/api/tools/${n}`, { method: "POST", body: JSON.stringify({ args: a }) });
const startJob = (tool, a = {}) => api("/api/jobs", { method: "POST", body: JSON.stringify({ tool, args: a, idempotencyKey: `${tool}:${Date.now()}` }) });
async function startDestructive(tool, a = {}) { const pv = await api("/api/preview", { method: "POST", body: JSON.stringify({ tool, args: a }) }); return api("/api/jobs", { method: "POST", body: JSON.stringify({ tool, args: a, nonce: pv.nonce, idempotencyKey: `${tool}:${Date.now()}` }) }); }
const listJobs = () => api("/api/jobs");
const cancelJob = (id) => api(`/api/jobs/${id}/cancel`, { method: "POST", body: "{}" });
async function streamJob(id, onEvent, signal) { const res = await fetch(`/api/jobs/${id}/stream`, { headers: { "x-adpix-token": TOKEN }, credentials: "same-origin", signal }); const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = ""; while (true) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf("\n\n")) !== -1) { const ch = buf.slice(0, i); buf = buf.slice(i + 2); const ln = ch.split("\n").find((l) => l.startsWith("data: ")); if (ln) { try { onEvent(JSON.parse(ln.slice(6))); } catch {} } } } }

// ============================================================ i18n
const STR = {
  en: { nav: { dashboard: "Dashboard", servers: "Servers", ha: "High availability", databases: "Databases", backups: "Backups", deploys: "Deploys", dns: "DNS & connect", monitoring: "Monitoring", jobs: "Jobs & audit", security: "Security", settings: "Settings" },
    grp: { overview: "Overview", fleet: "Fleet", data: "Data", delivery: "Delivery", observe: "Observe", govern: "Govern" },
    fleetOverview: "Fleet overview", backupAll: "Backup all", deploy: "Deploy", addServer: "Add server", search: "Search servers, screens, actions…", collapse: "Collapse",
    quorumHealthy: "Quorum healthy", clusterTopology: "Cluster topology", nodeHealth: "Node health", recentJobs: "Recent jobs", activeAlerts: "Active alerts", viewAll: "View all",
    activity: "Activity", noJobs: "No active jobs. Everything is idle.", containers: "Containers", logs: "Logs", refresh: "Refresh", cancel: "Cancel", back: "Back", next: "Next",
    typeToConfirm: "This is irreversible. Type the target name to confirm:", soon: "Soon" },
  fa: { nav: { dashboard: "داشبورد", servers: "سرورها", ha: "دسترس‌پذیری بالا", databases: "پایگاه‌داده", backups: "پشتیبان‌گیری", deploys: "استقرار", dns: "DNS و اتصال", monitoring: "پایش", jobs: "کارها و ممیزی", security: "امنیت", settings: "تنظیمات" },
    grp: { overview: "نمای کلی", fleet: "فلیت", data: "داده", delivery: "تحویل", observe: "مشاهده", govern: "حاکمیت" },
    fleetOverview: "نمای کلی فلیت", backupAll: "پشتیبان‌گیری همه", deploy: "استقرار", addServer: "افزودن سرور", search: "جستجوی سرور، صفحه، عملیات…", collapse: "جمع کردن",
    quorumHealthy: "حد نصاب سالم", clusterTopology: "توپولوژی خوشه", nodeHealth: "سلامت گره‌ها", recentJobs: "کارهای اخیر", activeAlerts: "هشدارهای فعال", viewAll: "مشاهده همه",
    activity: "فعالیت", noJobs: "کار فعالی نیست.", containers: "کانتینرها", logs: "لاگ‌ها", refresh: "تازه‌سازی", cancel: "لغو", back: "قبلی", next: "بعدی",
    typeToConfirm: "این عمل بازگشت‌ناپذیر است. نام هدف را بنویسید:", soon: "به‌زودی" },
};
const t = (k) => STR[S.lang][k] ?? k;

// ============================================================ icons
const IP = {
  dashboard: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z", servers: "M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01",
  ha: "M6 9a3 3 0 100-6 3 3 0 000 6zm12 0a3 3 0 100-6 3 3 0 000 6zM12 21a3 3 0 100-6 3 3 0 000 6zM7.5 7.5l3 6m6-6l-3 6",
  databases: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  backups: "M3 5h18v4H3zM5 9v10h14V9M9 13h6", deploys: "M12 19V8M9 11l3-3 3 3M7 19a4 4 0 010-8 5 5 0 019.6-1.5A4 4 0 0117 19",
  dns: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.5 2.5 15.5 0 18M12 3c-2.5 2.5-2.5 15.5 0 18", monitoring: "M3 12h4l2 6 4-12 2 6h6",
  jobs: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", security: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  settings: "M12 9a3 3 0 100 6 3 3 0 000-6zM19.4 13a7.5 7.5 0 000-2l2-1.5-2-3.5-2.3 1a7.5 7.5 0 00-1.7-1L15 3h-4l-.4 2.5a7.5 7.5 0 00-1.7 1l-2.3-1-2 3.5L6.6 11a7.5 7.5 0 000 2l-2 1.5 2 3.5 2.3-1a7.5 7.5 0 001.7 1L11 21h4l.4-2.5a7.5 7.5 0 001.7-1l2.3 1 2-3.5z",
  search: "M11 4a7 7 0 100 14 7 7 0 000-14zm9 16l-3.5-3.5", sun: "M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19",
  moon: "M21 12.8A8 8 0 1111.2 3a6.3 6.3 0 009.8 9.8z", bell: "M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6M10 20a2 2 0 004 0", wave: "M3 12h4l2 6 4-12 2 6h6",
  copy: "M9 9h11v11H9zM5 15V5a2 2 0 012-2h10", play: "M6 4l14 8-14 8z", x: "M18 6L6 18M6 6l12 12", chevron: "M6 9l6 6 6-6", chevL: "M15 6l-6 6 6 6",
  plus: "M12 5v14M5 12h14", restart: "M3 12a9 9 0 103-6.7M3 4v4h4", stop: "M6 6h12v12H6z", bolt: "M13 2L4 14h7l-1 8 9-12h-7z", check: "M20 6L9 17l-5-5", warn: "M12 9v4M12 17h.01M10.3 3.9 2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z",
};
const ic = (n, sz = 18, sw = 1.85) => `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${(IP[n] || "").split(/(?=M)/).filter(Boolean).map((d) => `<path d="${d}"/>`).join("")}</svg>`;
const LOGO = `<svg viewBox="0 0 150 130" width="26" height="22"><rect x="6" y="44" width="22" height="48" rx="11" fill="var(--c-brand)"/><rect x="36" y="10" width="22" height="116" rx="11" fill="var(--c-text)"/><rect x="66" y="30" width="22" height="76" rx="11" fill="var(--c-brand)"/><rect x="96" y="10" width="22" height="116" rx="11" fill="var(--amber-300)"/><rect x="126" y="48" width="22" height="40" rx="11" fill="var(--c-text)"/></svg>`;

// ============================================================ nav + state + utils
const NAV = [{ grp: "overview", items: ["dashboard"] }, { grp: "fleet", items: ["servers", "ha"] }, { grp: "data", items: ["databases", "backups"] }, { grp: "delivery", items: ["deploys", "dns"] }, { grp: "observe", items: ["monitoring", "jobs"] }, { grp: "govern", items: ["security", "settings"] }];
const S = { lang: localStorage.getItem("adpix_lang") || "en", theme: localStorage.getItem("adpix_theme") || "light", screen: "dashboard", collapsed: false, catalog: [], mode: "token", csrf: "", me: { username: "local", role: "owner" }, sd: null, fleet: null, cluster: "", clusters: [] };
const el = (h) => { const d = document.createElement("div"); d.innerHTML = h.trim(); return d.firstElementChild; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function toast(m, err = false) { let w = document.querySelector(".toasts"); if (!w) { w = el(`<div class="toasts"></div>`); document.body.appendChild(w); } const tt = el(`<div class="toast ${err ? "err" : ""}">${esc(m)}</div>`); w.appendChild(tt); setTimeout(() => tt.remove(), 4200); }
const SK = { healthy: "pos", up: "pos", ok: "pos", running: "warn", queued: "idle", degraded: "warn", down: "neg", failed: "neg", canceled: "idle", interrupted: "warn", succeeded: "pos" };
const sc = (s) => SK[s] || (/heal|up|ok|pass|succ|done/i.test(s) ? "pos" : /degrad|warn|run/i.test(s) ? "warn" : /down|fail|err|crit|unreach/i.test(s) ? "neg" : "idle");
const cvar = (k) => `var(--c-${k})`;
function pill(label, s) { const k = sc(s || label); return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:500;padding:2px 9px;border-radius:999px;background:var(--c-${k}-bg);color:var(--c-${k})"><span style="width:6px;height:6px;border-radius:50%;background:var(--c-${k})"></span>${esc(label)}</span>`; }
const metColor = (v) => v >= 80 ? cvar("neg") : v >= 65 ? cvar("warn") : cvar("brand");
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const whenLabel = (s) => ({ succeeded: "just now", canceled: "cancelled", failed: "failed", running: "running", queued: "queued", interrupted: "interrupted" }[s] || s);

// ============================================================ shell
function render() {
  document.documentElement.dataset.theme = S.theme; document.body.dir = S.lang === "fa" ? "rtl" : "ltr"; document.body.lang = S.lang;
  const aj = S.fleet ? S.fleet.counts.activeJobs : 0;
  const cl = S.fleet ? S.fleet.cluster : { name: "—" };
  const app = document.getElementById("app");
  app.innerHTML = `<div style="height:100vh;display:flex;flex-direction:column;overflow:hidden;background:var(--c-bg);color:var(--c-text)">
    <header style="height:56px;flex:none;display:flex;align-items:center;gap:14px;padding-inline:16px;background:var(--c-topbar);border-bottom:1px solid var(--c-border);z-index:20">
      <div style="display:flex;align-items:center;gap:10px;min-width:180px">${LOGO}<span style="font-family:var(--font-display);font-weight:600;font-size:17px;letter-spacing:-.2px">AdPix <span style="color:var(--c-muted);font-weight:500">Cloud</span></span></div>
      <button class="cluster-pill"><span style="width:7px;height:7px;border-radius:50%;background:var(--c-pos)"></span><span style="font-weight:500">${esc(cl.name || "no cluster")}</span>${cl.vip ? `<span style="color:var(--c-hint);font-size:11px">${esc(cl.vip)}</span>` : ""}${ic("chevron", 14)}</button>
      <button class="search-pill" id="palette">${ic("search", 16)}<span style="flex:1;text-align:start;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t("search"))}</span><kbd>⌘K</kbd></button>
      <div style="flex:1"></div>
      <button class="icon-btn" id="lang" style="border-radius:999px">${S.lang === "en" ? "EN" : "فا"}</button>
      <button class="icon-btn" id="theme" style="border-radius:999px">${ic(S.theme === "dark" ? "sun" : "moon", 17)}</button>
      <button class="icon-btn" id="activity" title="${t("activity")}" style="position:relative;border-radius:999px">${ic("wave", 17)}${aj ? `<span class="pulse" style="position:absolute;top:5px;inset-inline-end:5px;width:8px;height:8px;border-radius:50%;background:var(--c-brand);border:2px solid var(--c-topbar)"></span>` : ""}</button>
      <button class="icon-btn" style="border-radius:999px">${ic("bell", 17)}</button>
      <button class="icon-btn" id="account" title="${esc(S.me.username)} · ${esc(S.me.role)}" style="background:var(--c-brand);color:#fff;border-color:transparent;font-weight:600;border-radius:999px;font-size:13px">${esc((S.me.username.slice(0, 2)).toUpperCase())}</button>
    </header>
    <div style="flex:1;display:flex;min-height:0">
      <aside class="sidebar ${S.collapsed ? "collapsed" : ""}">
        <nav class="nav" style="padding:12px 10px">${NAV.map((g) => `<div class="nav-group"><div class="nav-group-label">${esc(STR[S.lang].grp[g.grp])}</div>${g.items.map((id) => navItem(id, aj)).join("")}</div>`).join("")}</nav>
        <div style="border-top:1px solid var(--c-border);padding:10px"><button class="nav-item" id="collapse" style="width:100%;color:var(--c-muted)"><span class="ic">${ic("chevL", 16)}</span><span class="label">${t("collapse")}</span></button></div>
      </aside>
      <main class="main"><div class="content" id="content" style="padding:22px 30px 60px"></div></main>
    </div></div>`;
  app.querySelectorAll("[data-nav]").forEach((n) => (n.onclick = () => { S.screen = n.dataset.nav; S.sd = null; render(); }));
  app.querySelector("#collapse").onclick = () => { S.collapsed = !S.collapsed; render(); };
  app.querySelector("#theme").onclick = () => { S.theme = S.theme === "dark" ? "light" : "dark"; localStorage.setItem("adpix_theme", S.theme); render(); };
  app.querySelector("#lang").onclick = () => { S.lang = S.lang === "en" ? "fa" : "en"; localStorage.setItem("adpix_lang", S.lang); render(); };
  app.querySelector("#activity").onclick = () => openDrawer();
  app.querySelector("#palette").onclick = openPalette;
  app.querySelector(".cluster-pill").onclick = (e) => clusterMenu(e.currentTarget);
  app.querySelector("#account").onclick = async () => { if (S.mode !== "session") return toast(`${S.me.username} · ${S.me.role} (token mode)`); if (confirm(`Log out ${S.me.username}?`)) { try { await api("/api/logout", { method: "POST", body: "{}" }); } catch {} location.reload(); } };
  (SCREENS[S.screen] || SCREENS.dashboard)(document.getElementById("content"));
}
function navItem(id, aj) {
  const count = id === "servers" && S.fleet ? S.fleet.nodes.length : id === "jobs" && aj ? aj : id === "deploys" && S.fleet ? 0 : "";
  const badge = count ? `<span class="nav-badge" style="display:flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;font-size:11px;font-weight:600;flex:none;background:${id === "jobs" ? "var(--c-warn-bg)" : "var(--c-sunken)"};color:${id === "jobs" ? "var(--c-warn)" : "var(--c-muted)"}">${count}</span>` : "";
  return `<div class="nav-item ${S.screen === id ? "active" : ""}" data-nav="${id}"><span class="ic">${ic(id)}</span><span class="label" style="flex:1">${esc(STR[S.lang].nav[id])}</span>${badge}</div>`;
}
// header block
function H(title, sub, actions = "") { return `<div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:20px"><div style="flex:1;min-width:220px"><h1 style="margin:0;font-size:22px;font-weight:500;letter-spacing:-.3px">${esc(title)}</h1>${sub ? `<div style="color:var(--c-muted);font-size:13px;margin-top:4px">${esc(sub)}</div>` : ""}</div><div style="display:flex;gap:8px;flex-wrap:wrap">${actions}</div></div>`; }
const cardOpen = `background:var(--c-card);border:1px solid var(--c-border);border-radius:10px;box-shadow:var(--c-shadow-card);overflow:hidden`;
const cardHead = `padding:13px 16px;border-bottom:1px solid var(--c-divider);font-weight:500;font-size:14px`;
function bigBtn(id, label, icon, primary) { return `<button data-act="${id}" style="display:inline-flex;align-items:center;gap:7px;height:38px;padding-inline:15px;border:${primary ? "0" : "1px solid var(--c-border)"};background:${primary ? "var(--c-brand)" : "var(--c-card)"};color:${primary ? "#fff" : "var(--c-text)"};border-radius:8px;cursor:pointer;font:inherit;font-size:13px;font-weight:${primary ? 600 : 500};box-shadow:var(--c-shadow-card);white-space:nowrap">${icon ? ic(icon, 15) : ""}${esc(label)}</button>`; }

// ============================================================ data fetch
async function loadFleet() { try { S.fleet = await api("/api/fleet" + (S.cluster ? "?cluster=" + encodeURIComponent(S.cluster) : "")); } catch { S.fleet = null; } }
async function loadClusters() { try { S.clusters = (await api("/api/clusters")).clusters || []; } catch { S.clusters = []; } }

// cluster switcher popover
function clusterMenu(anchor) {
  document.querySelector(".popmenu")?.remove();
  const r = anchor.getBoundingClientRect();
  const items = [{ name: "", label: "All / default" }, ...S.clusters.map((c) => ({ name: c.name, label: c.name, sub: `${c.nodes.length} nodes${c.vip ? " · " + c.vip : ""}` }))];
  const m = el(`<div class="popmenu" style="position:fixed;top:${r.bottom + 6}px;inset-inline-start:${r.left}px;min-width:220px;background:var(--c-card);border:1px solid var(--c-border);border-radius:10px;box-shadow:var(--c-shadow-menu);z-index:80;padding:6px">
    ${items.map((it) => `<div class="ci" data-c="${esc(it.name)}" style="display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:8px;cursor:pointer;${it.name === S.cluster ? "background:var(--c-brand-tint)" : ""}"><span style="width:7px;height:7px;border-radius:50%;background:${it.name === S.cluster ? "var(--c-brand)" : "var(--c-idle)"}"></span><div style="flex:1"><div style="font-size:13px;font-weight:500">${esc(it.label)}</div>${it.sub ? `<div class="muted" style="font-size:11px">${esc(it.sub)}</div>` : ""}</div></div>`).join("")}
    ${S.me.role === "owner" ? `<div style="border-top:1px solid var(--c-divider);margin-top:6px;padding-top:6px"><div class="addsrv" style="display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:8px;cursor:pointer;color:var(--c-brand)">${ic("plus", 15)}<span style="font-size:13px;font-weight:500">Add server</span></div></div>` : ""}</div>`);
  document.body.appendChild(m);
  const close = () => { m.remove(); document.removeEventListener("click", onDoc, true); };
  const onDoc = (ev) => { if (!m.contains(ev.target) && !anchor.contains(ev.target)) close(); };
  setTimeout(() => document.addEventListener("click", onDoc, true), 0);
  m.querySelectorAll("[data-c]").forEach((x) => (x.onclick = async () => { S.cluster = x.dataset.c; close(); await loadFleet(); render(); }));
  m.querySelector(".addsrv")?.addEventListener("click", () => { close(); addServerWizard(); });
}

// ============================================================ DASHBOARD
const SCREENS = {};
SCREENS.dashboard = async (c) => {
  const f = S.fleet || { cluster: { name: "", vip: "", servers: 0 }, counts: { healthy: 0, degraded: 0, down: 0, activeJobs: 0 }, nodes: [], recentJobs: [], alerts: [] };
  const sub = `cluster ${f.cluster.name || "—"} · ${f.cluster.servers} server${f.cluster.servers === 1 ? "" : "s"}${f.cluster.vip ? " · vip " + f.cluster.vip : ""}`;
  c.innerHTML = H(t("fleetOverview"), sub, bigBtn("backup", t("backupAll"), "backups") + bigBtn("deploy", t("deploy"), "deploys") + bigBtn("add", t("addServer"), "plus", true));
  c.querySelector('[data-act="backup"]').onclick = () => action("adpix_backup");
  c.querySelector('[data-act="deploy"]').onclick = async () => { const an = (await ensureStacks()).find((x) => x.stack === "analytics"); if (an && !an.installed) return installForm("analytics"); action("adpix_update"); };
  c.querySelector('[data-act="add"]').onclick = addServerWizard;
  // KPI cards
  const kpi = [["HEALTHY", f.counts.healthy, "servers", "pos"], ["DEGRADED", f.counts.degraded, "need attention", "warn"], ["DOWN", f.counts.down, "critical", "neg"], ["ACTIVE JOBS", f.counts.activeJobs, "running", "brand"]];
  c.appendChild(el(`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px;margin-bottom:16px">${kpi.map(([l, v, s, k]) => `<div style="${cardOpen};padding:18px 18px 18px 20px;position:relative"><div style="position:absolute;inset-block:0;inset-inline-start:0;width:4px;background:var(--c-${k})"></div><div style="color:var(--c-muted);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.6px">${l}</div><div style="display:flex;align-items:baseline;gap:8px;margin-top:10px"><span style="font-size:32px;font-weight:400;letter-spacing:-.5px">${v}</span><span style="font-size:13px;color:var(--c-muted)">${s}</span></div></div>`).join("")}</div>`));
  // topology + node health
  const row2 = el(`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;margin-bottom:16px"></div>`); c.appendChild(row2);
  row2.appendChild(el(`<div style="${cardOpen}">${topologyCard(f)}</div>`));
  const nh = el(`<div style="${cardOpen}"><div style="${cardHead}">${t("nodeHealth")}</div><div></div></div>`);
  nh.lastElementChild.innerHTML = f.nodes.length ? f.nodes.map((n) => nodeHealthRow(n)).join("") : `<div class="empty">No servers. Add one to see live health.</div>`;
  row2.appendChild(nh);
  // recent jobs + alerts
  const row3 = el(`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px"></div>`); c.appendChild(row3);
  const rj = el(`<div style="${cardOpen}"><div style="${cardHead};display:flex;align-items:center;justify-content:space-between">${t("recentJobs")}<button data-go style="border:0;background:transparent;color:var(--c-brand);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer">${t("viewAll")} →</button></div><div></div></div>`);
  rj.querySelector("[data-go]").onclick = () => { S.screen = "jobs"; render(); };
  rj.lastElementChild.innerHTML = f.recentJobs.length ? f.recentJobs.map((j) => `<div style="display:flex;align-items:center;gap:11px;padding:11px 16px;border-bottom:1px solid var(--c-divider)"><span style="width:8px;height:8px;border-radius:50%;background:var(--c-${sc(j.status)});flex:none;${j.status === "running" ? "animation:pulse-dot 1.4s infinite" : ""}"></span><div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500">${esc(j.tool)}</div><div style="font-size:11.5px;color:var(--c-muted);font-family:var(--font-mono)">${esc(j.target)}</div></div><span style="font-size:11.5px;color:var(--c-hint)">${esc(whenLabel(j.status))}</span></div>`).join("") : `<div class="empty">${t("noJobs")}</div>`;
  const al = el(`<div style="${cardOpen}"><div style="${cardHead};display:flex;align-items:center;justify-content:space-between">${t("activeAlerts")}<span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--c-warn-bg);color:var(--c-warn)">${f.alerts.length}</span></div><div></div></div>`);
  al.lastElementChild.innerHTML = f.alerts.length ? f.alerts.map((a) => `<div style="display:flex;gap:11px;padding:12px 16px;border-bottom:1px solid var(--c-divider)"><span style="width:3px;border-radius:999px;background:var(--c-${a.level});flex:none;align-self:stretch"></span><div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500">${esc(a.title)}</div><div style="font-size:12px;color:var(--c-muted);margin-top:2px">${esc(a.why)}</div>${a.action ? `<button data-fix="${esc(a.action.tool)}" style="margin-top:7px;border:1px solid var(--c-border);background:var(--c-card);color:var(--c-text);border-radius:7px;padding:4px 10px;font:inherit;font-size:12px;font-weight:500;cursor:pointer">${esc(a.action.label)}</button>` : ""}</div></div>`).join("") : `<div class="empty">No active alerts.</div>`;
  al.querySelectorAll("[data-fix]").forEach((b) => (b.onclick = () => action(b.dataset.fix)));
  row3.append(rj, al);
};
function nodeHealthRow(n) {
  const mets = [["CPU", n.cpu], ["MEM", n.mem], ["DISK", n.disk]];
  return `<div style="padding:12px 16px;border-bottom:1px solid var(--c-divider)"><div style="display:flex;align-items:center;gap:8px;margin-bottom:9px"><span style="font-family:var(--font-mono);font-size:13px;font-weight:500">${esc(n.name)}</span><span style="font-size:11px;color:var(--c-hint);text-transform:uppercase;letter-spacing:.4px">${esc(n.role)}</span><span style="flex:1"></span>${pill(cap(n.status), n.status)}</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">${mets.map(([l, v]) => `<div><div style="display:flex;justify-content:space-between;font-size:11px;color:var(--c-muted);margin-bottom:4px"><span>${l}</span><span style="font-family:var(--font-mono);color:${metColor(v)}">${v}%</span></div><div style="height:5px;border-radius:999px;background:var(--c-sunken);overflow:hidden"><div style="height:100%;width:${v}%;background:${metColor(v)};border-radius:999px"></div></div></div>`).join("")}</div></div>`;
}
function topologyCard(f) {
  const W = f.nodes.find((n) => n.role === "witness"), nodes = f.nodes.filter((n) => n.role === "node");
  const vip = f.cluster?.vip;
  const verdict = !nodes.length ? ["No nodes", "idle"] : nodes.every((n) => n.status === "healthy") ? ["Quorum healthy", "pos"] : ["Degraded", "warn"];
  const nodeCard = (n) => `<div style="flex:1 1 150px;min-width:148px;border:1.5px solid var(--c-${sc(n.status)});border-radius:10px;padding:12px 14px;background:var(--c-card)"><div style="display:flex;align-items:center;gap:8px"><span style="width:8px;height:8px;border-radius:50%;background:var(--c-${sc(n.status)})"></span><span class="mono" style="font-size:13px;font-weight:600">${esc(n.name)}</span></div><div class="muted" style="font-size:11.5px;margin-top:5px">${esc(n.dbRole || "—")}</div><div style="font-size:11px;color:${n.status !== "healthy" ? "var(--c-warn)" : "var(--c-muted)"};margin-top:3px;font-family:var(--font-mono)">cpu ${n.cpu}% · mem ${n.mem}%</div></div>`;
  return `<div style="${cardHead};display:flex;align-items:center;justify-content:space-between">${t("clusterTopology")}${pill(verdict[0], verdict[1])}</div>
  <div style="padding:14px 16px">
    ${W || vip ? `<div style="display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:14px;flex-wrap:wrap">${W ? `<div style="display:inline-flex;align-items:center;gap:7px;border:1.5px solid var(--c-${sc(W.status)});border-radius:999px;padding:6px 13px;background:var(--c-card)"><span style="width:7px;height:7px;border-radius:50%;background:var(--c-${sc(W.status)})"></span><span class="mono" style="font-size:12px;font-weight:600">${esc(W.name)}</span><span class="muted" style="font-size:10.5px">witness · 3rd vote</span></div>` : ""}${vip ? `<div style="display:inline-flex;align-items:center;gap:6px;border:1.5px solid var(--c-brand);border-radius:999px;padding:6px 13px;background:var(--c-brand-tint)"><span style="font-size:10px;font-weight:700;color:var(--c-brand);font-family:var(--font-mono)">VIP</span><span class="mono" style="font-size:11.5px;color:var(--c-brand)">${esc(vip)}</span></div>` : ""}</div>` : ""}
    <div style="display:flex;gap:12px;flex-wrap:wrap">${nodes.length ? nodes.map(nodeCard).join("") : `<div class="muted" style="font-size:12.5px;padding:8px">No data nodes yet — add servers (role: node) to this cluster.</div>`}</div>
  </div>`;
}

// ============================================================ SERVERS
SCREENS.servers = (c) => {
  const f = S.fleet || { cluster: { name: "" }, nodes: [] };
  c.innerHTML = H(STR[S.lang].nav.servers, `${f.nodes.length} servers${f.cluster.name ? " in cluster " + f.cluster.name : ""}`, bigBtn("add", t("addServer"), "plus", true));
  c.querySelector('[data-act="add"]').onclick = addServerWizard;
  const cols = "1.4fr .8fr 1.1fr 1.1fr 1fr .8fr";
  const tbl = el(`<div style="${cardOpen}"><div style="display:grid;grid-template-columns:${cols};gap:12px;padding:11px 18px;border-bottom:1px solid var(--c-border);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--c-hint)"><span>Name</span><span>Role</span><span>Host</span><span>OS</span><span>Status</span><span style="text-align:end">Last seen</span></div><div class="rows"></div></div>`);
  c.appendChild(tbl);
  tbl.querySelector(".rows").innerHTML = f.nodes.length ? f.nodes.map((n) => `<button class="srvrow" data-n="${esc(n.name)}" style="width:100%;display:grid;grid-template-columns:${cols};gap:12px;align-items:center;padding:13px 18px;border:0;border-bottom:1px solid var(--c-divider);background:transparent;cursor:pointer;color:inherit;font:inherit;text-align:start"><span style="display:flex;align-items:center;gap:9px"><span style="width:8px;height:8px;border-radius:50%;background:var(--c-${sc(n.status)})"></span><span style="font-family:var(--font-mono);font-size:13px;font-weight:500">${esc(n.name)}</span></span><span style="font-size:12.5px;color:var(--c-muted)">${esc(n.role)}</span><span style="font-family:var(--font-mono);font-size:12.5px;color:var(--c-muted)">${esc(n.host)}</span><span style="font-size:12.5px;color:var(--c-muted)">${esc(n.os)}</span><span>${pill(cap(n.status), n.status)}</span><span style="text-align:end;font-size:12px;color:var(--c-hint);font-family:var(--font-mono)">${esc(n.lastSeen)}</span></button>`).join("") : `<div class="empty">No servers registered. Click “Add server”.</div>`;
  tbl.querySelectorAll(".srvrow").forEach((r) => (r.onclick = () => { S.sd = r.dataset.n; S.screen = "serverDetail"; render(); }));
};

// ============================================================ SERVER DETAIL
SCREENS.serverDetail = (c) => {
  const name = S.sd; const n = (S.fleet?.nodes || []).find((x) => x.name === name) || { name, host: "", os: "", status: "idle", cpu: 0, mem: 0, disk: 0 };
  c.innerHTML = `<button data-back style="display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--c-muted);font:inherit;font-size:12.5px;cursor:pointer;margin-bottom:12px;padding:0">${ic("chevL", 15)} ${STR[S.lang].nav.servers}</button>`
    + `<div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:18px"><div style="flex:1;min-width:220px"><div style="display:flex;align-items:center;gap:10px"><h1 style="margin:0;font-size:22px;font-weight:500;font-family:var(--font-mono)">${esc(name)}</h1>${pill(cap(n.status), n.status)}</div><div style="color:var(--c-muted);font-size:13px;margin-top:5px;font-family:var(--font-mono)">${esc(n.host)} · ${esc(n.os)}</div></div><div style="display:flex;gap:8px">${bigBtn("backup", "Backup now")}${bigBtn("restart", "Restart all")}<button data-act="remove" style="display:inline-flex;align-items:center;gap:7px;height:38px;padding-inline:15px;border:1px solid var(--c-neg);background:transparent;color:var(--c-neg);border-radius:8px;cursor:pointer;font:inherit;font-size:13px;font-weight:500">${ic("stop", 14)} Remove</button></div></div>`;
  c.querySelector("[data-back]").onclick = () => { S.screen = "servers"; S.sd = null; render(); };
  c.querySelector('[data-act="backup"]').onclick = () => action("adpix_backup", { server: name });
  c.querySelector('[data-act="restart"]').onclick = () => verifyAction({ name: "adpix_restart", title: `Restart all services on ${name}`, destructive: true }, { server: name });
  c.querySelector('[data-act="remove"]').onclick = () => confirmDanger("Remove server", `Remove <b class="mono">${esc(name)}</b> from the registry. This does <b>not</b> touch the machine or its data — it only stops AdPix from managing it. The MCP key stays authorized on the host until you revoke it.`, name, async () => { await startJob("server_remove", { name }); toast(`Removed ${name}`); await loadClusters(); await loadFleet(); S.screen = "servers"; S.sd = null; render(); }, "Remove server");
  // gauges
  c.appendChild(el(`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:16px">${[["CPU", n.cpu], ["MEMORY", n.mem], ["DISK", n.disk]].map(([l, v]) => `<div style="${cardOpen};padding:14px 16px"><div style="font-size:11.5px;color:var(--c-muted);text-transform:uppercase;letter-spacing:.5px">${l}</div><div style="font-size:26px;font-weight:400;margin:6px 0 8px;color:${metColor(v)}">${v}%</div><div style="height:5px;border-radius:999px;background:var(--c-sunken);overflow:hidden"><div style="height:100%;width:${v}%;background:${metColor(v)};border-radius:999px"></div></div></div>`).join("")}</div>`));
  const grid = el(`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;align-items:start"></div>`); c.appendChild(grid);
  const known = SERVICES;
  const cont = el(`<div style="${cardOpen}"><div style="${cardHead}">${t("containers")}</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--c-divider)" class="cc"></div></div>`);
  cont.querySelector(".cc").innerHTML = known.map((svc) => `<div style="background:var(--c-card);padding:12px 14px"><div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="width:8px;height:8px;border-radius:50%;background:var(--c-idle)"></span><span style="font-family:var(--font-mono);font-size:13px;font-weight:500">${esc(svc)}</span></div><div style="display:flex;gap:5px"><button class="iconbtn-sm" data-svc="${svc}" data-a="restart" style="flex:1" title="Restart">${ic("restart", 13)}</button><button class="iconbtn-sm" data-svc="${svc}" data-a="stop" style="flex:1" title="Stop">${ic("stop", 12)}</button><button class="iconbtn-sm" data-svc="${svc}" data-a="status" style="flex:1" title="Status">${ic("wave", 13)}</button></div></div>`).join("");
  cont.querySelectorAll("[data-svc]").forEach((b) => (b.onclick = () => { const svc = b.dataset.svc, a = b.dataset.a; if (a === "status") action("container_control", { server: name, service: svc, action: "status" }); else verifyAction({ name: "container_control", title: `${a} ${svc} on ${name}`, destructive: true }, { server: name, service: svc, action: a }); }));
  const logc = el(`<div style="${cardOpen};display:flex;flex-direction:column"><div style="${cardHead};display:flex;align-items:center;justify-content:space-between">${t("logs")}<button class="btn btn-sm" data-load>${t("refresh")}</button></div><div class="log-view" style="height:420px">click refresh to tail logs…</div></div>`);
  logc.querySelector("[data-load]").onclick = async () => { const lv = logc.querySelector(".log-view"); lv.textContent = "loading…"; try { const r = await runTool("adpix_logs", { server: name, lines: 120 }); lv.innerHTML = String(r.result).split("\n").map((l) => `<div class="row"><span style="color:var(--c-text)">${esc(l)}</span></div>`).join(""); lv.scrollTop = lv.scrollHeight; } catch (e) { lv.textContent = e.message; } };
  grid.append(cont, logc);
};

// ============================================================ DATABASES
SCREENS.databases = (c) => {
  let eng = "ch";
  const draw = async () => {
    c.innerHTML = H(STR[S.lang].nav.databases, "Health, tuning, and retention for Postgres + ClickHouse.", bigBtn("opt", "Optimize", "bolt"));
    c.appendChild(el(`<div class="seg"><button class="${eng === "pg" ? "on" : ""}" data-e="pg" style="font-family:var(--font-mono)">Postgres</button><button class="${eng === "ch" ? "on" : ""}" data-e="ch" style="font-family:var(--font-mono)">ClickHouse</button></div>`));
    c.querySelectorAll("[data-e]").forEach((b) => (b.onclick = () => { eng = b.dataset.e; draw(); }));
    c.querySelector('[data-act="opt"]').onclick = () => action(`${eng}_optimize`, { apply: false });
    const stats = el(`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:14px;margin-bottom:16px"><div class="skel" style="height:80px"></div></div>`); c.appendChild(stats);
    const grid = el(`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:16px;align-items:start"></div>`); c.appendChild(grid);
    const tune = el(`<div style="${cardOpen}"><div style="padding:14px 16px;border-bottom:1px solid var(--c-divider)"><div style="font-weight:500;font-size:14px">Tune settings</div><div style="font-size:12.5px;color:var(--c-muted);margin-top:3px">Review the before → after diff, then apply. Applying restarts the engine.</div></div><div class="tunebody"><div class="card-pad"><div class="skel" style="width:60%"></div></div></div><div style="display:flex;justify-content:flex-end;padding:13px 16px;background:var(--c-sunken)"><button class="btn btn-primary btn-sm" data-apply>Apply tuning</button></div></div>`);
    const ret = el(`<div style="${cardOpen}"><div style="padding:14px 16px;border-bottom:1px solid var(--c-divider)"><div style="font-weight:500;font-size:14px">Retention policy</div><div style="font-size:12.5px;color:var(--c-muted);margin-top:3px">Drops partitions older than the window. This is permanent.</div></div><div style="padding:18px 16px">${eng === "ch" ? `<label style="display:block;font-size:12px;font-weight:500;color:var(--c-muted);margin-bottom:6px">Keep data for</label><div style="display:flex;gap:8px;margin-bottom:18px"><input value="12" class="rmon" style="width:80px;height:40px;padding-inline:12px;border:1.5px solid var(--c-border);border-radius:8px;background:var(--c-card);color:var(--c-text);font:inherit;font-family:var(--font-mono);font-size:13px;outline:none"/><div style="flex:1;height:40px;display:flex;align-items:center;padding-inline:12px;border:1.5px solid var(--c-border);border-radius:8px;color:var(--c-muted);font-size:13px">months</div></div><div style="display:flex;gap:10px;background:var(--c-neg-bg);border:1px solid var(--c-neg);border-radius:10px;padding:13px 14px;margin-bottom:16px"><span style="color:var(--c-neg);flex:none">${ic("warn", 18)}</span><div style="font-size:12.5px;line-height:1.5">This TTL permanently deletes partitions older than the window.</div></div><button class="btn btn-danger" data-ret style="width:100%;justify-content:center">Apply retention</button>` : `<div class="muted">Retention applies to ClickHouse (raw events). Switch to the ClickHouse tab.</div>`}</div></div>`);
    grid.append(tune, ret);
    tune.querySelector("[data-apply]").onclick = () => verifyAction({ name: `${eng}_tune`, title: `Apply ${eng} tuning (restarts engine)`, destructive: true }, { apply: true });
    const ra = ret.querySelector("[data-ret]"); if (ra) ra.onclick = () => verifyAction({ name: "ch_retention", title: "Apply ClickHouse retention (drops old partitions)", destructive: true }, { mode: "apply", months: Number(ret.querySelector(".rmon").value) });
    try {
      const d = await api(`/api/db?engine=${eng}` + (S.cluster ? "&cluster=" + encodeURIComponent(S.cluster) : ""));
      if (d.error) { stats.innerHTML = `<div style="${cardOpen};padding:14px 16px;grid-column:1/-1"><pre class="out" style="color:var(--c-neg)">${esc(d.error)}</pre></div>`; tune.querySelector(".tunebody").innerHTML = `<div class="empty">Unavailable.</div>`; return; }
      stats.innerHTML = d.stats.length ? d.stats.map((s) => `<div style="${cardOpen};padding:14px 16px"><div style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--c-muted)"><span style="width:6px;height:6px;border-radius:50%;background:var(--c-${s.level})"></span>${esc(s.label)}</div><div style="font-size:22px;font-weight:400;margin-top:7px;font-family:var(--font-mono);color:var(--c-${s.level})">${esc(s.value)}</div></div>`).join("") : `<div class="empty" style="grid-column:1/-1">No stats — is the ${eng === "pg" ? "Postgres" : "ClickHouse"} stack up?</div>`;
      const tb = tune.querySelector(".tunebody");
      const tcols = "1.5fr 1fr auto 1fr .6fr";
      tb.innerHTML = d.tune.length
        ? `<div style="display:grid;grid-template-columns:${tcols};gap:8px;padding:9px 16px;border-bottom:1px solid var(--c-border);font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:var(--c-hint)"><span>Setting</span><span style="text-align:end">Current</span><span></span><span>Recommended</span><span style="text-align:end">Restart</span></div>`
          + d.tune.map((r) => { const changed = r.current !== r.recommended; return `<div style="display:grid;grid-template-columns:${tcols};gap:8px;align-items:center;padding:9px 16px;border-bottom:1px solid var(--c-divider);font-family:var(--font-mono);font-size:12px"><span>${esc(r.setting)}</span><span style="text-align:end;color:var(--c-muted);${changed ? "text-decoration:line-through" : ""}">${esc(r.current)}</span><span style="color:var(--c-hint)">→</span><span style="color:${changed ? "var(--c-pos)" : "var(--c-muted)"};font-weight:500">${esc(r.recommended)}</span><span style="text-align:end">${r.restart ? `<span class="tag">restart</span>` : ""}</span></div>`; }).join("")
        : `<div class="empty">No tuning recommendations.</div>`;
    } catch (e) { stats.innerHTML = `<div style="${cardOpen};padding:14px 16px;grid-column:1/-1"><pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre></div>`; }
  };
  draw();
};

// ============================================================ remaining screens (faithful, tool-driven)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// run a tool for DISPLAY: sync if read-only; if the server says it's not read-only (409), run
// it as a (non-destructive) job and wait for the result. Returns the result text.
async function runDisplay(tool, args = {}) {
  try { return (await runTool(tool, args)).result; }
  catch (e) {
    if (e.status !== 409) throw e;
    const { job } = await startJob(tool, args);
    for (let i = 0; i < 80; i++) { await sleep(150); const { job: j } = await api(`/api/jobs/${job.id}`); if (j.status !== "running" && j.status !== "queued") return j.result || j.error || ""; }
    return "timed out waiting for the job";
  }
}
// friendly rendering: clean empty states instead of raw "No servers configured" errors
function renderResult(text, body) {
  const s = String(text || "");
  if (/No servers (registered|configured)|ERROR \([^)]*\):\s*No servers/i.test(s)) { body.innerHTML = emptyState("No servers yet", "Add a server to populate this view.", "add"); wireEmpty(body); return; }
  if (/No clusters? (defined|configured)/i.test(s)) { body.innerHTML = emptyState("No cluster yet", "Define a cluster — a witness plus the serving nodes.", "ha"); wireEmpty(body); return; }
  body.innerHTML = `<pre class="out"${/^ERROR \(/.test(s) ? ' style="color:var(--c-neg)"' : ""}>${esc(s)}</pre>`;
}
function emptyState(title, sub, goto) { return `<div class="empty"><div style="font-weight:600;color:var(--c-text);margin-bottom:4px">${esc(title)}</div><div style="margin-bottom:14px">${esc(sub)}</div><button class="btn btn-primary btn-sm" data-empty="${goto}">${goto === "add" ? "+ Add server" : "Go to " + (STR[S.lang].nav[goto] || goto)}</button></div>`; }
function wireEmpty(body) { const b = body.querySelector("[data-empty]"); if (b) b.onclick = () => { if (b.dataset.empty === "add") addServerWizard(); else { S.screen = b.dataset.empty; render(); } }; }

function toolPanel(title, tool, args = {}) {
  const card = el(`<div style="${cardOpen}"><div style="${cardHead};display:flex;align-items:center;justify-content:space-between">${esc(title)}<button class="btn btn-sm refresh">${t("refresh")}</button></div><div class="card-pad"><div class="body"><div class="skel" style="width:70%"></div><div class="skel" style="width:50%;margin-top:8px"></div></div></div></div>`);
  const body = card.querySelector(".body");
  const load = async () => { body.innerHTML = `<div class="skel" style="width:60%"></div>`; try { renderResult(await runDisplay(tool, args), body); } catch (e) { body.innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre>`; } };
  card.querySelector(".refresh").onclick = load; load(); return card;
}
// structured grid table (cols = grid-template-columns; rows = arrays of pre-formatted cell HTML)
function gridTable(cols, headers, rows, empty = "No rows.") {
  return `<div class="gridhead" style="grid-template-columns:${cols}">${headers.map((h, i) => `<span${i === headers.length - 1 ? ' style="text-align:end"' : ""}>${esc(h)}</span>`).join("")}</div>` +
    (rows.length ? rows.map((r) => `<div style="display:grid;grid-template-columns:${cols};gap:12px;align-items:center;padding:11px 16px;border-bottom:1px solid var(--c-divider);font-size:12.5px">${r.join("")}</div>`).join("") : `<div class="empty">${esc(empty)}</div>`);
}
// data panel backed by a structured /api aggregator (cluster-scoped). render(d) → innerHTML string.
function dataPanel(title, url, render, headerExtra = "") {
  const card = el(`<div style="${cardOpen}"><div style="${cardHead};display:flex;align-items:center;justify-content:space-between"><span>${esc(title)}</span><span style="display:flex;align-items:center;gap:8px">${headerExtra}<button class="btn btn-sm refresh">${t("refresh")}</button></span></div><div class="body"><div class="card-pad"><div class="skel" style="width:60%"></div></div></div></div>`);
  const body = card.querySelector(".body");
  const load = async () => {
    body.innerHTML = `<div class="card-pad"><div class="skel" style="width:60%"></div></div>`;
    try { const u = url + (S.cluster ? (url.includes("?") ? "&" : "?") + "cluster=" + encodeURIComponent(S.cluster) : ""); const d = await api(u); body.innerHTML = d.error ? `<div class="card-pad"><pre class="out" style="color:var(--c-neg)">${esc(d.error)}</pre></div>` : render(d); }
    catch (e) { body.innerHTML = `<div class="card-pad"><pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre></div>`; }
  };
  card.querySelector(".refresh").onclick = load; load(); return card;
}
async function action(tool, args = {}) { try { const r = await startJob(tool, args); toast(`Started ${tool}`); openDrawer(r.job.id); } catch (e) { toast(e.message, true); } }

SCREENS.deploys = (c) => {
  c.innerHTML = H(STR[S.lang].nav.deploys, "Releases, rollback, and blue-green across the cluster.");
  const g = el(`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;align-items:start"></div>`); c.appendChild(g);
  const left = el(`<div style="display:flex;flex-direction:column;gap:16px"></div>`);
  const cur = el(`<div style="${cardOpen};padding:18px 20px"><div style="font-size:12px;color:var(--c-muted);text-transform:uppercase;letter-spacing:.5px">Current deploy</div><div class="verbody" style="margin:10px 0 14px"><div class="skel" style="width:50%"></div></div><div style="display:flex;gap:8px">${bigBtn("u", "Update", null, true)}${bigBtn("bg", "Blue-green")}${bigBtn("rb", "Rollback")}</div></div>`);
  cur.querySelector('[data-act="u"]').onclick = async () => { const an = (await ensureStacks()).find((x) => x.stack === "analytics"); if (an && !an.installed) return installForm("analytics"); action("adpix_update"); };
  cur.querySelector('[data-act="bg"]').onclick = () => verifyAction({ name: "bluegreen_deploy", title: "Blue-green deploy across the cluster", destructive: true }, {});
  cur.querySelector('[data-act="rb"]').onclick = () => verifyAction({ name: "adpix_update", title: "Rollback (redeploy the previous build)", destructive: false }, {});
  const cicd = el(`<div style="${cardOpen}"><div style="${cardHead};display:flex;align-items:center;justify-content:space-between">CI / CD pipeline<button class="btn btn-sm refresh">${t("refresh")}</button></div><div class="ccbody"><div class="card-pad"><div class="skel" style="width:60%"></div></div></div></div>`);
  const stacks = el(`<div style="${cardOpen}"><div style="${cardHead};display:flex;align-items:center;justify-content:space-between">Deploy from GitHub<button class="btn btn-sm refresh">${t("refresh")}</button></div><div class="card-pad"><div class="muted" style="font-size:12.5px;margin-bottom:12px;line-height:1.5">Fresh server? <b>Install</b> provisions the full stack (clone + .env + Docker + compose up + migrate). Already installed? <b>Update</b> recreates <b>only stateless</b> services + runs migrations — datastores (postgres / clickhouse / redis / minio) and their volumes are never touched.</div><div class="rows"><div class="skel" style="width:70%"></div></div><label style="display:flex;align-items:center;gap:7px;font-size:12px;margin-top:12px;color:var(--c-muted);cursor:pointer"><input type="checkbox" id="bkf"> Back up Analytics before migrating (updates only)</label></div></div>`);
  const stackPill = (x) => !x.installed ? pill("not installed", "idle") : x.behind === 0 ? pill("up to date", "pos") : x.behind === "?" ? pill("origin unreachable", "idle") : pill(`${x.behind} behind`, "warn");
  const loadStacks = async () => {
    try {
      const arr = await api("/api/stacks"); STACKS_STATUS = arr;
      const rows = stacks.querySelector(".rows");
      rows.innerHTML = arr.map((x) => {
        const act = x.stack === "idp"
          ? `<button class="btn btn-sm" data-idp="1">Update IdP…</button>`
          : x.installed
            ? `<button class="btn btn-sm" data-up="${esc(x.stack)}">${ic("deploys", 13)} Update${typeof x.behind === "number" && x.behind > 0 ? ` · ${x.behind}` : ""}</button>`
            : `<button class="btn btn-sm btn-primary" data-inst="${esc(x.stack)}">${ic("deploys", 13)} Install</button>`;
        return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--c-divider)"><div style="min-width:0"><b style="text-transform:capitalize">${esc(x.stack)}</b>${x.installed ? ` <span class="mono muted" style="font-size:11.5px">${esc(x.commit)}${x.branch ? " · " + esc(x.branch) : ""}</span>` : ""}</div><div style="display:flex;align-items:center;gap:10px;flex:none">${stackPill(x)}${act}</div></div>`;
      }).join("");
      rows.querySelectorAll("[data-up]").forEach((b) => (b.onclick = () => verifyAction({ name: "stack_update", title: `Update the ${b.dataset.up} stack — stateless-only + migrations (datastores preserved)`, destructive: true }, { stack: b.dataset.up, statelessOnly: true, ...(b.dataset.up === "analytics" && stacks.querySelector("#bkf").checked ? { backupFirst: true } : {}) })));
      rows.querySelectorAll("[data-inst]").forEach((b) => (b.onclick = () => installForm(b.dataset.inst)));
      const idpb = rows.querySelector("[data-idp]"); if (idpb) idpb.onclick = idpUpdateForm;
    } catch (e) { stacks.querySelector(".rows").innerHTML = `<div class="muted" style="font-size:12px">${esc(e.message)}</div>`; }
  };
  stacks.querySelector(".refresh").onclick = loadStacks;
  left.append(cur, cicd, stacks); loadStacks();
  const right = el(`<div></div>`);
  right.innerHTML = (S.fleet && (S.fleet.nodes.length || S.fleet.cluster.name)) ? `<div style="${cardOpen}">${topologyCard(S.fleet)}</div>` : `<div style="${cardOpen}"><div style="${cardHead}">Cluster topology</div><div class="empty">No cluster defined.</div></div>`;
  g.append(left, right);
  const load = async () => {
    try {
      const d = await api("/api/deploys");
      cur.querySelector(".verbody").innerHTML = d.error ? `<span class="muted" style="font-size:13px">${esc(d.error)}</span>` : `<div style="display:flex;align-items:baseline;gap:10px"><span style="font-size:22px;font-weight:400">${esc(d.version.hash || "—")}</span><span class="mono muted" style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.version.subject || "")}</span></div><div style="display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--c-muted);margin-top:6px">${d.autoRollback ? `<span style="color:var(--c-pos)">${ic("check", 14)}</span> auto-rollback on a failed health check` : "auto-rollback off"}${d.version.behind !== "?" && d.version.behind > 0 ? ` · <span style="color:var(--c-warn);font-weight:500">${d.version.behind} behind</span>` : ""}</div>`;
      const cc = cicd.querySelector(".ccbody");
      if (d.error) { cc.innerHTML = `<div class="card-pad"><pre class="out" style="color:var(--c-neg)">${esc(d.error)}</pre></div>`; return; }
      const head = `<div style="display:flex;gap:0;border-bottom:1px solid var(--c-divider)"><div style="flex:1;padding:14px 16px;border-inline-end:1px solid var(--c-divider)"><div style="font-size:11.5px;color:var(--c-muted)">Timer</div><div style="margin-top:5px;font-size:13.5px">${d.timer.enabled ? pill("enabled", "pos") : pill("disabled", "idle")}${d.timer.next ? `<span class="mono muted" style="font-size:11.5px;margin-inline-start:8px">next ${esc(d.timer.next)}</span>` : ""}</div></div><div style="flex:1;padding:14px 16px"><div style="font-size:11.5px;color:var(--c-muted)">Last run</div><div style="margin-top:5px;font-size:13.5px">${d.timer.lastRun ? pill(d.timer.lastRun.result, d.timer.lastRun.result) : `<span class="muted">none yet</span>`}</div></div></div>`;
      const hist = d.history.length ? `<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--c-hint);padding:10px 16px 6px">Deploy history</div>` + d.history.map((h) => `<div style="display:flex;align-items:center;gap:11px;padding:9px 16px"><span style="width:9px;height:9px;border-radius:50%;border:2px solid var(--c-${sc(h.result)});flex:none"></span><span class="mono" style="font-size:13px;font-weight:500;width:70px">${esc(h.hash || "—")}</span><span style="font-size:12.5px;color:var(--c-${sc(h.result)});flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(h.subject || h.result || "")}</span><span style="font-size:11.5px;color:var(--c-hint)">${esc(h.when)}</span></div>`).join("") : `<div class="empty">No deploys recorded yet.</div>`;
      cc.innerHTML = head + `<div style="padding:6px 0">${hist}</div>`;
    } catch (e) { cur.querySelector(".verbody").innerHTML = `<span class="muted">${esc(e.message)}</span>`; cicd.querySelector(".ccbody").innerHTML = `<div class="card-pad"><pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre></div>`; }
  };
  cicd.querySelector(".refresh").onclick = load; load();
};
SCREENS.ha = (c) => {
  c.innerHTML = H(STR[S.lang].nav.ha, "Witness-anchored quorum: VIP, Postgres, Redis, ClickHouse.", `${bigBtn("standup", "Set up HA")}${bigBtn("fail", "Promote standby")}`);
  c.querySelector('[data-act="standup"]').onclick = () => verifyAction({ name: "ha_standup", title: "Set up the HA cluster (first-time provisioning)", destructive: true }, { mode: "keepalived" });
  c.querySelector('[data-act="fail"]').onclick = () => confirmDanger("Promote standby — emergency failover", `Promote the Postgres standby to PRIMARY. <b>Recovery only</b> — use this when the current primary is lost. Never during normal operation: a double-promote causes split-brain. Confirm by typing the cluster name.`, S.fleet?.cluster?.name || S.cluster || "", async () => { await startDestructive("pg_replication", { mode: "promote" }); toast("Failover (promote) started"); openDrawer(); }, "Promote standby");
  c.appendChild(el(`<div style="${cardOpen};margin-bottom:16px;padding:14px 16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px">
    <div><div style="font-weight:600;font-size:13px;margin-bottom:4px;display:flex;align-items:center;gap:7px">${ic("ha", 14)} Set up HA — first time</div><div class="muted" style="font-size:12.5px;line-height:1.5">Builds the witness-anchored quorum across this cluster's nodes: floating <b>VIP</b>, Postgres streaming replication, Redis Sentinel, ClickHouse Keeper. Run it <b>once</b> when first building the cluster (needs a witness + ≥2 nodes). Idempotent.</div></div>
    <div><div style="font-weight:600;font-size:13px;margin-bottom:4px;display:flex;align-items:center;gap:7px;color:var(--c-neg)">${ic("warn", 14)} Promote standby — emergency</div><div class="muted" style="font-size:12.5px;line-height:1.5">Promotes the Postgres <b>standby → primary</b> when the current primary is lost. <b>Recovery only</b>, never during normal operation — a double-promote causes split-brain.</div></div>
  </div>`));
  if (S.fleet && (S.fleet.nodes.length || S.fleet.cluster.name)) c.appendChild(el(`<div style="${cardOpen};margin-bottom:16px">${topologyCard(S.fleet)}</div>`));
  c.appendChild(dataPanel("Quorum status", "/api/ha", (d) => {
    const head = `<div style="padding:9px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--c-divider)">${pill(cap(d.verdict), d.verdict)}${d.vip ? `<span class="mono muted" style="font-size:12px">VIP ${esc(d.vip)}</span>` : ""}</div>`;
    const tbl = gridTable("1fr .7fr 1fr 1.1fr .7fr 1fr", ["Member", "Role", "Postgres", "Redis", "Sentinel", "ClickHouse"],
      d.members.map((m) => [`<span class="mono" style="font-weight:500">${esc(m.name)}</span>`, `<span class="muted">${esc(m.role)}</span>`, `<span class="mono ${m.postgres === "primary" ? "" : "muted"}">${esc(m.postgres)}</span>`, `<span class="mono muted" style="font-size:11.5px">${esc(m.redis)}</span>`, m.sentinel ? `<span style="color:var(--c-pos)">yes</span>` : `<span class="muted">no</span>`, `<span class="mono muted" style="font-size:11.5px">${esc(m.ch)}</span>`]), "No members — define a cluster.");
    const finds = d.findings.length ? `<div style="padding:12px 16px">${d.findings.map((f) => `<div style="display:flex;gap:8px;padding:4px 0;font-size:12.5px"><span style="color:var(--c-${/SPLIT|no writer|read-only|UNREACH/i.test(f) ? "neg" : "warn"});flex:none">${ic("warn", 14)}</span><span>${esc(f)}</span></div>`).join("")}</div>` : "";
    return head + tbl + finds;
  }));
};
SCREENS.dns = (c) => {
  c.innerHTML = H(STR[S.lang].nav.dns, "Required DNS records and client connection configs.");
  c.appendChild(dataPanel("Required DNS records", "/api/dns", (d) => gridTable("1.3fr .6fr 1.7fr .5fr .7fr .8fr", ["Name", "Type", "Value", "TTL", "Proxied", "Zone"],
    d.records.map((r) => [
      `<span class="mono">${esc(r.name)}</span>`,
      `<span class="mono" style="color:var(--c-brand);font-weight:500">${esc(r.type)}</span>`,
      `<span class="mono muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.value)}</span>`,
      `<span class="muted">${r.ttl}</span>`,
      r.proxied ? `<span style="color:var(--c-pos);font-weight:500">proxied</span>` : `<span class="muted">direct</span>`,
      `<span class="muted">${esc(r.zone)}</span>`,
    ]), "No DNS records — define a cluster with hosts.")));
  const x = el(`<div style="margin-top:16px"></div>`); c.appendChild(x); x.appendChild(toolPanel("Client connect configs", "connect_configs"));
};
SCREENS.monitoring = (c) => {
  c.innerHTML = H(STR[S.lang].nav.monitoring, "Front-door health, TLS expiry, host metrics.");
  const g = el(`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;align-items:start;margin-bottom:16px"></div>`); c.appendChild(g);
  const probesCard = el(`<div style="${cardOpen}"><div style="${cardHead};display:flex;align-items:center;justify-content:space-between">Health probes<button class="btn btn-sm refresh">${t("refresh")}</button></div><div class="pbody"><div class="card-pad"><div class="skel" style="width:60%"></div></div></div></div>`);
  const certsCard = el(`<div style="${cardOpen}"><div style="${cardHead}">TLS certificates</div><div class="cbody"><div class="card-pad"><div class="skel" style="width:50%"></div></div></div></div>`);
  g.append(probesCard, certsCard);
  const hostsCard = el(`<div style="${cardOpen};margin-bottom:16px"><div style="${cardHead}">Host metrics</div><div class="hbody"></div></div>`);
  c.appendChild(hostsCard);
  hostsCard.querySelector(".hbody").innerHTML = (S.fleet?.nodes || []).length ? S.fleet.nodes.map((n) => nodeHealthRow(n)).join("") : `<div class="empty">No servers — host metrics appear once a server is added.</div>`;
  const load = async () => {
    probesCard.querySelector(".pbody").innerHTML = `<div class="card-pad"><div class="skel" style="width:60%"></div></div>`;
    try {
      const d = await api("/api/monitoring" + (S.cluster ? "?cluster=" + encodeURIComponent(S.cluster) : ""));
      if (d.error) { probesCard.querySelector(".pbody").innerHTML = `<div class="card-pad"><pre class="out" style="color:var(--c-neg)">${esc(d.error)}</pre></div>`; certsCard.querySelector(".cbody").innerHTML = `<div class="empty">Unavailable.</div>`; return; }
      probesCard.querySelector(".pbody").innerHTML = gridTable("1.4fr 1fr .6fr .7fr .5fr", ["Route", "Service", "HTTP", "TTFB", ""],
        d.probes.map((p) => [`<span class="mono" style="font-weight:500">${esc(p.path)}</span>`, `<span class="muted">${esc(p.service)}</span>`, `<span class="mono" style="color:var(--c-${p.ok ? "pos" : "neg"})">${esc(p.http)}</span>`, `<span class="mono muted">${p.ms}ms</span>`, `<span style="text-align:end"><span class="dot" style="display:inline-block;background:var(--c-${p.ok ? "pos" : "neg"})"></span></span>`]), "No probes.");
      certsCard.querySelector(".cbody").innerHTML = d.certs.length ? d.certs.map((cert) => `<div style="display:flex;align-items:center;gap:11px;padding:13px 16px;border-bottom:1px solid var(--c-divider)"><span style="color:var(--c-${cert.level});flex:none">${ic("lock", 16)}</span><span style="flex:1;font-family:var(--font-mono);font-size:12.5px">${esc(cert.host)}</span><span style="font-size:11.5px;color:var(--c-${cert.level});font-weight:500">${cert.days < 0 ? "expired" : `expires in ${cert.days}d`}</span></div>`).join("") : `<div class="empty">No certificates — define cluster hosts.</div>`;
    } catch (e) { probesCard.querySelector(".pbody").innerHTML = `<div class="card-pad"><pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre></div>`; }
  };
  probesCard.querySelector(".refresh").onclick = load; load();
  const m = el(`<div style="${cardOpen}"><div style="${cardHead};display:flex;align-items:center;justify-content:space-between">PromQL query<span style="font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;background:var(--c-warn-bg);color:var(--c-warn)">metrics_query</span></div><div class="card-pad"><label class="fld"><span class="lab">PromQL (against the witness Prometheus)</span><input class="input mono" id="pq" value="up"></label><button class="btn btn-primary btn-sm" id="pr">Run</button><div class="po" style="margin-top:10px"></div></div></div>`);
  c.appendChild(m); m.querySelector("#pr").onclick = async () => { const o = m.querySelector(".po"); o.innerHTML = `<span class="spin"></span>`; try { const r = await runTool("metrics_query", { query: m.querySelector("#pq").value }); o.innerHTML = `<pre class="out">${esc(r.result)}</pre>`; } catch (e) { o.innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre>`; } };
};
SCREENS.security = (c) => {
  c.innerHTML = H(STR[S.lang].nav.security, "Audit findings, hardening, patching, launch gate.", `${bigBtn("h", "Harden (dry-run)")}${bigBtn("p", "Apply patches", null, true)}`);
  c.querySelector('[data-act="h"]').onclick = () => action("harden_server", { apply: false });
  c.querySelector('[data-act="p"]').onclick = () => verifyAction({ name: "patch_system", title: "Apply system patches", destructive: true }, {});
  const wrap = el(`<div style="display:flex;flex-direction:column;gap:16px"></div>`); c.appendChild(wrap);
  const gateCard = el(`<div style="${cardOpen}"><div style="${cardHead};display:flex;align-items:center;justify-content:space-between">Launch gate<button class="btn btn-sm refresh">${t("refresh")}</button></div><div class="card-pad gbody"><div class="skel" style="width:50%"></div></div></div>`);
  const auditCard = el(`<div style="${cardOpen}"><div style="${cardHead};display:flex;align-items:center;gap:14px"><span style="flex:none;font-weight:500">Security audit</span><div class="scorewrap" style="flex:1"></div><span class="scoretext mono muted" style="flex:none;font-size:11.5px"></span></div><div class="abody"><div class="card-pad"><div class="skel" style="width:60%"></div></div></div></div>`);
  wrap.append(gateCard, auditCard);
  const load = async () => {
    try {
      const d = await api("/api/security" + (S.cluster ? "?cluster=" + encodeURIComponent(S.cluster) : ""));
      if (d.error) { gateCard.querySelector(".gbody").innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(d.error)}</pre>`; auditCard.querySelector(".abody").innerHTML = `<div class="empty">Audit unavailable.</div>`; return; }
      const g = d.launchGate;
      gateCard.querySelector(".gbody").innerHTML = `<div style="display:flex;align-items:center;gap:10px${g.blockers.length ? ";margin-bottom:12px" : ""}">${g.cleared ? pill("cleared", "pos") : pill("blocked", "neg")}${g.reference ? `<span class="mono muted" style="font-size:12px">ref ${esc(g.reference)}</span>` : ""}</div>`
        + (g.blockers.length ? `<div style="font-size:12.5px;color:var(--c-muted);margin-bottom:6px">${g.blockers.length} release-blocker(s) before go-live:</div>` + g.blockers.map((b) => `<div style="display:flex;gap:8px;padding:6px 0;font-size:12.5px"><span style="color:var(--c-neg);flex:none">${ic("warn", 14)}</span><span>${esc(b)}</span></div>`).join("") : `<div class="muted" style="font-size:12.5px">No blockers — cleared for go-live.</div>`);
      const total = d.counts.pass + d.counts.warn + d.counts.fail || 1;
      auditCard.querySelector(".scorewrap").innerHTML = `<div style="display:flex;height:7px;border-radius:999px;overflow:hidden;background:var(--c-sunken)"><div style="width:${d.counts.pass / total * 100}%;background:var(--c-pos)"></div><div style="width:${d.counts.warn / total * 100}%;background:var(--c-warn)"></div><div style="width:${d.counts.fail / total * 100}%;background:var(--c-neg)"></div></div>`;
      auditCard.querySelector(".scoretext").textContent = `${d.counts.pass} pass · ${d.counts.warn} warn · ${d.counts.fail} fail`;
      auditCard.querySelector(".abody").innerHTML = d.findings.length ? d.findings.map((f) => { const k = f.level === "PASS" ? "pos" : f.level === "WARN" ? "warn" : "neg"; return `<div style="display:flex;align-items:flex-start;gap:12px;padding:13px 16px;border-bottom:1px solid var(--c-divider)"><span style="width:22px;height:22px;border-radius:50%;background:var(--c-${k}-bg);color:var(--c-${k});display:grid;place-items:center;flex:none;font-size:11px;font-weight:700;margin-top:1px">${f.level[0]}</span><div style="flex:1;min-width:0;font-size:13px">${esc(f.what)}</div><span style="font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;background:var(--c-${k}-bg);color:var(--c-${k})">${f.level}</span></div>`; }).join("") : `<div class="empty">No findings — add a server to audit.</div>`;
    } catch (e) { gateCard.querySelector(".gbody").innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre>`; }
  };
  gateCard.querySelector(".refresh").onclick = load; load();
};
SCREENS.jobs = async (c) => {
  c.innerHTML = H(STR[S.lang].nav.jobs, "Live jobs and the immutable audit trail.", `<button class="btn btn-sm" data-r>${t("refresh")}</button>`);
  const live = el(`<div style="${cardOpen};margin-bottom:16px"><div style="${cardHead}">Live jobs</div><div class="lj"><div class="card-pad"><div class="skel" style="width:50%"></div></div></div></div>`); c.appendChild(live);
  const audit = el(`<div style="${cardOpen}"><div style="${cardHead};display:flex;align-items:center;gap:8px">${ic("security", 15)} Audit log<span class="hint" style="margin-inline-start:auto">Immutable · hash-chained</span></div><div class="au"></div></div>`); c.appendChild(audit);
  const lj = async () => { try { const { jobs } = await listJobs(); live.querySelector(".lj").innerHTML = jobs.length ? jobs.slice(0, 30).map((j) => `<div style="padding:13px 16px;border-bottom:1px solid var(--c-divider)"><div style="display:flex;align-items:center;gap:11px"><span style="width:9px;height:9px;border-radius:50%;background:var(--c-${sc(j.status)});${j.status === "running" ? "animation:pulse-dot 1.4s infinite" : ""}"></span><span style="font-family:var(--font-mono);font-size:13px;font-weight:500;flex:1">${esc(j.tool)}</span><span style="font-family:var(--font-mono);font-size:11.5px;color:var(--c-muted)">${esc(j.key === "_global" ? "" : j.key)} · ${esc(j.id.slice(0, 8))}</span>${pill(j.status, j.status)}<button class="btn btn-sm" data-v="${j.id}">View</button></div></div>`).join("") : `<div class="empty">${t("noJobs")}</div>`; live.querySelectorAll("[data-v]").forEach((b) => (b.onclick = () => openDrawer(b.dataset.v))); } catch (e) { live.querySelector(".lj").innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre>`; } };
  c.querySelector("[data-r]").onclick = lj; lj();
  if (S.me.role === "owner") { try { const { entries, chain } = await api("/api/admin/audit"); audit.querySelector(".au").innerHTML = `<div style="padding:8px 16px">${chain.ok ? pill("chain intact", "pos") : pill("TAMPERED @ " + chain.brokenAtSeq, "neg")}</div>` + entries.slice(0, 40).map((e) => `<div style="display:grid;grid-template-columns:.5fr 1fr 1.4fr 1fr .8fr;gap:12px;align-items:center;padding:11px 16px;border-bottom:1px solid var(--c-divider);font-size:12.5px"><span class="muted">${e.seq}</span><span class="mono">${esc(e.actor)}</span><span class="mono" style="font-size:11.5px">${esc(e.tool)}</span><span>${esc(e.target)}</span><span style="text-align:end" class="muted">${esc(e.outcome)}</span></div>`).join(""); } catch (e) { audit.querySelector(".au").innerHTML = `<div class="empty">${esc(e.message)}</div>`; } } else audit.querySelector(".au").innerHTML = `<div class="empty">Audit is owner-only.</div>`;
};
SCREENS.backups = (c) => {
  let tab = "list"; const draw = () => {
    c.innerHTML = H(STR[S.lang].nav.backups, "On-demand + scheduled snapshots.", bigBtn("create", "Create backup", "plus", true));
    c.appendChild(el(`<div class="seg"><button class="${tab === "list" ? "on" : ""}" data-t="list">Run / restore</button><button class="${tab === "sched" ? "on" : ""}" data-t="sched">Schedule</button></div>`));
    c.querySelector('[data-act="create"]').onclick = () => action("adpix_backup");
    c.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => { tab = b.dataset.t; draw(); }));
    if (tab === "list") { const g = el(`<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px"></div>`); c.appendChild(g); [["adpix_backup", "App backup", 0], ["pg_backup", "Postgres dump", 0], ["ch_backup", "ClickHouse backup", 0], ["adpix_restore", "Restore app", 1], ["pg_restore_db", "Restore Postgres", 1], ["ch_restore_db", "Restore ClickHouse", 1]].forEach(([n, l, d]) => g.appendChild(actionCardEl(n, l, !!d))); }
    else { const card = el(`<div style="${cardOpen};max-width:560px"><div style="padding:16px 20px;border-bottom:1px solid var(--c-divider)"><div style="font-weight:500;font-size:14px">Backup schedule</div><div style="font-size:12.5px;color:var(--c-muted);margin-top:3px">Verified snapshots on a systemd timer.</div></div><div style="padding:20px"><label class="fld"><span class="lab">Name</span><input class="input mono" id="sn" value="nightly-backup"></label><label class="fld"><span class="lab">OnCalendar</span><input class="input mono" id="ss" value="daily"></label></div><div style="display:flex;justify-content:flex-end;padding:14px 20px;background:var(--c-sunken)"><button class="btn btn-primary" id="sv">Save schedule</button></div></div>`); c.appendChild(card); card.querySelector("#sv").onclick = () => verifyAction({ name: "schedule_job", title: "Create a scheduled backup timer", destructive: true }, { action: "add", task: "backup", name: card.querySelector("#sn").value.trim(), schedule: card.querySelector("#ss").value.trim() }); }
  };
  draw();
};
function mcpUpdateCard() {
  const card = el(`<div style="${cardOpen};margin-bottom:16px"><div style="${cardHead};display:flex;align-items:center;justify-content:space-between">AdPix Cloud · control plane<button class="btn btn-sm refresh">${t("refresh")}</button></div><div class="card-pad body"><div class="skel" style="width:50%"></div></div></div>`);
  const body = card.querySelector(".body");
  const load = async () => {
    try {
      const d = await api("/api/mcp"); const behind = d.behind;
      body.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><div style="font-size:13.5px"><b class="mono">${esc(d.commit)}</b>${d.version ? ` · v${esc(d.version)}` : ""} <span class="muted">(${esc(d.branch)})</span></div><div class="muted" style="font-size:12.5px;margin-top:3px">${esc(d.subject || "")}</div><div style="margin-top:7px">${behind === 0 ? pill("up to date", "pos") : behind === "?" ? pill("origin unreachable", "idle") : pill(behind + " commit(s) behind", "warn")}</div></div>${S.me.role === "owner" ? `<button class="btn ${behind === 0 ? "" : "btn-primary"} upd">${behind === 0 ? "Rebuild + restart" : "Update + restart"}</button>` : ""}</div>${d.error ? `<div class="muted" style="font-size:12px;margin-top:8px">${esc(d.error)}</div>` : ""}`;
      const u = body.querySelector(".upd"); if (u) u.onclick = () => confirmDanger("Update AdPix Cloud", `Pull the latest MCP server + panel UI from GitHub, rebuild, and restart the control plane. The panel briefly disconnects and reconnects. Type <b class="mono">update</b> to confirm.`, "update", async () => { await startDestructive("mcp_self_update", {}); toast("Updating + restarting — reconnect in a moment"); openDrawer(); }, "Update + restart");
    } catch (e) { body.innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre>`; }
  };
  card.querySelector(".refresh").onclick = load; load(); return card;
}
function smtpCard() {
  const servers = (S.fleet?.nodes || []).map((n) => n.name);
  const srvField = servers.length ? selField("server", servers, "(default server)") : `<input class="input" data-k="server" placeholder="(default server)">`;
  const card = el(`<div style="${cardOpen}"><div style="${cardHead}">Email · SMTP test</div><div class="card-pad">
    <div class="muted" style="font-size:12px;line-height:1.5;margin-bottom:12px">Validate an SMTP server from a host — DNS → connect → TLS → auth → optional test send. Enter working values in the AdPix <b>admin → email</b> settings afterward (the app stores them encrypted).</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <label class="fld" style="grid-column:1/3"><span class="lab">server</span>${srvField}</label>
      <label class="fld"><span class="lab">host</span><input class="input" data-k="host" placeholder="smtp.sendgrid.net"></label>
      <label class="fld"><span class="lab">port</span><input class="input" data-k="port" data-num="1" placeholder="587"></label>
      <label class="fld"><span class="lab">security</span>${selField("security", ["starttls", "tls", "none"], "starttls (default)")}</label>
      <label class="fld"><span class="lab">from</span><input class="input" data-k="from" placeholder="no-reply@you.com"></label>
      <label class="fld"><span class="lab">username</span><input class="input" data-k="username" placeholder="(optional)"></label>
      <label class="fld"><span class="lab">password</span><input class="input" type="password" data-k="password" placeholder="(optional)"></label>
      <label class="fld" style="grid-column:1/3"><span class="lab">test recipient — send a real email</span><input class="input" data-k="to" placeholder="you@you.com — omit to stop after auth"></label>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="btn btn-primary test">Run test</button></div>
    <div class="res" style="margin-top:12px"></div>
  </div></div>`);
  card.querySelector(".test").onclick = async () => {
    const a = {}; card.querySelectorAll("[data-k]").forEach((i) => { const v = i.value.trim(); if (v) a[i.dataset.k] = i.dataset.num ? Number(v) : v; });
    if (!a.host || !a.from) return toast("host and from are required", true);
    const res = card.querySelector(".res"); const b = card.querySelector(".test"); b.disabled = true; b.innerHTML = `<span class="spin"></span>`;
    try { const r = await runTool("smtp_test", a); res.innerHTML = `<pre class="out">${esc(String(r.result))}</pre>`; }
    catch (e) { res.innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre>`; }
    finally { b.disabled = false; b.textContent = "Run test"; }
  };
  return card;
}
SCREENS.settings = (c) => {
  c.innerHTML = H(STR[S.lang].nav.settings, "Control-plane updates, admins, sessions, audit, secrets.");
  c.appendChild(mcpUpdateCard());
  const grid = el(`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:16px;align-items:start"></div>`); c.appendChild(grid);
  const a = el(`<div style="display:flex;flex-direction:column;gap:16px"></div>`), b = el(`<div style="display:flex;flex-direction:column;gap:16px"></div>`); grid.append(a, b);
  a.appendChild(smtpCard());
  if (S.me.role === "owner") { a.append(adminUsers(), adminSessions()); b.append(adminAudit(), adminKill()); }
  else a.appendChild(el(`<div style="${cardOpen};padding:16px" class="muted">Signed in as <b>${esc(S.me.username)}</b> · role <b>${esc(S.me.role)}</b>. Admin controls are owner-only.</div>`));
};

// ============================================================ generic action card
const SERVICES = ["ingest", "api", "web", "worker", "identity-job", "postgres", "clickhouse", "caddy", "redis"];
function actionCardEl(name, label, destructive) {
  const cat = S.catalog.find((x) => x.name === name);
  const title = cat?.title || label;
  const card = el(`<div style="${cardOpen};padding:16px;display:flex;flex-direction:column;gap:10px"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><strong style="font-size:14px">${esc(title)}</strong>${destructive ? pill("destructive", "neg") : `<span class="tag">job</span>`}</div><div class="mono muted" style="font-size:11.5px">${esc(name)}</div><div class="muted" style="font-size:12.5px;flex:1">${esc(label)}</div><div class="af"></div><button class="btn ${destructive ? "btn-danger" : "btn-primary"} btn-sm run">${ic("play", 14)} Run</button></div>`);
  const props = (cat?.params?.properties) || {}; const af = card.querySelector(".af"); af.appendChild(argForm(props));
  card.querySelector(".run").onclick = () => { const args = readArgs(af); if (destructive) return verifyAction({ name, title, destructive: true }, args); action(name, args); };
  return card;
}
function selField(k, opts, blank = "—", attrs = "") { return `<select class="input" data-k="${k}" ${attrs}><option value="">${esc(blank)}</option>${opts.map((o) => `<option>${esc(o)}</option>`).join("")}</select>`; }
function argForm(props) {
  const w = el(`<div></div>`);
  const servers = (S.fleet?.nodes || []).map((n) => n.name);
  const clusters = S.fleet?.cluster?.name ? [S.fleet.cluster.name] : [];
  Object.entries(props).forEach(([k, sc]) => {
    if (k === "confirm") return;
    let f;
    if (sc.enum) f = selField(k, sc.enum);
    else if (sc.type === "boolean") f = selField(k, ["true", "false"], "—", `data-bool="1"`);
    else if (k === "server" && servers.length) f = selField(k, servers, "(default server)");
    else if (k === "cluster" && clusters.length) f = selField(k, clusters, "(default cluster)");
    else if (k === "service") f = selField(k, SERVICES, "select a service");
    else if (sc.type === "number" || sc.type === "integer") f = `<input class="input" type="number" data-k="${k}" data-num="1" placeholder="${esc(sc.description ? "" : "number")}">`;
    else f = `<input class="input" data-k="${k}" ${sc.type === "array" ? `data-arr="1"` : ""} placeholder="${esc(sc.type === "array" ? "comma, separated" : "")}">`;
    const hint = sc.description ? ` · <span class="hint" style="font-weight:400">${esc(sc.description.slice(0, 52))}</span>` : "";
    w.appendChild(el(`<label class="fld"><span class="lab">${esc(k)}${hint}</span>${f}</label>`));
  });
  return w;
}
function readArgs(af) { const a = {}; af.querySelectorAll("[data-k]").forEach((i) => { const v = i.value.trim(); if (!v) return; a[i.dataset.k] = i.dataset.arr ? v.split(",").map((s) => s.trim()).filter(Boolean) : i.dataset.bool ? v === "true" : i.dataset.num ? Number(v) : v; }); return a; }

// ============================================================ slide-in panels + wizard
function slideIn(width = 440) {
  let scrim = document.querySelector(".scrim"); if (!scrim) { scrim = el(`<div class="scrim"></div>`); document.body.appendChild(scrim); }
  const panel = el(`<aside class="drawer" style="width:${width}px"></aside>`); document.body.appendChild(panel);
  const close = () => { scrim.classList.remove("show"); panel.classList.remove("show"); setTimeout(() => panel.remove(), 240); scrim.onclick = null; };
  scrim.onclick = close; requestAnimationFrame(() => { scrim.classList.add("show"); panel.classList.add("show"); });
  return { panel, close };
}
// stepper wizard. steps: [{label, body(ctx, el), onNext(ctx)->bool|err}]
function wizard(title, steps, onFinish) {
  const ctx = {}; let i = 0; const { panel, close } = slideIn(520);
  const draw = () => {
    panel.innerHTML = `<div class="drawer-head"><strong>${esc(title)}</strong><button class="icon-btn dc">${ic("x", 16)}</button></div>
      <div style="padding:16px 18px 0;display:flex;gap:6px">${steps.map((s, k) => `<div style="flex:1"><div style="height:3px;border-radius:999px;background:${k <= i ? "var(--c-brand)" : "var(--c-divider)"}"></div><div style="font-size:11.5px;margin-top:6px;color:${k === i ? "var(--c-brand)" : "var(--c-hint)"};font-weight:${k === i ? 600 : 400}">${k + 1}. ${esc(s.label)}</div></div>`).join("")}</div>
      <div class="drawer-body wbody" style="padding:18px"></div>
      <div class="werr" style="padding:0 18px 6px;color:var(--c-neg);font-size:12.5px;display:none"></div>
      <div style="display:flex;justify-content:space-between;gap:10px;padding:14px 18px;border-top:1px solid var(--c-divider);background:var(--c-sunken)">
        <button class="btn back" ${i === 0 ? "disabled" : ""}>${t("back")}</button>
        <button class="btn btn-primary nextb">${i === steps.length - 1 ? "Finish" : t("next")}</button></div>`;
    panel.querySelector(".dc").onclick = close;
    panel.querySelector(".back").onclick = () => { if (i > 0) { i--; draw(); } };
    steps[i].body(ctx, panel.querySelector(".wbody"));
    const werr = panel.querySelector(".werr");
    const fail = (msg) => { werr.textContent = msg; werr.style.display = "block"; const nb = panel.querySelector(".nextb"); nb.disabled = false; nb.textContent = i === steps.length - 1 ? "Finish" : t("next"); };
    panel.querySelector(".nextb").onclick = async () => {
      werr.style.display = "none"; const nb = panel.querySelector(".nextb"); nb.disabled = true; nb.innerHTML = `<span class="spin"></span>`;
      try { const r = steps[i].onNext ? await steps[i].onNext(ctx) : true; if (r === true) { if (i === steps.length - 1) { await onFinish(ctx); close(); } else { i++; draw(); } } else { fail(typeof r === "string" ? r : "Please complete this step."); } }
      catch (e) { fail(e.message); }
    };
  };
  draw();
}
function field(label, input) { return `<label style="display:block;margin-bottom:14px"><span style="display:block;font-size:12px;font-weight:600;color:var(--c-muted);margin-bottom:6px">${esc(label)}</span>${input}</label>`; }
function addServerWizard() {
  wizard("Add a server", [
    { label: "Connect", body: (ctx, b) => {
      b.innerHTML = `<div style="font-weight:600;font-size:15px;margin-bottom:6px">Connect to the server</div><div class="muted" style="font-size:13px;margin-bottom:16px">AdPix connects over SSH only. Use an SSH key, or the root password (used once to authorize the MCP key — the password is never stored).</div>
      ${field("Host / IP address", `<input class="input mono" id="w_host" value="${esc(ctx.host || "")}" placeholder="10.0.0.13">`)}
      ${field("SSH port & user", `<div style="display:flex;gap:10px"><input class="input mono" id="w_port" value="${esc(ctx.port || "22")}" style="width:90px"><input class="input mono" id="w_user" value="${esc(ctx.user || "root")}" style="flex:1"></div>`)}
      ${field("Authentication", `<select class="input" id="w_auth"><option value="key">SSH private key (path)</option><option value="password">Root password</option></select>`)}
      <div id="w_authfield"></div>`;
      b.querySelector("#w_auth").value = ctx.authMethod || "key";
      const drawAuth = () => { const m = b.querySelector("#w_auth").value; b.querySelector("#w_authfield").innerHTML = m === "password"
        ? field("Root password", `<input class="input" type="password" id="w_pw" value="${esc(ctx.password || "")}"><div class="hint" style="margin-top:5px;font-size:11.5px">Used once to authorize the MCP key on the host, then discarded — never stored.</div>`)
        : field("Private key", `<textarea class="input mono" id="w_keypaste" rows="5" placeholder="Paste the OpenSSH private key (-----BEGIN OPENSSH PRIVATE KEY----- …)" style="resize:vertical;line-height:1.4">${esc(ctx.privateKey || "")}</textarea><input class="input mono" id="w_key" value="${esc(ctx.privateKeyPath || "")}" placeholder="…or a key file path on this host (blank = MCP key / agent)" style="margin-top:8px">`); };
      drawAuth(); b.querySelector("#w_auth").onchange = drawAuth;
    }, onNext: (ctx) => {
      ctx.host = document.getElementById("w_host").value.trim(); ctx.port = document.getElementById("w_port").value.trim() || "22"; ctx.user = document.getElementById("w_user").value.trim() || "root";
      ctx.authMethod = document.getElementById("w_auth").value;
      ctx.password = ctx.authMethod === "password" ? (document.getElementById("w_pw")?.value || "") : "";
      ctx.privateKey = ctx.authMethod === "key" ? (document.getElementById("w_keypaste")?.value.trim() || "") : "";
      ctx.privateKeyPath = ctx.authMethod === "key" ? (document.getElementById("w_key")?.value.trim() || "") : "";
      if (!ctx.host) return "Host / IP is required.";
      if (ctx.authMethod === "password" && !ctx.password) return "Enter the root password.";
      return true;
    } },
    { label: "Diagnose", body: async (ctx, b) => {
      b.innerHTML = `<div style="font-weight:600;font-size:15px;margin-bottom:14px">Diagnosing ${esc(ctx.host)}…</div><div class="dres"><span class="spin"></span> running connectivity checks…</div>`;
      try {
        const d = await api("/api/wizard/diagnose", { method: "POST", body: JSON.stringify({ name: ctx.name || ctx.host, host: ctx.host, port: Number(ctx.port), username: ctx.user, password: ctx.password || undefined, privateKey: ctx.privateKey || undefined, privateKeyPath: ctx.privateKeyPath || undefined }) });
        ctx.canAdd = d.canAdd;
        b.querySelector(".dres").innerHTML = `<div class="badge ${d.reachable ? (d.canAdd ? "b-pos" : "b-warn") : "b-neg"}" style="margin-bottom:12px"><span class="dot"></span>${esc(d.summary)}</div>`
          + d.checks.map((c) => `<div style="display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-bottom:1px solid var(--c-divider)"><span style="color:${c.ok ? "var(--c-pos)" : c.soft ? "var(--c-warn)" : "var(--c-neg)"};flex:none;margin-top:1px">${c.ok ? ic("check", 15) : ic("warn", 15)}</span><div style="flex:1"><div style="font-size:13px;font-weight:500">${esc(c.name)}${c.soft && !c.ok ? ` <span class="hint" style="font-weight:400">(optional)</span>` : ""}</div><div class="mono muted" style="font-size:11.5px;word-break:break-word">${esc(c.detail)}</div></div></div>`).join("");
      } catch (e) { ctx.canAdd = false; b.querySelector(".dres").innerHTML = `<div class="badge b-neg"><span class="dot"></span>${esc(e.message)}</div>`; }
    }, onNext: (ctx) => ctx.canAdd ? true : "Connectivity check failed — fix the host/credentials/privilege before adding." },
    { label: "Role", body: (ctx, b) => {
      const opts = ["", ...S.clusters.map((c) => c.name)];
      b.innerHTML = `<div style="font-weight:600;font-size:15px;margin-bottom:14px">Name, role & cluster</div>
      ${field("Server name", `<input class="input mono" id="w_name" value="${esc(ctx.name || ctx.host || "")}">`)}
      ${field("Role", `<select class="input" id="w_role"><option value="node">node (HA serving)</option><option value="witness">witness (quorum arbiter)</option></select>`)}
      ${field("Cluster", `<select class="input" id="w_cluster">${opts.map((o) => `<option value="${esc(o)}">${o ? esc(o) : "— none —"}</option>`).join("")}<option value="__new">+ new cluster…</option></select>`)}
      <div id="w_newcluster"></div>`;
      if (ctx.role) b.querySelector("#w_role").value = ctx.role; if (ctx.cluster) b.querySelector("#w_cluster").value = ctx.cluster;
      const drawNew = () => { b.querySelector("#w_newcluster").innerHTML = b.querySelector("#w_cluster").value === "__new" ? field("New cluster name", `<input class="input mono" id="w_clnew" placeholder="prod">`) : ""; };
      drawNew(); b.querySelector("#w_cluster").onchange = drawNew;
    }, onNext: (ctx) => {
      ctx.name = document.getElementById("w_name").value.trim(); ctx.role = document.getElementById("w_role").value;
      const cl = document.getElementById("w_cluster").value; ctx.cluster = cl === "__new" ? (document.getElementById("w_clnew")?.value.trim() || "") : cl;
      if (!ctx.name) return "Server name is required.";
      if (cl === "__new" && !ctx.cluster) return "Enter the new cluster name.";
      return true;
    } },
    { label: "Authorize", body: (ctx, b) => { b.innerHTML = `<div style="font-weight:600;font-size:15px;margin-bottom:8px">Authorize & add</div><div class="muted" style="font-size:13px;margin-bottom:14px">Add <b class="mono">${esc(ctx.name)}</b> (${esc(ctx.user)}@${esc(ctx.host)}:${esc(ctx.port)}) as a <b>${esc(ctx.role)}</b>${ctx.cluster ? ` in cluster <b>${esc(ctx.cluster)}</b>` : ""}.${ctx.authMethod === "password" ? " The MCP key will be authorized on the target, then the password is discarded." : ""}</div><pre class="out">server_add name=${esc(ctx.name)} host=${esc(ctx.host)} auth=${esc(ctx.authMethod)} role=${esc(ctx.role)}</pre>`; } },
  ], async (ctx) => {
    const r = await api("/api/wizard/add-server", { method: "POST", body: JSON.stringify({ name: ctx.name, host: ctx.host, port: Number(ctx.port), username: ctx.user, role: ctx.role, cluster: ctx.cluster || "", authMethod: ctx.authMethod, password: ctx.password || undefined, privateKey: ctx.privateKey || undefined, privateKeyPath: ctx.privateKeyPath || undefined }) });
    toast(`Added ${ctx.name}`); await loadClusters(); await loadFleet(); render();
  });
}
// generic typed-confirm danger slide-in (prevents sudden deletes / sensitive ops)
function confirmDanger(title, message, target, onConfirm, okLabel = "Confirm") {
  const { panel, close } = slideIn(480);
  panel.innerHTML = `<div class="drawer-head"><strong style="color:var(--c-neg)">${ic("warn", 17)} ${esc(title)}</strong><button class="icon-btn dc">${ic("x", 16)}</button></div>
    <div class="drawer-body" style="padding:18px"><div style="font-size:13.5px;line-height:1.55;margin-bottom:14px">${message}</div>
    ${target ? `<div style="display:flex;gap:10px;background:var(--c-neg-bg);border:1px solid var(--c-neg);border-radius:10px;padding:13px 14px;margin-bottom:16px"><span style="color:var(--c-neg);flex:none">${ic("warn", 18)}</span><div style="font-size:12.5px;line-height:1.5">Type <b class="mono">${esc(target)}</b> to confirm.</div></div><input class="input ci" placeholder="${esc(target)}">` : ""}</div>
    <div style="display:flex;justify-content:flex-end;gap:10px;padding:14px 18px;border-top:1px solid var(--c-divider);background:var(--c-sunken)"><button class="btn dc2">Cancel</button><button class="btn btn-danger run">${esc(okLabel)}</button></div>`;
  panel.querySelector(".dc").onclick = close; panel.querySelector(".dc2").onclick = close;
  panel.querySelector(".run").onclick = async () => { if (target && panel.querySelector(".ci").value.trim() !== target) return toast(`Type "${target}" to confirm`, true); const btn = panel.querySelector(".run"); btn.disabled = true; btn.innerHTML = `<span class="spin"></span>`; try { await onConfirm(); close(); } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = okLabel; } };
}

// destructive action → slide-in verify (impact → type-to-confirm → run)
function verifyAction(tool, args) {
  if (!tool.destructive) return action(tool.name, args);
  const target = args.cluster || args.server || args.name || args.service || "";
  const { panel, close } = slideIn(480);
  panel.innerHTML = `<div class="drawer-head"><strong style="color:var(--c-neg)">${ic("warn", 17)} Confirm destructive action</strong><button class="icon-btn dc">${ic("x", 16)}</button></div>
    <div class="drawer-body" style="padding:18px"><div style="font-weight:600;font-size:15px;margin-bottom:8px">${esc(tool.title)}</div>
    <pre class="out" style="margin-bottom:14px">${esc(tool.name)} ${esc(JSON.stringify(args))}</pre>
    <div style="display:flex;gap:10px;background:var(--c-neg-bg);border:1px solid var(--c-neg);border-radius:10px;padding:13px 14px;margin-bottom:16px"><span style="color:var(--c-neg);flex:none">${ic("warn", 18)}</span><div style="font-size:12.5px;line-height:1.5">${esc(t("typeToConfirm"))}</div></div>
    <input class="input ci" placeholder="${esc(target || "confirm")}"></div>
    <div style="display:flex;justify-content:flex-end;gap:10px;padding:14px 18px;border-top:1px solid var(--c-divider);background:var(--c-sunken)"><button class="btn dc2">${t("cancel")}</button><button class="btn btn-danger run">Run action</button></div>`;
  panel.querySelector(".dc").onclick = close; panel.querySelector(".dc2").onclick = close;
  panel.querySelector(".run").onclick = async () => { if (target && panel.querySelector(".ci").value.trim() !== target) return toast(`Type "${target}" to confirm`, true); const b = panel.querySelector(".run"); b.disabled = true; b.innerHTML = `<span class="spin"></span>`; try { const r = await startDestructive(tool.name, args); toast(`Started ${tool.name}`); close(); openDrawer(r.job.id); } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = "Run action"; } };
}

let STACKS_STATUS = [];
async function ensureStacks() { try { STACKS_STATUS = await api("/api/stacks"); } catch { /* keep last */ } return STACKS_STATUS; }

// Provision a fresh server: clone + .env + compose up + migrate (the install tools are idempotent).
function installForm(stack) {
  const { panel, close } = slideIn(500);
  const servers = (S.fleet?.nodes || []).map((n) => n.name);
  const srvField = servers.length ? selField("server", servers, "(default server)") : `<input class="input" data-k="server" placeholder="(default server)">`;
  const isA = stack === "analytics";
  const fields = isA
    ? `<label class="fld"><span class="lab">server</span>${srvField}</label>
       <label class="fld"><span class="lab">domain · optional — HTTPS via Caddy</span><input class="input" data-k="domain" placeholder="analytics.example.com (omit for HTTP-on-IP)"></label>
       <label class="fld"><span class="lab">adminEmail · optional</span><input class="input" data-k="adminEmail" placeholder="admin@example.com"></label>
       <label class="fld"><span class="lab">branch</span><input class="input" data-k="branch" placeholder="main"></label>
       <label style="display:flex;align-items:center;gap:7px;font-size:12.5px;margin:2px 0 4px;cursor:pointer"><input type="checkbox" data-k="deployKey" data-bool="1"> Private repo — use the MCP's shared deploy key (added to GitHub once, reused for every server)</label>`
    : `<label class="fld"><span class="lab">server</span>${srvField}</label>
       <label class="fld"><span class="lab">dir</span><input class="input" data-k="dir" placeholder="/opt/adpix-tagmanager"></label>
       <label class="fld"><span class="lab">databaseUrl · required</span><input class="input" data-k="databaseUrl" placeholder="postgres://user:pass@host:5432/db"></label>
       <label class="fld"><span class="lab">authIssuer · required</span><input class="input" data-k="authIssuer" placeholder="https://account.adpix.io"></label>
       <label class="fld"><span class="lab">s3AccessKey · required</span><input class="input" data-k="s3AccessKey"></label>
       <label class="fld"><span class="lab">s3SecretKey · required</span><input class="input" type="password" data-k="s3SecretKey"></label>
       <label class="fld"><span class="lab">purgeToken · required</span><input class="input" data-k="purgeToken"></label>
       <label class="fld"><span class="lab">s3Bucket</span><input class="input" data-k="s3Bucket" placeholder="adpix-tags"></label>`;
  panel.innerHTML = `<div class="drawer-head"><strong style="display:flex;align-items:center;gap:8px">${ic("deploys", 17)} Install ${isA ? "AdPix Analytics" : "Tag Manager"}</strong><button class="icon-btn dc">${ic("x", 16)}</button></div>
    <div class="drawer-body" style="padding:18px">
      <div class="muted" style="font-size:12.5px;line-height:1.5;margin-bottom:14px">Provisions the full stack on a fresh host: clone the repo, write <code>.env</code>, install Docker, build, run migrations, bring containers up, and health-gate. ${isA ? "Secrets are auto-generated. First build takes 10–25 min." : "Provide the control-plane secrets below."} Streams in Activity.</div>
      ${fields}
    </div>
    <div style="display:flex;justify-content:flex-end;gap:10px;padding:14px 18px;border-top:1px solid var(--c-divider);background:var(--c-sunken)"><button class="btn dc2">${t("cancel")}</button><button class="btn btn-primary nx">Install</button></div>`;
  panel.querySelector(".dc").onclick = close; panel.querySelector(".dc2").onclick = close;
  panel.querySelector(".nx").onclick = () => {
    const a = {};
    panel.querySelectorAll("[data-k]").forEach((i) => { if (i.dataset.bool) { if (i.checked) a[i.dataset.k] = true; } else { const v = i.value.trim(); if (v) a[i.dataset.k] = v; } });
    if (!isA) { for (const k of ["databaseUrl", "authIssuer", "s3AccessKey", "s3SecretKey", "purgeToken"]) if (!a[k]) return toast(`${k} is required`, true); }
    close();
    action(isA ? "adpix_install" : "tm_install", a);
  };
}

function idpUpdateForm() {
  const { panel, close } = slideIn(480);
  const servers = (S.fleet?.nodes || []).map((n) => n.name);
  panel.innerHTML = `<div class="drawer-head"><strong style="display:flex;align-items:center;gap:8px">${ic("deploys", 17)} Update IdP · account center</strong><button class="icon-btn dc">${ic("x", 16)}</button></div>
    <div class="drawer-body" style="padding:18px">
      <div class="muted" style="font-size:12.5px;line-height:1.5;margin-bottom:14px"><b>apps/auth ships no compose in the repo</b> — point this at your account-center compose. Pulls + rebuilds + recreates only the auth service (<code>up -d --no-deps</code>); its database is never touched. Runs migrations only if you set a migrateCmd.</div>
      <label class="fld"><span class="lab">server</span>${servers.length ? selField("server", servers, "(default server)") : `<input class="input" data-k="server" placeholder="(default server)">`}</label>
      <label class="fld"><span class="lab">dir · checkout on the server</span><input class="input" data-k="dir" placeholder="/opt/adpix-auth"></label>
      <label class="fld"><span class="lab">composeFile · required</span><input class="input" data-k="composeFile" placeholder="deploy/docker-compose.yml"></label>
      <label class="fld"><span class="lab">project · compose -p</span><input class="input" data-k="project" placeholder="adpix-auth"></label>
      <label class="fld"><span class="lab">service · auth service to recreate</span><input class="input" data-k="service" placeholder="auth"></label>
      <label class="fld"><span class="lab">migrateCmd · optional</span><input class="input" data-k="migrateCmd" placeholder="(none — e.g. run --rm migrate)"></label>
      <label class="fld"><span class="lab">branch · optional</span><input class="input" data-k="branch" placeholder="(current)"></label>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:10px;padding:14px 18px;border-top:1px solid var(--c-divider);background:var(--c-sunken)"><button class="btn dc2">${t("cancel")}</button><button class="btn btn-primary nx">Review + confirm</button></div>`;
  panel.querySelector(".dc").onclick = close; panel.querySelector(".dc2").onclick = close;
  panel.querySelector(".nx").onclick = () => {
    const a = { stack: "idp", statelessOnly: true };
    panel.querySelectorAll("[data-k]").forEach((i) => { const v = i.value.trim(); if (v) a[i.dataset.k] = v; });
    if (!a.composeFile) return toast("composeFile is required for the IdP", true);
    close();
    verifyAction({ name: "stack_update", title: "Update the IdP / account center — stateless-only (database preserved)", destructive: true }, a);
  };
}

// ============================================================ command palette
function openPalette() {
  const items = [...NAV.flatMap((g) => g.items.map((id) => ({ label: STR[S.lang].nav[id], kind: "screen", id }))), ...S.catalog.filter((x) => x.readOnly).slice(0, 40).map((x) => ({ label: `Run ${x.name}`, kind: "tool", id: x.name }))];
  const pal = el(`<div class="palette"><div class="box"><input placeholder="${esc(t("search"))}"><div class="opts"></div></div></div>`);
  const inp = pal.querySelector("input"), opts = pal.querySelector(".opts"); let sel = 0, fil = items;
  const drw = () => { opts.innerHTML = fil.slice(0, 8).map((o, k) => `<div class="opt ${k === sel ? "sel" : ""}" data-i="${k}">${ic(o.kind === "screen" ? o.id : "play", 16)}<span>${esc(o.label)}</span></div>`).join(""); opts.querySelectorAll("[data-i]").forEach((e) => (e.onclick = () => pick(fil[+e.dataset.i]))); };
  const pick = (o) => { pal.remove(); if (!o) return; if (o.kind === "screen") { S.screen = o.id; S.sd = null; render(); } else action(o.id); };
  inp.oninput = () => { const q = inp.value.toLowerCase(); fil = items.filter((o) => o.label.toLowerCase().includes(q)); sel = 0; drw(); };
  inp.onkeydown = (e) => { if (e.key === "ArrowDown") { sel = Math.min(sel + 1, Math.min(fil.length, 8) - 1); drw(); } else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); drw(); } else if (e.key === "Enter") pick(fil[sel]); else if (e.key === "Escape") pal.remove(); };
  pal.onclick = (e) => { if (e.target === pal) pal.remove(); };
  document.body.appendChild(pal); drw(); inp.focus();
}
document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); if (document.querySelector(".sidebar")) openPalette(); } });

// ============================================================ activity drawer (design job cards)
let drawerAbort = null;
async function openDrawer(focusId) {
  const { panel } = (() => { let scrim = document.querySelector(".scrim"); let drawer = document.querySelector(".drawer.activity"); if (!scrim) { scrim = el(`<div class="scrim"></div>`); document.body.appendChild(scrim); } if (!drawer) { drawer = el(`<aside class="drawer activity"><div class="drawer-head"><strong style="display:flex;align-items:center;gap:8px;color:var(--c-text)">${ic("wave", 17)} ${t("activity")}</strong><button class="icon-btn dc">${ic("x", 16)}</button></div><div class="drawer-body db" style="padding:14px 16px"></div></aside>`); document.body.appendChild(drawer); drawer.querySelector(".dc").onclick = closeDrawer; } scrim.onclick = closeDrawer; requestAnimationFrame(() => { scrim.classList.add("show"); drawer.classList.add("show"); }); return { panel: drawer }; })();
  const db = panel.querySelector(".db");
  try { const { jobs } = await listJobs(); db.innerHTML = jobs.length ? "" : `<div class="empty">${t("noJobs")}</div>`; jobs.slice(0, 12).forEach((j) => db.appendChild(jobCard(j, j.id === focusId))); if (focusId) { const it = db.querySelector(`[data-job="${focusId}"]`); if (it) liveStream(focusId, it); } } catch (e) { db.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function closeDrawer() { if (drawerAbort) drawerAbort.abort(); document.querySelector(".scrim")?.classList.remove("show"); document.querySelector(".drawer.activity")?.classList.remove("show"); }
function jobCard(j, open) {
  const k = sc(j.status); const done = j.status !== "running" && j.status !== "queued";
  const it = el(`<div class="job-item" data-job="${j.id}" style="border:1px solid var(--c-border);border-radius:10px;padding:13px;margin-bottom:12px;${open ? "box-shadow:var(--c-shadow-card)" : ""}">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><div style="min-width:0"><div style="font-size:13.5px;font-weight:500">${esc(j.tool)}</div><div style="font-family:var(--font-mono);font-size:11.5px;color:var(--c-muted)">${esc(j.key === "_global" ? "" : j.key)} · j-${esc(j.id.slice(0, 4))}</div></div><span style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:999px;background:var(--c-${k}-bg);color:var(--c-${k})">${j.status === "succeeded" ? "Done" : j.status === "failed" ? "Failed" : j.status === "running" ? "Running" : esc(j.status)}</span></div>
    <div style="height:6px;border-radius:999px;background:var(--c-sunken);overflow:hidden;margin-top:10px"><div class="pbar" style="height:100%;width:${done ? "100" : "40"}%;background:var(--c-${k});border-radius:999px;${j.status === "running" ? "animation:indet 1.1s var(--ease) infinite" : ""}"></div></div>
    <div class="log" style="display:${open ? "block" : "none"};margin-top:10px"></div>
    <div style="margin-top:8px;display:flex;gap:6px"><button class="btn btn-sm tg">${open ? "Hide" : "Logs"}</button>${j.status === "running" ? `<button class="btn btn-sm btn-danger kl">${t("cancel")}</button>` : ""}</div></div>`);
  const log = it.querySelector(".log");
  const logStyle = "display:block;margin-top:10px;font-family:var(--font-mono);font-size:11px;line-height:1.7;background:var(--c-code-bg);border-radius:8px;padding:10px 12px;max-height:200px;overflow:auto;white-space:pre-wrap";
  // prefill any persisted log tail (terminal/demo jobs that won't stream)
  if (j.logTail && j.logTail.length) {
    log.style.cssText = logStyle; log.dataset.s = "1";
    const bad = j.status === "failed" || j.status === "canceled";
    log.innerHTML = j.logTail.map((l) => `<div style="color:${bad ? "var(--c-neg)" : "var(--c-pos)"}">${bad ? "× " : "✓ "}${esc(l)}</div>`).join("");
    it.querySelector(".tg").textContent = "Hide";
  }
  it.querySelector(".tg").onclick = () => { const sh = log.style.display === "none"; log.style.display = sh ? "block" : "none"; it.querySelector(".tg").textContent = sh ? "Hide" : "Logs"; if (sh && !log.dataset.s) liveStream(j.id, it); };
  it.querySelector(".kl")?.addEventListener("click", async () => { try { await cancelJob(j.id); toast("Canceled"); } catch (e) { toast(e.message, true); } });
  if (j.status === "running" || (open && !(j.logTail && j.logTail.length))) liveStream(j.id, it);
  return it;
}
function liveStream(id, it) {
  const log = it.querySelector(".log"); log.dataset.s = "1"; log.style.display = "block";
  if (!log.classList.contains("log")) {} log.className = "log"; log.style.cssText = "display:block;margin-top:10px;font-family:var(--font-mono);font-size:11px;line-height:1.7;background:var(--c-code-bg);border-radius:8px;padding:10px 12px;max-height:200px;overflow:auto;white-space:pre-wrap";
  drawerAbort = new AbortController();
  streamJob(id, (ev) => { if (ev.type === "log") { const mark = /\$ \[/.test(ev.line) ? "› " : "✓ "; const color = /ERROR|fail/i.test(ev.line) ? "var(--c-neg)" : /\$ \[/.test(ev.line) ? "var(--c-hint)" : "var(--c-pos)"; const ln = el(`<div style="color:${color}">${esc(mark + ev.line.replace(/^\$ \[[^\]]*\]\s*/, ""))}</div>`); log.appendChild(ln); log.scrollTop = log.scrollHeight; } if (ev.type === "done") { const pb = it.querySelector(".pbar"); if (pb) { pb.style.width = "100%"; pb.style.animation = ""; pb.style.background = `var(--c-${sc(ev.status)})`; } it.querySelector(".kl")?.remove(); } }, drawerAbort.signal).catch(() => {});
}

// ============================================================ admin (settings)
function panelCard(title) { return el(`<div style="${cardOpen}"><div style="${cardHead};display:flex;align-items:center;justify-content:space-between">${esc(title)}<button class="btn btn-sm refresh">${t("refresh")}</button></div><div class="card-pad"><div class="body"><div class="skel" style="width:60%"></div></div></div></div>`); }
function adminUsers() { const c = panelCard("Users & roles"); const body = c.querySelector(".body"); const load = async () => { try { const { users } = await api("/api/admin/users"); body.innerHTML = `<table class="t"><thead><tr><th>User</th><th>Role</th><th>Scopes</th><th></th></tr></thead><tbody>${users.map((u) => `<tr><td class="mono">${esc(u.username)}</td><td><span class="tag">${esc(u.role)}</span></td><td class="muted">${esc((u.scopes || []).join(", "))}</td><td>${u.username === S.me.username ? "" : `<button class="btn btn-sm rm" data-u="${esc(u.username)}">Remove</button>`}</td></tr>`).join("")}</tbody></table><div style="margin-top:12px"><button class="btn btn-primary btn-sm add">+ Add user</button></div>`; body.querySelector(".add").onclick = () => addUserModal(load); body.querySelectorAll(".rm").forEach((x) => (x.onclick = () => confirmDanger("Remove user", `Remove admin <b class="mono">${esc(x.dataset.u)}</b>? Their sessions are not auto-revoked — engage the kill-switch if needed.`, x.dataset.u, async () => { await api("/api/admin/users/remove", { method: "POST", body: JSON.stringify({ username: x.dataset.u }) }); toast(`Removed ${x.dataset.u}`); load(); }, "Remove user"))); } catch (e) { body.innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre>`; } }; c.querySelector(".refresh").onclick = load; load(); return c; }
function addUserModal(after) { const { panel, close } = slideIn(440); panel.innerHTML = `<div class="drawer-head"><strong>Add user</strong><button class="icon-btn dc">${ic("x", 16)}</button></div><div class="drawer-body" style="padding:18px">${field("Username", `<input class="input" id="au_u">`)}${field("Password", `<input class="input" type="password" id="au_p">`)}${field("Role", `<select class="input" id="au_r"><option>viewer</option><option>operator</option><option>owner</option></select>`)}${field("Scopes (comma; blank=all)", `<input class="input" id="au_s" placeholder="*">`)}</div><div style="display:flex;justify-content:flex-end;gap:10px;padding:14px 18px;border-top:1px solid var(--c-divider);background:var(--c-sunken)"><button class="btn dc2">Cancel</button><button class="btn btn-primary ok">Create</button></div>`; panel.querySelector(".dc").onclick = close; panel.querySelector(".dc2").onclick = close; panel.querySelector(".ok").onclick = async () => { const g = (id) => panel.querySelector(id).value.trim(); if (!g("#au_u") || !g("#au_p")) return toast("username + password required", true); try { const r = await api("/api/admin/users", { method: "POST", body: JSON.stringify({ username: g("#au_u"), password: g("#au_p"), role: g("#au_r"), scopes: g("#au_s") ? g("#au_s").split(",").map((s) => s.trim()) : ["*"] }) }); close(); showTotp(r); after && after(); } catch (e) { toast(e.message, true); } }; }
function showTotp(r) { const { panel, close } = slideIn(440); panel.innerHTML = `<div class="drawer-head"><strong>TOTP secret (shown once)</strong><button class="icon-btn dc">${ic("x", 16)}</button></div><div class="drawer-body" style="padding:18px"><p>User <b>${esc(r.username)}</b> created. Add to an authenticator:</p><pre class="out">${esc(r.totpSecret)}</pre><p class="muted" style="word-break:break-all;font-size:12px">${esc(r.totpUri)}</p></div>`; panel.querySelector(".dc").onclick = close; }
function adminSessions() { const c = panelCard("Active sessions"); const body = c.querySelector(".body"); const load = async () => { try { const { sessions } = await api("/api/admin/sessions"); body.innerHTML = sessions.length ? `<table class="t"><thead><tr><th>User</th><th>IP</th><th>Last seen</th></tr></thead><tbody>${sessions.map((s) => `<tr><td class="mono">${esc(s.username)}</td><td class="muted">${esc(s.ip)}</td><td class="muted">${new Date(s.lastSeen).toLocaleTimeString()}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">No active sessions.</div>`; } catch (e) { body.innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre>`; } }; c.querySelector(".refresh").onclick = load; load(); return c; }
function adminAudit() { const c = panelCard("Audit log"); const body = c.querySelector(".body"); const load = async () => { try { const { entries, chain } = await api("/api/admin/audit"); body.innerHTML = `<div style="margin-bottom:8px">${chain.ok ? pill("chain intact", "pos") : pill("TAMPERED @ " + chain.brokenAtSeq, "neg")}</div><table class="t"><thead><tr><th>#</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>${entries.slice(0, 30).map((e) => `<tr><td class="muted">${e.seq}</td><td class="mono">${esc(e.actor)}</td><td class="mono">${esc(e.tool)}</td><td>${esc(e.target)}</td></tr>`).join("")}</tbody></table>`; } catch (e) { body.innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre>`; } }; c.querySelector(".refresh").onclick = load; load(); return c; }
function adminKill() { const c = el(`<div style="${cardOpen};padding:16px"><div style="display:flex;align-items:center;justify-content:space-between;gap:12px"><div><h3 style="margin:0 0 4px;font-size:14px;font-weight:600">Kill-switch</h3><div class="muted" style="font-size:13px">Disable destructive ops + revoke every session.</div></div><button class="btn btn-danger" id="k">${ic("security", 14)} Engage</button></div></div>`); c.querySelector("#k").onclick = async () => { if (!confirm("Engage the kill-switch? Revokes ALL sessions + blocks destructive ops.")) return; try { await api("/api/admin/kill", { method: "POST", body: JSON.stringify({ on: true }) }); toast("Kill-switch engaged — logging out"); setTimeout(() => location.reload(), 800); } catch (e) { toast(e.message, true); } }; return c; }

// ============================================================ auth gate
function authShell(inner) { document.documentElement.dataset.theme = S.theme; document.getElementById("app").innerHTML = `<div style="min-height:100vh;display:grid;place-items:center;background:var(--c-bg);padding:24px"><div class="card" style="width:380px;max-width:92vw;padding:26px;background:var(--c-card);border:1px solid var(--c-border);border-radius:12px"><div style="display:flex;align-items:center;gap:10px;margin-bottom:18px">${LOGO}<span style="font-family:var(--font-display);font-weight:600;font-size:18px">AdPix Cloud</span></div>${inner}</div></div>`; }
function renderLogin(msg = "") { authShell(`${msg ? `<div class="badge b-neg" style="margin-bottom:12px"><span class="dot"></span>${esc(msg)}</div>` : ""}<label class="fld"><span class="lab">Username</span><input class="input" id="u"></label><label class="fld"><span class="lab">Password</span><input class="input" type="password" id="p"></label><label class="fld"><span class="lab">Authenticator code</span><input class="input mono" id="totp" inputmode="numeric" placeholder="000000"></label><button class="btn btn-primary" id="go" style="width:100%;justify-content:center;margin-top:6px">Sign in</button>`); const go = async () => { try { const r = await api("/api/login", { method: "POST", body: JSON.stringify({ username: u.value.trim(), password: p.value, totp: totp.value.trim() }) }); S.csrf = r.csrf; sessionStorage.removeItem("adpix_token"); boot(); } catch (e) { renderLogin(e.message); } }; const u = document.getElementById("u"), p = document.getElementById("p"), totp = document.getElementById("totp"); document.getElementById("go").onclick = go; totp.onkeydown = (e) => { if (e.key === "Enter") go(); }; }
function renderSetup(msg = "") { authShell(`<p class="muted" style="margin-top:0">First run — create the owner account. You'll get a TOTP secret for an authenticator app.</p>${msg ? `<div class="badge b-neg" style="margin-bottom:12px"><span class="dot"></span>${esc(msg)}</div>` : ""}<label class="fld"><span class="lab">Username</span><input class="input" id="u"></label><label class="fld"><span class="lab">Password</span><input class="input" type="password" id="p"></label><button class="btn btn-primary" id="go" style="width:100%;justify-content:center;margin-top:6px">Create owner</button>`); document.getElementById("go").onclick = async () => { const u = document.getElementById("u").value.trim(), p = document.getElementById("p").value; if (!u || !p) return renderSetup("username + password required"); try { const r = await api("/api/setup", { method: "POST", body: JSON.stringify({ username: u, password: p }) }); authShell(`<p>Owner <b>${esc(r.username)}</b> created. Add this TOTP secret to your authenticator (shown once):</p><pre class="out">${esc(r.totpSecret)}</pre><p class="muted" style="word-break:break-all;font-size:12px">${esc(r.totpUri)}</p><button class="btn btn-primary" id="c" style="width:100%;justify-content:center;margin-top:10px">Continue to sign in</button>`); document.getElementById("c").onclick = () => renderLogin(); } catch (e) { renderSetup(e.message); } }; }

// ============================================================ boot
async function boot() {
  let me = null; try { me = await api("/api/me"); } catch {}
  if (me) { S.me = me.actor; S.mode = me.mode; if (me.csrf) S.csrf = me.csrf; if (me.killed) { authShell(`<div class="badge b-neg"><span class="dot"></span>Kill-switch engaged</div><p class="muted">Destructive ops disabled, sessions revoked. An owner must release it.</p><button class="btn" id="r" style="width:100%;justify-content:center;margin-top:8px">Reload</button>`); document.getElementById("r").onclick = () => location.reload(); return; } try { const { tools } = await api("/api/catalog"); S.catalog = tools; } catch (e) { authShell(`<div class="empty">Failed to load: ${esc(e.message)}</div>`); return; } await loadClusters(); await loadFleet(); render(); return; }
  let status = {}; try { status = await fetch("/api/status").then((r) => r.json()); } catch {}
  if (status.adminsExist) return renderLogin();
  if (TOKEN) return renderSetup();
  authShell(`<div class="empty">No session token. Open the URL printed by <code>--panel</code> (it carries <code>#token=…</code>), or have an owner create your account.</div>`);
}
boot();
