// AdPix Cloud — control panel SPA (Phase 1). Vanilla JS over the panel API. Implements the
// "AdPix Cloud" design: app shell + nav groups, dark/light, EN/FA + RTL, live jobs drawer
// with SSE log streaming, and a typed-confirm modal for destructive ops.

// ---------------------------------------------------------------- token + api
const TOKEN = (location.hash.match(/token=([a-f0-9]+)/) || [])[1] || sessionStorage.getItem("adpix_token") || "";
if (TOKEN) sessionStorage.setItem("adpix_token", TOKEN);
history.replaceState(null, "", location.pathname);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "x-adpix-token": TOKEN, ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers || {}) },
  });
  if (!res.ok && res.status !== 202) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}
const runTool = (name, args = {}) => api(`/api/tools/${name}`, { method: "POST", body: JSON.stringify({ args }) });
const startJob = (tool, args = {}, confirm = false) =>
  api("/api/jobs", { method: "POST", body: JSON.stringify({ tool, args, confirm, idempotencyKey: `${tool}:${Date.now()}` }) });
const listJobs = () => api("/api/jobs");
const cancelJob = (id) => api(`/api/jobs/${id}/cancel`, { method: "POST", body: "{}" });

// SSE over fetch (so we can send the auth header EventSource can't)
async function streamJob(id, onEvent, signal) {
  const res = await fetch(`/api/jobs/${id}/stream`, { headers: { "x-adpix-token": TOKEN }, signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) { try { onEvent(JSON.parse(line.slice(6))); } catch {} }
    }
  }
}

// ---------------------------------------------------------------- i18n
const STR = {
  en: { nav: { dashboard: "Dashboard", servers: "Servers", ha: "High availability", databases: "Databases", backups: "Backups", deploys: "Deploys", dns: "DNS & connect", monitoring: "Monitoring", jobs: "Jobs & audit", security: "Security", settings: "Settings" },
    grp: { overview: "Overview", fleet: "Fleet", data: "Data", delivery: "Delivery", observe: "Observe", govern: "Govern" },
    run: "Run", running: "Running…", refresh: "Refresh", cancel: "Cancel", confirm: "Confirm", close: "Close", activity: "Activity",
    noJobs: "No active jobs. Everything is idle.", addServer: "Add server", search: "Search…", quickActions: "Quick actions",
    typeToConfirm: "This is irreversible. Type the target name to confirm:", destructive: "Destructive action" },
  fa: { nav: { dashboard: "داشبورد", servers: "سرورها", ha: "دسترس‌پذیری بالا", databases: "پایگاه‌داده", backups: "پشتیبان‌گیری", deploys: "استقرار", dns: "DNS و اتصال", monitoring: "پایش", jobs: "کارها و ممیزی", security: "امنیت", settings: "تنظیمات" },
    grp: { overview: "نمای کلی", fleet: "فلیت", data: "داده", delivery: "تحویل", observe: "مشاهده", govern: "حاکمیت" },
    run: "اجرا", running: "در حال اجرا…", refresh: "تازه‌سازی", cancel: "لغو", confirm: "تأیید", close: "بستن", activity: "فعالیت",
    noJobs: "کار فعالی نیست. همه‌چیز بی‌کار است.", addServer: "افزودن سرور", search: "جستجو…", quickActions: "اقدامات سریع",
    typeToConfirm: "این عمل بازگشت‌ناپذیر است. برای تأیید نام هدف را بنویسید:", destructive: "عملیات مخرب" },
};

// ---------------------------------------------------------------- nav model
const NAV = [
  { grp: "overview", items: [["dashboard", "gauge"]] },
  { grp: "fleet", items: [["servers", "server"], ["ha", "share"]] },
  { grp: "data", items: [["databases", "database"], ["backups", "archive"]] },
  { grp: "delivery", items: [["deploys", "rocket"], ["dns", "globe"]] },
  { grp: "observe", items: [["monitoring", "activity"], ["jobs", "list"]] },
  { grp: "govern", items: [["security", "shield"], ["settings", "settings"]] },
];
// screen → which catalog groups its tools come from (bespoke screens excluded)
const SCREEN_GROUPS = {
  servers: ["servers", "containers"], ha: ["ha"], databases: ["databases"], backups: ["backups"],
  deploys: ["deploys"], dns: ["dns"], monitoring: ["monitoring"], security: ["security"], settings: ["settings"],
};

const ICONS = {
  gauge: "M12 14a2 2 0 100-4 2 2 0 000 4zm0-9a9 9 0 100 18M12 12l5-3", server: "M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01",
  share: "M6 12a3 3 0 100-6 3 3 0 000 6zm12-3a3 3 0 100-6 3 3 0 000 6zm0 12a3 3 0 100-6 3 3 0 000 6zM8.6 10.7l6.8-3.4M8.6 13.3l6.8 3.4",
  database: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6",
  archive: "M3 5h18v4H3zM5 9v10h14V9M9 13h6", rocket: "M5 15c-1 1-2 5-2 5s4-1 5-2M9 11a8 8 0 016-6c3 0 4 1 4 4a8 8 0 01-6 6l-2 2-4-4z",
  globe: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.5 2.5 15.5 0 18M12 3c-2.5 2.5-2.5 15.5 0 18",
  activity: "M3 12h4l3 8 4-16 3 8h4", list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z", settings: "M12 9a3 3 0 100 6 3 3 0 000-6zM19 12a7 7 0 00-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 00-1.7-1L14.5 2h-4l-.3 2.6a7 7 0 00-1.7 1l-2.4-1-2 3.4 2 1.6a7 7 0 000 2l-2 1.6 2 3.4 2.4-1a7 7 0 001.7 1l.3 2.6h4l.3-2.6a7 7 0 001.7-1l2.4 1 2-3.4-2-1.6c.1-.3.1-.7.1-1z",
  sun: "M12 7a5 5 0 100 10 5 5 0 000-10zM12 2v2M12 20v2M4 4l1.5 1.5M18.5 18.5L20 20M2 12h2M20 12h2M4 20l1.5-1.5M18.5 5.5L20 4",
  moon: "M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z", x: "M18 6L6 18M6 6l12 12", play: "M6 4l14 8-14 8z", menu: "M3 6h18M3 12h18M3 18h18",
};
const ic = (n, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${(ICONS[n] || "").split("M").filter(Boolean).map((d) => `<path d="M${d}"/>`).join("")}</svg>`;

// ---------------------------------------------------------------- state
const S = {
  lang: localStorage.getItem("adpix_lang") || "en",
  theme: localStorage.getItem("adpix_theme") || "light",
  screen: "dashboard", collapsed: false, catalog: [], drawer: false, jobs: [],
};
const t = (k) => STR[S.lang][k] ?? k;
const el = (html) => { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstElementChild; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function toast(msg, err = false) {
  let wrap = document.querySelector(".toasts");
  if (!wrap) { wrap = el(`<div class="toasts"></div>`); document.body.appendChild(wrap); }
  const tt = el(`<div class="toast ${err ? "err" : ""}">${esc(msg)}</div>`);
  wrap.appendChild(tt);
  setTimeout(() => tt.remove(), 4200);
}

// ---------------------------------------------------------------- shell render
function render() {
  document.documentElement.dataset.theme = S.theme;
  document.body.dir = S.lang === "fa" ? "rtl" : "ltr";
  document.body.lang = S.lang;
  const app = document.getElementById("app");
  app.innerHTML = "";
  app.appendChild(el(`<div class="app">
    <aside class="sidebar ${S.collapsed ? "collapsed" : ""}">
      <div class="brand"><span class="logo">A</span><span class="label">AdPix Cloud</span></div>
      <nav class="nav">${NAV.map((g) => `
        <div class="nav-group">
          <div class="nav-group-label">${esc(STR[S.lang].grp[g.grp])}</div>
          ${g.items.map(([id, icon]) => `<div class="nav-item ${S.screen === id ? "active" : ""}" data-nav="${id}">
            <span class="ic">${ic(icon)}</span><span class="label">${esc(STR[S.lang].nav[id])}</span></div>`).join("")}
        </div>`).join("")}
      </nav>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn" id="toggle">${ic("menu", 16)}</button>
        <input class="input search" placeholder="${t("search")}" id="search">
        <button class="icon-btn" id="lang" title="Language">${S.lang === "en" ? "EN" : "فا"}</button>
        <button class="icon-btn" id="theme">${ic(S.theme === "dark" ? "sun" : "moon", 16)}</button>
        <button class="icon-btn" id="activity" title="${t("activity")}">${ic("activity", 16)}</button>
      </header>
      <main class="content" id="content"></main>
    </div>
  </div>`));

  app.querySelectorAll("[data-nav]").forEach((n) => (n.onclick = () => { S.screen = n.dataset.nav; render(); }));
  app.querySelector("#toggle").onclick = () => { S.collapsed = !S.collapsed; render(); };
  app.querySelector("#theme").onclick = () => { S.theme = S.theme === "dark" ? "light" : "dark"; localStorage.setItem("adpix_theme", S.theme); render(); };
  app.querySelector("#lang").onclick = () => { S.lang = S.lang === "en" ? "fa" : "en"; localStorage.setItem("adpix_lang", S.lang); render(); };
  app.querySelector("#activity").onclick = () => openDrawer();
  renderScreen(document.getElementById("content"));
}

function pageHead(title, actionsHtml = "") {
  return `<div class="page-head"><h1>${esc(title)}</h1><div class="row" style="display:flex;gap:8px;flex-wrap:wrap">${actionsHtml}</div></div>`;
}

// ---------------------------------------------------------------- screens
function renderScreen(c) {
  const title = STR[S.lang].nav[S.screen];
  if (S.screen === "dashboard") return screenDashboard(c);
  if (S.screen === "jobs") return screenJobs(c);
  if (S.screen === "servers") return screenServers(c);
  c.innerHTML = pageHead(title);
  toolGrid(c, SCREEN_GROUPS[S.screen] || []);
}

// generic: render the catalog tools for the given groups as action cards
function toolGrid(c, groups) {
  const tools = S.catalog.filter((t) => groups.includes(t.group));
  if (!tools.length) { c.appendChild(el(`<div class="empty">No tools in this section yet.</div>`)); return; }
  const grid = el(`<div class="grid cols-2"></div>`);
  tools.forEach((tool) => grid.appendChild(actionCard(tool)));
  c.appendChild(grid);
}

function actionCard(tool) {
  const card = el(`<div class="card card-pad action">
    <div style="display:flex;align-items:center;gap:8px">
      <strong class="mono" style="font-size:13px">${esc(tool.name)}</strong>
      ${tool.readOnly ? `<span class="tag">read-only</span>` : ""}
      ${tool.destructive ? `<span class="badge b-neg"><span class="dot"></span>destructive</span>` : ""}
    </div>
    <div class="desc">${esc(tool.title)}</div>
    <div class="argform"></div>
    <div class="row"><button class="btn ${tool.destructive ? "btn-danger" : "btn-primary"} btn-sm run">${ic("play", 14)} ${t("run")}</button></div>
    <div class="result"></div>
  </div>`);
  const props = (tool.params && tool.params.properties) || {};
  const af = card.querySelector(".argform");
  af.appendChild(argForm(props));
  card.querySelector(".run").onclick = async (e) => {
    const btn = e.currentTarget;
    const args = readArgs(af, props);
    if (tool.destructive) return confirmModal(tool, args);
    btn.disabled = true; btn.innerHTML = `<span class="spin"></span> ${t("running")}`;
    const out = card.querySelector(".result");
    try {
      if (tool.readOnly) {
        const r = await runTool(tool.name, args);
        out.innerHTML = `<pre class="out">${esc(r.result)}</pre>`;
      } else {
        const r = await startJob(tool.name, args);
        toast(`Job started: ${tool.name}`);
        openDrawer(r.job.id);
      }
    } catch (err) { out.innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(err.message)}</pre>`; }
    btn.disabled = false; btn.innerHTML = `${ic("play", 14)} ${t("run")}`;
  };
  return card;
}

// minimal form from JSON-schema (string/number/boolean/enum top-level)
function argForm(props) {
  const wrap = el(`<div></div>`);
  Object.entries(props).forEach(([key, sc]) => {
    const desc = sc.description || "";
    let field;
    if (sc.enum) field = `<select class="input" data-k="${key}"><option value="">—</option>${sc.enum.map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
    else if (sc.type === "boolean") field = `<select class="input" data-k="${key}" data-bool="1"><option value="">—</option><option value="true">true</option><option value="false">false</option></select>`;
    else field = `<input class="input" data-k="${key}" data-num="${sc.type === "number" || sc.type === "integer" ? 1 : ""}" placeholder="${esc(sc.type || "")}">`;
    wrap.appendChild(el(`<label class="fld"><span class="lab">${esc(key)}${desc ? ` · <span class="hint" style="font-weight:400">${esc(desc).slice(0, 70)}</span>` : ""}</span>${field}</label>`));
  });
  return wrap;
}
function readArgs(af, props) {
  const args = {};
  af.querySelectorAll("[data-k]").forEach((inp) => {
    const k = inp.dataset.k; const v = inp.value.trim();
    if (v === "") return;
    if (inp.dataset.bool) args[k] = v === "true";
    else if (inp.dataset.num) args[k] = Number(v);
    else args[k] = v;
  });
  return args;
}

async function screenDashboard(c) {
  c.innerHTML = pageHead(STR[S.lang].nav.dashboard, `
    <button class="btn btn-sm" data-act="cluster_status">${ic("share", 14)} Cluster status</button>
    <button class="btn btn-sm" data-act="health_check">${ic("activity", 14)} Health</button>`);
  const grid = el(`<div class="grid cols-2"></div>`);
  c.appendChild(grid);
  const panels = [["health_check", "Fleet health"], ["cluster_status", "Cluster status"], ["tls_status", "TLS certificates"], ["server_list", "Servers"]];
  panels.forEach(([name, label]) => {
    const card = el(`<div class="card"><div class="card-head"><h3>${esc(label)}</h3><button class="btn btn-sm refresh">${t("refresh")}</button></div><div class="card-pad"><div class="body"><div class="skel" style="width:80%"></div><div class="skel" style="width:60%;margin-top:8px"></div></div></div></div>`);
    grid.appendChild(card);
    const body = card.querySelector(".body");
    const load = async () => {
      body.innerHTML = `<div class="skel" style="width:70%"></div>`;
      try { const r = await runTool(name); body.innerHTML = `<pre class="out">${esc(r.result)}</pre>`; }
      catch (e) { body.innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre>`; }
    };
    card.querySelector(".refresh").onclick = load; load();
  });
  c.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => { S.screen = "servers"; render(); }));
}

async function screenServers(c) {
  c.innerHTML = pageHead(STR[S.lang].nav.servers, `<button class="btn btn-primary btn-sm" id="addsrv">${ic("server", 14)} ${t("addServer")}</button>`);
  const card = el(`<div class="card"><div class="card-head"><h3>Fleet</h3><button class="btn btn-sm refresh">${t("refresh")}</button></div><div class="card-pad"><div class="body"><div class="skel" style="width:60%"></div></div></div></div>`);
  c.appendChild(card);
  const body = card.querySelector(".body");
  const load = async () => { try { const r = await runTool("server_list"); body.innerHTML = `<pre class="out">${esc(r.result)}</pre>`; } catch (e) { body.innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre>`; } };
  card.querySelector(".refresh").onclick = load; load();
  c.querySelector("#addsrv").onclick = () => addServerModal(load);
  // containers + cluster tools below
  const sub = el(`<h2 style="font-size:15px;margin:22px 0 12px;font-weight:600">Containers & cluster</h2>`);
  c.appendChild(sub);
  toolGrid(c, ["containers"]);
}

function addServerModal(after) {
  const props = (S.catalog.find((t) => t.name === "server_add")?.params?.properties) || {};
  const af = argForm(props);
  const box = modalShell("Add a server", af, "Add server", async () => {
    const args = readArgs(af, props);
    if (!args.name || !args.host) { toast("name + host required", true); return false; }
    try { const r = await startJob("server_add", args); toast("Adding server…"); openDrawer(r.job.id); after && setTimeout(after, 1500); return true; }
    catch (e) { toast(e.message, true); return false; }
  });
  document.body.appendChild(box);
}

async function screenJobs(c) {
  c.innerHTML = pageHead(STR[S.lang].nav.jobs, `<button class="btn btn-sm refresh">${t("refresh")}</button>`);
  const card = el(`<div class="card"><div class="card-pad"><div class="body"></div></div></div>`);
  c.appendChild(card);
  const body = card.querySelector(".body");
  const load = async () => {
    try {
      const { jobs } = await listJobs();
      if (!jobs.length) { body.innerHTML = `<div class="empty">${t("noJobs")}</div>`; return; }
      body.innerHTML = `<table class="t"><thead><tr><th>Tool</th><th>Status</th><th>Started</th><th></th></tr></thead><tbody>${
        jobs.map((j) => `<tr data-id="${j.id}"><td class="mono">${esc(j.tool)}</td><td>${statusBadge(j.status)}</td><td class="muted">${esc((j.startedAt || j.createdAt || "").replace("T", " ").slice(0, 19))}</td><td><button class="btn btn-sm view">View</button></td></tr>`).join("")
      }</tbody></table>`;
      body.querySelectorAll("tr[data-id]").forEach((tr) => (tr.querySelector(".view").onclick = () => openDrawer(tr.dataset.id)));
    } catch (e) { body.innerHTML = `<pre class="out" style="color:var(--c-neg)">${esc(e.message)}</pre>`; }
  };
  card.querySelector(".refresh").onclick = load; load();
}

function statusBadge(s) {
  const map = { succeeded: "b-pos", running: "b-warn", queued: "b-idle", failed: "b-neg", canceled: "b-idle", interrupted: "b-warn" };
  return `<span class="badge ${map[s] || "b-idle"}"><span class="dot"></span>${esc(s)}</span>`;
}

// ---------------------------------------------------------------- activity drawer + live stream
let drawerAbort = null;
async function openDrawer(focusId) {
  S.drawer = true;
  let scrim = document.querySelector(".scrim"); let drawer = document.querySelector(".drawer");
  if (!scrim) { scrim = el(`<div class="scrim"></div>`); document.body.appendChild(scrim); scrim.onclick = closeDrawer; }
  if (!drawer) { drawer = el(`<aside class="drawer"><div class="drawer-head"><strong>${t("activity")}</strong><button class="icon-btn" id="dclose">${ic("x", 16)}</button></div><div class="drawer-body" id="dbody"></div></aside>`); document.body.appendChild(drawer); drawer.querySelector("#dclose").onclick = closeDrawer; }
  requestAnimationFrame(() => { scrim.classList.add("show"); drawer.classList.add("show"); });
  const dbody = drawer.querySelector("#dbody");
  const { jobs } = await listJobs();
  dbody.innerHTML = jobs.length ? "" : `<div class="empty">${t("noJobs")}</div>`;
  jobs.slice(0, 12).forEach((j) => dbody.appendChild(jobItem(j, j.id === focusId)));
  if (focusId) {
    const item = dbody.querySelector(`[data-job="${focusId}"]`);
    if (item) liveStream(focusId, item);
  }
}
function closeDrawer() {
  S.drawer = false;
  if (drawerAbort) drawerAbort.abort();
  document.querySelector(".scrim")?.classList.remove("show");
  document.querySelector(".drawer")?.classList.remove("show");
}
function jobItem(j, open) {
  const item = el(`<div class="job-item" data-job="${j.id}">
    <div class="top"><strong class="mono" style="font-size:12.5px">${esc(j.tool)}</strong>${statusBadge(j.status)}</div>
    ${j.status === "running" ? `<div class="bar"><i></i></div>` : ""}
    <div class="log" style="display:${open ? "block" : "none"};margin-top:8px"></div>
    <div class="row" style="margin-top:8px;display:flex;gap:6px">
      <button class="btn btn-sm toggle">${open ? "Hide" : "Logs"}</button>
      ${j.status === "running" ? `<button class="btn btn-sm btn-danger kill">${t("cancel")}</button>` : ""}
    </div>
  </div>`);
  const log = item.querySelector(".log");
  item.querySelector(".toggle").onclick = () => {
    const show = log.style.display === "none"; log.style.display = show ? "block" : "none";
    item.querySelector(".toggle").textContent = show ? "Hide" : "Logs";
    if (show && !log.dataset.streaming) liveStream(j.id, item);
  };
  item.querySelector(".kill")?.addEventListener("click", async () => { try { await cancelJob(j.id); toast("Canceled"); } catch (e) { toast(e.message, true); } });
  if (open) liveStream(j.id, item);
  return item;
}
function liveStream(id, item) {
  const log = item.querySelector(".log"); log.dataset.streaming = "1"; log.style.display = "block";
  drawerAbort = new AbortController();
  streamJob(id, (ev) => {
    if (ev.type === "log") { log.appendChild(document.createTextNode(ev.line + "\n")); log.scrollTop = log.scrollHeight; }
    if (ev.type === "status" || ev.type === "done") {
      const b = item.querySelector(".badge"); if (b && ev.status) b.outerHTML = statusBadge(ev.status);
      if (ev.type === "done") { item.querySelector(".bar")?.remove(); item.querySelector(".kill")?.remove(); }
    }
  }, drawerAbort.signal).catch(() => {});
}

// ---------------------------------------------------------------- modals
function modalShell(title, bodyNode, okLabel, onOk, danger = false) {
  const m = el(`<div class="modal"><div class="box">
    <div class="mhead ${danger ? "danger" : ""}">${esc(title)}</div>
    <div class="mbody"></div>
    <div class="mfoot"><button class="btn cancel">${t("cancel")}</button><button class="btn ${danger ? "btn-danger" : "btn-primary"} ok">${esc(okLabel)}</button></div>
  </div></div>`);
  m.querySelector(".mbody").appendChild(bodyNode);
  m.querySelector(".cancel").onclick = () => m.remove();
  m.querySelector(".ok").onclick = async () => { const close = await onOk(); if (close !== false) m.remove(); };
  return m;
}

function confirmModal(tool, args) {
  const target = args.cluster || args.server || args.name || "";
  const body = el(`<div>
    <p>${esc(tool.title)}</p>
    <p class="mono" style="background:var(--c-sunken);padding:8px 10px;border-radius:8px;font-size:12.5px">${esc(tool.name)} ${esc(JSON.stringify(args))}</p>
    <p class="muted">${t("typeToConfirm")}</p>
    <input class="input confirm-in" placeholder="${esc(target || "confirm")}">
  </div>`);
  const m = modalShell(t("destructive"), body, t("confirm"), async () => {
    const typed = body.querySelector(".confirm-in").value.trim();
    if (target && typed !== target) { toast(`Type "${target}" to confirm`, true); return false; }
    try { const r = await startJob(tool.name, args, true); toast(`Job started: ${tool.name}`); openDrawer(r.job.id); return true; }
    catch (e) { toast(e.message, true); return false; }
  }, true);
  document.body.appendChild(m);
}

// ---------------------------------------------------------------- boot
(async function boot() {
  if (!TOKEN) { document.getElementById("app").innerHTML = `<div class="empty" style="padding-top:80px">No session token. Open the URL printed by <code>--panel</code> (it carries <code>#token=…</code>).</div>`; return; }
  try { const { tools } = await api("/api/catalog"); S.catalog = tools; }
  catch (e) { document.getElementById("app").innerHTML = `<div class="empty" style="padding-top:80px">Auth failed: ${esc(e.message)}</div>`; return; }
  render();
  setInterval(async () => { if (S.drawer) { /* drawer refreshes via stream */ } }, 4000);
})();
