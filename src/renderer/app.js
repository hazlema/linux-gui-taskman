/* global Charts, api */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const C = {
  cpu: '#22d3ee', mem: '#a78bfa', net: '#34d399', up: '#f472b6',
  disk: '#fbbf24', sys: '#fb7185', danger: '#f43f5e', dim: '#5c628c', sleep: '#60a5fa',
};
const HIST = 60;

const SERVICES = {
  20: 'ftp-data', 21: 'ftp', 22: 'ssh', 25: 'smtp', 53: 'dns', 67: 'dhcp', 68: 'dhcp', 80: 'http',
  110: 'pop3', 123: 'ntp', 137: 'netbios', 138: 'netbios', 139: 'smb', 143: 'imap', 443: 'https',
  445: 'smb', 465: 'smtps', 587: 'smtp', 631: 'cups', 993: 'imaps', 995: 'pop3s', 1433: 'mssql',
  1883: 'mqtt', 3000: 'dev', 3306: 'mysql', 3389: 'rdp', 4000: 'dev', 5000: 'dev', 5173: 'vite',
  5353: 'mdns', 5432: 'postgres', 5900: 'vnc', 6379: 'redis', 8000: 'http-alt', 8080: 'http-alt',
  8443: 'https-alt', 8888: 'jupyter', 9000: 'dev', 9090: 'prometheus', 9200: 'elastic',
  11434: 'ollama', 27017: 'mongo',
};

const state = {
  info: null,
  snap: null,
  conns: [],
  byPid: new Map(),
  kids: new Map(),
  procHist: new Map(),
  hist: { cpu: [], sys: [], mem: [], rx: [], tx: [], dr: [], dw: [] },
  tab: 'overview',
  paused: false,
  rate: 1500,
  selected: null,
  dying: new Map(),
  tableHover: false,
  lastOrder: [],
  proc: { q: '', scope: 'all', state: 'any', hideKernel: true, cpuMin: 0, sort: 'cpu', dir: -1 },
  net: { q: '', state: 'listen', proto: 'any', hideLoop: false, sort: 'localPort', dir: 1 },
};

/* ---------------- formatting ---------------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtBytes(b, digits = 1) {
  if (!b || b < 1) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  const v = b / 1024 ** i;
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : digits)} ${u[i]}`;
}
const fmtRate = (b) => fmtBytes(b) + '/s';
const fmtPct = (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + '%';
function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m`;
}
function fmtStarted(str) {
  if (!str) return '—';
  const d = new Date(str.replace(' ', 'T'));
  if (isNaN(d)) return str;
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function hue(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}
const avatarStyle = (name) => `background:hsl(${hue(name)} 75% 68%)`;
const heat = (v) => `hsl(${190 - Math.min(100, v) * 1.9} 85% 55%)`;
const push = (arr, v, n = HIST) => { arr.push(v); if (arr.length > n) arr.shift(); };

const isLoopback = (a) => /^127\.|^::1$|^::ffff:127\.|^localhost$/.test(a || '');
const isWildcard = (a) => !a || a === '*' || a === '0.0.0.0' || a === '::' || a === '[::]';
const isListen = (c) => c.state === 'LISTEN' || (c.protocol.startsWith('udp') && c.state !== 'ESTABLISHED');
const svc = (port) => SERVICES[port] || '';
const procName = (pid) => state.byPid.get(pid)?.name || `PID ${pid}`;
const isKernel = (p) => p.ppid === 2 || p.pid === 2;

/* ---------------- polling ---------------- */
let tickN = 0;
let timer = null;
let busy = false;

async function tick() {
  clearTimeout(timer);
  if (busy) return;
  busy = true;
  if (!state.paused) {
    try {
      const wantConns = tickN++ % 2 === 0 || state.tab === 'remotes' || state.selected;
      const [snap, conns] = await Promise.all([api.snapshot(), wantConns ? api.connections() : null]);
      ingest(snap);
      if (conns) state.conns = conns;
      render();
    } catch (err) {
      console.error(err);
    }
  }
  busy = false;
  clearTimeout(timer);
  timer = setTimeout(tick, state.rate);
}

function ingest(snap) {
  state.snap = snap;
  const h = state.hist;
  push(h.cpu, snap.cpu.total);
  push(h.sys, snap.cpu.system);
  push(h.mem, (snap.mem.used / snap.mem.total) * 100);
  push(h.rx, snap.net.rx);
  push(h.tx, snap.net.tx);
  push(h.dr, snap.disk.read);
  push(h.dw, snap.disk.write);

  const byPid = new Map();
  const kids = new Map();
  for (const p of snap.procs) {
    byPid.set(p.pid, p);
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
    let ph = state.procHist.get(p.pid);
    if (!ph || ph.started !== p.started) {
      ph = { started: p.started, cpu: [], rss: [] };
      state.procHist.set(p.pid, ph);
    }
    push(ph.cpu, p.cpu);
    push(ph.rss, p.rss);
  }
  for (const pid of state.procHist.keys()) if (!byPid.has(pid)) state.procHist.delete(pid);
  const now = Date.now();
  for (const [pid, until] of state.dying) if (!byPid.has(pid) || now > until) state.dying.delete(pid);
  state.byPid = byPid;
  state.kids = kids;

  if (state.selected && !byPid.has(state.selected)) closeDetail();
}

/* ---------------- render dispatcher ---------------- */
function render() {
  if (!state.snap) return;
  renderRail();
  if (state.tab === 'overview') renderOverview();
  if (state.tab === 'processes') renderProcesses();
  if (state.tab === 'remotes') renderRemotes();
}

const anim = { cpu: 0, mem: 0, tCpu: 0, tMem: 0, drawnCpu: -1, drawnMem: -1 };

function renderRail() {
  const s = state.snap;
  anim.tCpu = s.cpu.total / 100;
  anim.tMem = s.mem.used / s.mem.total;
  $('#badge-procs').textContent = s.counts.all;
  const listening = new Set(state.conns.filter(isListen).map((c) => c.protocol + c.localPort));
  $('#badge-ports').textContent = listening.size;
  $('#uptime').textContent = 'up ' + fmtUptime(s.uptime);
}

/* ---------------- overview ---------------- */
let coreEls = [];
const tiles = new Map();

function renderOverview() {
  const s = state.snap;
  const h = state.hist;
  const memPct = (s.mem.used / s.mem.total) * 100;

  $('#v-cpu').textContent = fmtPct(s.cpu.total);
  $('#h-cpu').textContent = `usr ${fmtPct(s.cpu.user)} · sys ${fmtPct(s.cpu.system)}`;
  $('#v-mem').textContent = fmtPct(memPct);
  $('#h-mem').textContent = `${fmtBytes(s.mem.used)} / ${fmtBytes(s.mem.total, 0)}`;
  $('#v-rx').textContent = fmtRate(s.net.rx);
  $('#v-tx').textContent = fmtRate(s.net.tx);
  $('#v-dr').textContent = fmtRate(s.disk.read);
  $('#v-dw').textContent = fmtRate(s.disk.write);

  const la = s.loadavg.map((v) => v.toFixed(2)).join(' ');
  $('#loadavg').innerHTML =
    `<span>load <b>${la}</b></span>` +
    (s.temp ? `<span>temp <b>${Math.round(s.temp)}°C</b></span>` : '') +
    `<span>procs <b>${s.counts.all}</b></span>`;

  Charts.spark($('#spark-cpu'), [{ data: h.cpu, color: C.cpu }], { max: 100 });
  Charts.spark($('#spark-mem'), [{ data: h.mem, color: C.mem }], { max: 100 });
  Charts.spark($('#spark-net'), [{ data: h.rx, color: C.net }, { data: h.tx, color: C.up }]);
  Charts.spark($('#spark-disk'), [{ data: h.dr, color: C.disk }, { data: h.dw, color: C.sys }]);

  Charts.area($('#chart-history'), [
    { data: h.mem, color: C.mem },
    { data: h.cpu, color: C.cpu },
    { data: h.sys, color: C.sys, fill: false, width: 1.5 },
  ]);
  Charts.mirror($('#chart-net'), { data: h.rx, color: C.net }, { data: h.tx, color: C.up }, { fmt: (v) => fmtBytes(v, 0) });

  renderCores(s.cpu.cores);
  $('#core-temp').textContent = `${s.cpu.cores.length} threads`;
  renderTreemap();
  renderMemStack();

  const c = s.counts;
  Charts.donut($('#donut-states'), [
    { label: 'Running', value: c.running, color: '#4ade80' },
    { label: 'Sleeping', value: c.sleeping, color: C.sleep },
    { label: 'Blocked', value: c.blocked, color: C.disk },
    { label: 'Other', value: c.unknown + Math.max(0, c.all - c.running - c.sleeping - c.blocked - c.unknown), color: C.dim },
  ]);

  const top = [...s.procs].sort((a, b) => b.cpu - a.cpu).slice(0, 7);
  const peak = Math.max(1, top[0]?.cpu || 1);
  $('#top-cpu').innerHTML = top
    .map((p) => `<li data-pid="${p.pid}"><span class="nm"><span class="avatar" style="${avatarStyle(p.name)};display:inline-grid;width:16px;height:16px;font-size:9px;margin-right:6px;vertical-align:-3px">${esc(p.name[0]?.toUpperCase())}</span>${esc(p.name)} <span class="dim mono">${p.pid}</span></span><span class="pc">${fmtPct(p.cpu)}</span><span class="bar"><i style="width:${(p.cpu / peak) * 100}%"></i></span></li>`)
    .join('');
}

function renderCores(loads) {
  const box = $('#cores');
  if (coreEls.length !== loads.length) {
    box.innerHTML = loads.map((_, i) => `<div class="core" title="CPU ${i}"><div class="fill"></div><span></span></div>`).join('');
    coreEls = $$('.core', box).map((el) => ({ fill: $('.fill', el), label: $('span', el) }));
  }
  loads.forEach((v, i) => {
    const el = coreEls[i];
    el.fill.style.height = Math.max(4, v) + '%';
    el.fill.style.background = `linear-gradient(180deg, ${heat(v)}, ${heat(v).replace('55%)', '35%)')})`;
    el.label.textContent = Math.round(v);
  });
}

function renderTreemap() {
  const box = $('#treemap');
  const w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;
  const groups = new Map();
  for (const p of state.snap.procs) {
    if (!p.rss) continue;
    const g = groups.get(p.name) || { name: p.name, value: 0, count: 0, cpu: 0 };
    g.value += p.rss;
    g.count++;
    g.cpu += p.cpu;
    groups.set(p.name, g);
  }
  const sorted = [...groups.values()].sort((a, b) => b.value - a.value);
  const items = sorted.slice(0, 16);
  const rest = sorted.slice(16).reduce((a, g) => a + g.value, 0);
  if (rest) items.push({ name: '…everything else', value: rest, count: sorted.length - 16, cpu: 0, other: true });

  const laid = Charts.squarify(items, 0, 0, w, h);
  const seen = new Set();
  for (const t of laid) {
    seen.add(t.name);
    let el = tiles.get(t.name);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tile';
      el.dataset.name = t.name;
      const hh = hue(t.name);
      el.style.background = t.other
        ? 'linear-gradient(135deg, #1d2244, #141830)'
        : `linear-gradient(135deg, hsl(${hh} 70% 45% / 0.9), hsl(${(hh + 40) % 360} 70% 30% / 0.9))`;
      box.appendChild(el);
      tiles.set(t.name, el);
    }
    Object.assign(el.style, { left: t.x + 'px', top: t.y + 'px', width: t.w + 'px', height: t.h + 'px' });
    const big = t.w > 70 && t.h > 38;
    el.innerHTML = big ? `<b>${esc(t.name)}</b><small>${fmtBytes(t.value)}${t.count > 1 ? ' · ×' + t.count : ''}</small>` : '';
    el.title = `${t.name}\n${fmtBytes(t.value)} across ${t.count} process${t.count > 1 ? 'es' : ''}`;
    if (t.other) el.dataset.other = '1';
  }
  for (const [name, el] of tiles) if (!seen.has(name)) { el.remove(); tiles.delete(name); }
}

function renderMemStack() {
  const m = state.snap.mem;
  const parts = [
    { label: 'In use', v: m.used, color: C.mem },
    { label: 'Cache', v: m.cache, color: Charts.alpha(C.cpu, 0.55) },
    { label: 'Free', v: m.free, color: '#2a3060' },
  ];
  $('#mem-stack').innerHTML = parts.map((p) => `<i style="width:${(p.v / m.total) * 100}%;background:${p.color}"></i>`).join('');
  $('#mem-legend').innerHTML =
    parts.map((p) => `<div><i style="background:${p.color}"></i>${p.label}<b>${fmtBytes(p.v)}</b></div>`).join('') +
    `<div><i style="background:${C.sys}"></i>Swap<b>${fmtBytes(m.swapUsed)} / ${fmtBytes(m.swapTotal, 0)}</b></div>`;
}

/* ---------------- processes ---------------- */
function matchesTerms(hay, terms) {
  return terms.every((t) => hay.includes(t));
}

function filteredProcs() {
  const f = state.proc;
  const q = f.q.trim().toLowerCase();
  const portQ = q.match(/^:(\d+)$/);
  const portPids = portQ
    ? new Set(state.conns.filter((c) => String(c.localPort) === portQ[1] || String(c.peerPort) === portQ[1]).map((c) => c.pid))
    : null;
  const terms = portQ ? [] : q.split(/\s+/).filter(Boolean);
  const me = state.info?.user;

  const list = state.snap.procs.filter((p) => {
    if (f.hideKernel && isKernel(p)) return false;
    if (f.scope === 'mine' && p.user !== me) return false;
    if (f.scope === 'root' && p.user !== 'root') return false;
    if (f.state !== 'any' && p.state !== f.state) return false;
    if (p.cpu < f.cpuMin) return false;
    if (portPids) return portPids.has(p.pid);
    if (terms.length && !matchesTerms(`${p.name} ${p.pid} ${p.user} ${p.command}`.toLowerCase(), terms)) return false;
    return true;
  });

  if (state.tableHover && state.lastOrder.length) {
    // Hold row order while the pointer is over the table so targets don't jump away from a right-click.
    const idx = new Map(state.lastOrder.map((pid, i) => [pid, i]));
    list.sort((a, b) => (idx.get(a.pid) ?? 1e9) - (idx.get(b.pid) ?? 1e9));
  } else {
    const k = f.sort, d = f.dir;
    list.sort((a, b) => {
      const x = a[k], y = b[k];
      const r = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
      return r * d || a.pid - b.pid;
    });
  }
  state.lastOrder = list.map((p) => p.pid);
  return list;
}

function renderProcesses() {
  const list = filteredProcs();
  const own = new Set(state.info?.ownPids || []);
  const maxRss = Math.max(1, ...list.map((p) => p.rss));
  const me = state.info?.user;

  const rows = list.map((p) => {
    const ph = state.procHist.get(p.pid);
    const cls = [p.pid === state.selected ? 'selected' : '', state.dying.has(p.pid) ? 'gone' : ''].join(' ');
    const hot = p.cpu >= 25 ? ' hot' : '';
    return `<tr data-pid="${p.pid}" class="${cls}">
      <td><div class="pname"><span class="avatar" style="${avatarStyle(p.name)}">${esc(p.name[0]?.toUpperCase() || '?')}</span><span>${esc(p.name)}${own.has(p.pid) ? '<span class="tag">THIS APP</span>' : ''}</span></div></td>
      <td class="num mono">${p.pid}</td>
      <td class="mono ${p.user === me ? '' : 'dim'}">${esc(p.user)}</td>
      <td><span class="state ${esc(p.state)}">${esc(p.state)}</span></td>
      <td><div class="meter cpu${hot}"><div class="track"><i style="width:${Math.min(100, p.cpu)}%"></i></div><b>${p.cpu.toFixed(1)}%</b></div></td>
      <td class="trend">${Charts.svgSpark(ph ? ph.cpu.slice(-30) : [], p.cpu >= 25 ? C.danger : C.cpu, 5)}</td>
      <td><div class="meter mem"><div class="track"><i style="width:${(p.rss / maxRss) * 100}%"></i></div><b>${fmtBytes(p.rss)}</b></div></td>
      <td class="mono dim">${fmtStarted(p.started)}</td>
      <td class="mono dim" title="${esc(p.command)}">${esc(p.command)}</td>
    </tr>`;
  });
  $('#proc-table tbody').innerHTML = rows.join('');
  $('#proc-empty').hidden = list.length > 0;

  const total = state.snap.procs.length;
  const hidden = state.proc.hideKernel ? state.snap.procs.filter(isKernel).length : 0;
  $('#proc-count').textContent =
    `Showing ${list.length} of ${total} processes` +
    (hidden ? ` · ${hidden} kernel threads hidden` : '') +
    (state.tableHover ? ' · order held while hovering' : '');

  const f = state.proc;
  $('#proc-clear').hidden = !(f.q || f.scope !== 'all' || f.state !== 'any' || f.cpuMin > 0 || !f.hideKernel);
  if (state.selected) updateDetail();
}

/* ---------------- process detail drawer ---------------- */
function openDetail(pid) {
  state.selected = pid;
  const el = $('#proc-detail');
  el.hidden = false;
  $('.proc-layout').classList.add('has-detail');
  el.innerHTML = `
    <div class="top">
      <span class="avatar" id="d-av"></span>
      <div style="min-width:0"><h3 id="d-name"></h3><span class="muted" id="d-sub"></span></div>
      <button class="x" data-act="close" title="Close (Esc)">✕</button>
    </div>
    <div class="actions">
      <button class="ghost-btn" data-act="term">End process</button>
      <button class="danger-btn" data-act="kill">Force kill</button>
      <button class="ghost-btn" data-act="stop" id="d-stop">Suspend</button>
      <button class="ghost-btn" data-act="tree">Kill tree</button>
    </div>
    <div class="section-title">CPU · last 90s</div><canvas id="d-cpu"></canvas>
    <div class="section-title">Memory</div><canvas id="d-mem"></canvas>
    <dl class="kv" id="d-kv"></dl>
    <div class="section-title">Sockets</div><div class="port-pills" id="d-ports"></div>
    <div class="section-title">Command</div><div class="cmd" id="d-cmd"></div>`;
  $$('#proc-table tbody tr').forEach((tr) => tr.classList.toggle('selected', +tr.dataset.pid === pid));
  updateDetail();
}

function closeDetail() {
  state.selected = null;
  $('#proc-detail').hidden = true;
  $('.proc-layout').classList.remove('has-detail');
  $$('#proc-table tbody tr.selected').forEach((tr) => tr.classList.remove('selected'));
}

function updateDetail() {
  const p = state.byPid.get(state.selected);
  if (!p || $('#proc-detail').hidden) return;
  const ph = state.procHist.get(p.pid) || { cpu: [], rss: [] };
  const av = $('#d-av');
  av.setAttribute('style', avatarStyle(p.name));
  av.textContent = p.name[0]?.toUpperCase() || '?';
  $('#d-name').textContent = p.name;
  $('#d-sub').textContent = `PID ${p.pid} · ${p.state}`;

  const cpuMax = Math.max(5, ...ph.cpu) * 1.2;
  Charts.area($('#d-cpu'), [{ data: ph.cpu, color: C.cpu }], { max: cpuMax, fmt: (v) => v.toFixed(0) + '%' });
  const memMax = Math.max(1, ...ph.rss) * 1.25;
  Charts.area($('#d-mem'), [{ data: ph.rss, color: C.mem }], { max: memMax, fmt: (v) => fmtBytes(v, 0).replace(' ', '') });

  const parent = state.byPid.get(p.ppid);
  const kids = state.kids.get(p.pid) || [];
  $('#d-kv').innerHTML = `
    <dt>CPU</dt><dd>${p.cpu.toFixed(1)}%</dd>
    <dt>Memory</dt><dd>${fmtBytes(p.rss)} (${p.mem.toFixed(1)}%)</dd>
    <dt>User</dt><dd>${esc(p.user)}</dd>
    <dt>Parent</dt><dd>${parent ? `<a data-act="goto" data-pid="${parent.pid}">${esc(parent.name)} (${parent.pid})</a>` : p.ppid}</dd>
    <dt>Children</dt><dd>${kids.length}</dd>
    <dt>Nice</dt><dd>${p.nice}</dd>
    <dt>Started</dt><dd>${esc(p.started)}</dd>
    ${p.path ? `<dt>Path</dt><dd>${esc(p.path)}</dd>` : ''}`;

  const socks = state.conns.filter((c) => c.pid === p.pid);
  $('#d-ports').innerHTML = socks.length
    ? socks.slice(0, 40).map((c) => isListen(c)
        ? `<span class="pill" title="${esc(c.localAddress)}">:${esc(c.localPort)} ${c.protocol.startsWith('udp') ? 'udp' : 'listen'}</span>`
        : `<span class="pill est" title="${esc(c.state)}">→ ${esc(c.peerAddress)}:${esc(c.peerPort)}</span>`).join('')
    : '<span class="muted">No sockets</span>';
  const cmd = $('#d-cmd');
  if (cmd.textContent !== p.command) cmd.textContent = p.command || p.name;
  $('#d-stop').textContent = p.state === 'stopped' ? 'Resume' : 'Suspend';
}

/* ---------------- remotes ---------------- */
function filteredConns() {
  const f = state.net;
  const terms = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = state.conns.filter((c) => {
    if (f.state === 'listen' && !isListen(c)) return false;
    if (f.state === 'established' && c.state !== 'ESTABLISHED') return false;
    if (f.proto !== 'any' && !c.protocol.startsWith(f.proto)) return false;
    if (f.hideLoop && isLoopback(c.localAddress) && (isListen(c) || isLoopback(c.peerAddress))) return false;
    if (terms.length) {
      const name = c.pid ? procName(c.pid) : c.process;
      const hay = `${c.protocol} ${c.localAddress}:${c.localPort} ${c.peerAddress}:${c.peerPort} ${c.state} ${name} ${c.pid ?? ''} ${svc(c.localPort)}`.toLowerCase();
      if (!matchesTerms(hay, terms)) return false;
    }
    return true;
  });
  const k = f.sort, d = f.dir;
  const val = (c) => {
    if (k === 'localPort') return +c.localPort || 0;
    if (k === 'peer') return `${c.peerAddress}:${c.peerPort}`;
    if (k === 'process') return c.pid ? procName(c.pid) : '~';
    return c[k] ?? '';
  };
  list.sort((a, b) => {
    const x = val(a), y = val(b);
    const r = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
    return r * d || (+a.localPort || 0) - (+b.localPort || 0);
  });
  return list;
}

function renderRemotes() {
  const all = state.conns;
  const listen = new Set(all.filter(isListen).map((c) => c.protocol + c.localPort));
  const est = all.filter((c) => c.state === 'ESTABLISHED');
  const hosts = new Set(est.filter((c) => !isLoopback(c.peerAddress) && !isWildcard(c.peerAddress)).map((c) => c.peerAddress));
  const pids = new Set(all.filter((c) => c.pid).map((c) => c.pid));
  const hidden = all.filter((c) => !c.pid).length;
  $('#n-listen').textContent = listen.size;
  $('#n-est').textContent = est.length;
  $('#n-hosts').textContent = hosts.size;
  $('#n-procs').textContent = pids.size;
  $('#n-hidden').textContent = hidden ? `${hidden} sockets owned by other users` : 'with sockets';

  const list = filteredConns();
  $('#net-table').classList.toggle('listen-mode', state.net.state === 'listen');
  $('#net-table tbody').innerHTML = list.map((c, i) => {
    const udp = c.protocol.startsWith('udp');
    const name = c.pid ? procName(c.pid) : '';
    const remote = isListen(c) || isWildcard(c.peerAddress) ? '<span class="dim">—</span>' : `<span class="mono">${esc(c.peerAddress)}:${esc(c.peerPort)}</span>${svc(c.peerPort) ? `<span class="svc">${svc(c.peerPort)}</span>` : ''}`;
    return `<tr data-i="${i}" class="${state.dying.has(c.pid) ? 'gone' : ''}">
      <td><span class="proto ${udp ? 'udp' : ''}">${esc(c.protocol)}</span></td>
      <td class="num"><span class="port">${esc(c.localPort)}</span>${svc(c.localPort) ? `<span class="svc">${svc(c.localPort)}</span>` : ''}</td>
      <td class="mono ${isLoopback(c.localAddress) ? 'dim' : ''}">${esc(c.localAddress)}</td>
      <td title="${isListen(c) ? '' : esc(c.peerAddress + ':' + c.peerPort)}">${remote}</td>
      <td><span class="nstate ${esc(c.state)}">${esc(c.state || '—')}</span></td>
      <td>${c.pid
        ? `<div class="pname"><span class="avatar" style="${avatarStyle(name)}">${esc(name[0]?.toUpperCase())}</span><span>${esc(name)} <span class="dim mono">${c.pid}</span></span></div>`
        : '<span class="dim" title="Run as root to see owners of other users’ sockets">hidden · other user</span>'}</td>
    </tr>`;
  }).join('');
  state.netRows = list;
  $('#net-empty').hidden = list.length > 0;
  buildConstellation();
}

/* ---------------- constellation (animated socket graph) ---------------- */
const cons = { nodes: new Map(), links: [], hover: null, rect: null };

function buildConstellation() {
  const procs = new Map();
  const hosts = new Map();
  for (const c of state.conns) {
    const key = c.pid ? 'p' + c.pid : 'hidden';
    let p = procs.get(key);
    if (!p) {
      p = { key, kind: 'proc', pid: c.pid, name: c.pid ? procName(c.pid) : 'other users', listen: new Set(), est: 0, hosts: new Set() };
      procs.set(key, p);
    }
    if (isListen(c)) p.listen.add(c.localPort + (c.protocol.startsWith('udp') ? '/u' : ''));
    else if (c.state === 'ESTABLISHED') {
      p.est++;
      if (!isLoopback(c.peerAddress) && !isWildcard(c.peerAddress)) {
        p.hosts.add(c.peerAddress);
        const hk = 'h' + c.peerAddress;
        const h = hosts.get(hk) || { key: hk, kind: 'host', name: c.peerAddress, procs: new Set(), n: 0 };
        h.procs.add(key);
        h.n++;
        hosts.set(hk, h);
      }
    }
  }

  const plist = [...procs.values()].sort((a, b) => (a.key === 'hidden') - (b.key === 'hidden') || a.name.localeCompare(b.name));
  plist.forEach((p, i) => {
    p.angle = (i / plist.length) * Math.PI * 2 - Math.PI / 2;
    p.ring = 0.55;
  });
  const hlist = [...hosts.values()];
  for (const h of hlist) {
    let sx = 0, sy = 0;
    for (const k of h.procs) { sx += Math.cos(procs.get(k).angle); sy += Math.sin(procs.get(k).angle); }
    h.want = Math.atan2(sy, sx);
  }
  hlist.sort((a, b) => a.want - b.want);
  // spread hosts round the outer ring in the order of their owning processes, so links stay short
  const gap = hlist.length ? (Math.PI * 2) / hlist.length : 0;
  const base = hlist[0]?.want ?? 0;
  hlist.forEach((h, i) => { h.angle = base + i * gap; h.ring = 0.9; });

  const next = new Map();
  for (const n of [...plist, ...hlist]) {
    const old = cons.nodes.get(n.key);
    n.x = old ? old.x : 0;
    n.y = old ? old.y : 0;
    n.tx = Math.cos(n.angle) * n.ring;
    n.ty = Math.sin(n.angle) * n.ring;
    next.set(n.key, n);
  }
  cons.nodes = next;
  cons.links = [];
  for (const h of hlist) for (const k of h.procs) cons.links.push({ a: k, b: h.key, seed: hue(h.key + k) / 360 });
}

function drawConstellation(t) {
  const canvas = $('#constellation');
  if (!canvas.clientWidth) return;
  const { ctx, w, h } = Charts.prep(canvas);
  const cx = w / 2, cy = h / 2;
  // an ellipse uses the whole card, which is usually taller than it is wide
  const Rx = Math.max(60, w / 2 - 95), Ry = Math.max(60, Math.min(h / 2 - 30, Rx * 1.9));
  const R = Math.min(Rx, Ry);
  cons.rect = { cx, cy, Rx, Ry };
  const P = (n) => [cx + n.x * Rx, cy + n.y * Ry];

  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  glow.addColorStop(0, 'rgba(34, 211, 238, 0.10)');
  glow.addColorStop(1, 'rgba(34, 211, 238, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  ctx.setLineDash([2, 6]);
  ctx.strokeStyle = 'rgba(92, 98, 140, 0.35)';
  for (const r of [0.55, 0.9]) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * Rx, r * Ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const n of cons.nodes.values()) {
    n.x += (n.tx - n.x) * 0.08;
    n.y += (n.ty - n.y) * 0.08;
  }
  const hov = cons.hover && cons.nodes.get(cons.hover);
  const related = (k) => !hov || k === hov.key || (hov.kind === 'proc' ? hov.hosts?.has(cons.nodes.get(k)?.name) : hov.procs?.has(k));

  // spokes from the hub
  for (const n of cons.nodes.values()) {
    if (n.kind !== 'proc') continue;
    const [x, y] = P(n);
    ctx.strokeStyle = related(n.key) ? 'rgba(92, 98, 140, 0.35)' : 'rgba(92, 98, 140, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  // process -> host links with travelling packets
  for (const l of cons.links) {
    const a = cons.nodes.get(l.a), b = cons.nodes.get(l.b);
    if (!a || !b) continue;
    const [ax, ay] = P(a), [bx, by] = P(b);
    const on = !hov || hov.key === a.key || hov.key === b.key;
    ctx.strokeStyle = on ? 'rgba(34, 211, 238, 0.45)' : 'rgba(34, 211, 238, 0.07)';
    ctx.lineWidth = on && hov ? 1.8 : 1;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    if (on) {
      for (const off of [0, 0.5]) {
        const f = (t / 2200 + l.seed + off) % 1;
        ctx.fillStyle = off ? C.up : C.cpu;
        ctx.beginPath();
        ctx.arc(ax + (bx - ax) * (off ? 1 - f : f), ay + (by - ay) * (off ? 1 - f : f), 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // hub
  ctx.fillStyle = '#141830';
  ctx.strokeStyle = C.cpu;
  ctx.lineWidth = 2;
  ctx.shadowColor = C.cpu;
  ctx.shadowBlur = 16 + Math.sin(t / 500) * 6;
  ctx.beginPath();
  ctx.arc(cx, cy, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#e8eaf8';
  ctx.font = '600 10px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((state.info?.hostname || 'host').slice(0, 7), cx, cy);

  const nProcs = [...cons.nodes.values()].filter((n) => n.kind === 'proc').length;
  const nHosts = cons.nodes.size - nProcs;
  for (const n of cons.nodes.values()) {
    const [x, y] = P(n);
    const dimmed = !related(n.key);
    ctx.globalAlpha = dimmed ? 0.25 : 1;
    if (n.kind === 'proc') {
      const r = 5 + Math.min(9, Math.sqrt(n.listen.size + n.est) * 2);
      n.r = r;
      const color = n.key === 'hidden' ? C.dim : n.est ? C.cpu : C.net;
      // listening ports orbit their process
      const ports = [...n.listen].slice(0, 10);
      ports.forEach((_, i) => {
        const a = t / 1800 + (i / ports.length) * Math.PI * 2;
        ctx.fillStyle = C.net;
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * (r + 6), y + Math.sin(a) * (r + 6), 2, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.fillStyle = Charts.alpha(color, 0.25);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (nProcs <= 36 || hov === n) {
        ctx.fillStyle = '#c9cdea';
        ctx.font = '11px ui-sans-serif, system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(n.name.slice(0, 16), x, y + r + 12);
      }
    } else {
      n.r = 5;
      ctx.fillStyle = C.mem;
      ctx.shadowColor = C.mem;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      if (nHosts <= 18 || hov === n) {
        ctx.fillStyle = '#9b93c9';
        ctx.font = '10px ui-monospace, monospace';
        const out = Math.cos(n.angle) >= 0;
        ctx.textAlign = out ? 'left' : 'right';
        ctx.fillText(n.name, x + (out ? 9 : -9), y);
      }
    }
    ctx.globalAlpha = 1;
  }

  if (hov) drawTooltip(ctx, hov, P(hov), w);
}

function drawTooltip(ctx, n, [x, y], w) {
  const lines = n.kind === 'proc'
    ? [n.name + (n.pid ? `  (${n.pid})` : ''),
       n.listen.size ? `listening: ${[...n.listen].slice(0, 6).join(', ')}${n.listen.size > 6 ? '…' : ''}` : 'no listening ports',
       `${n.est} established · ${n.hosts.size} remote hosts`,
       n.pid ? 'click: filter · right-click: kill' : '']
    : [n.name, `${n.n} connection${n.n > 1 ? 's' : ''}`, 'click: filter table'];
  const text = lines.filter(Boolean);
  ctx.font = '11px ui-monospace, monospace';
  const tw = Math.max(...text.map((l) => ctx.measureText(l).width)) + 20;
  const th = text.length * 16 + 12;
  const bx = Math.min(w - tw - 6, x + 14), by = Math.max(6, y - th - 10);
  ctx.fillStyle = 'rgba(10, 12, 22, 0.94)';
  ctx.strokeStyle = '#262c52';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(bx, by, tw, th, 8) : ctx.rect(bx, by, tw, th);
  ctx.fill();
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  text.forEach((l, i) => {
    ctx.fillStyle = i === 0 ? '#e8eaf8' : '#8b91bd';
    ctx.font = i === 0 ? '600 12px ui-sans-serif, system-ui' : '11px ui-monospace, monospace';
    ctx.fillText(l, bx + 10, by + 8 + i * 16);
  });
  ctx.textBaseline = 'middle';
}

function nodeAt(ev) {
  const canvas = $('#constellation');
  const r = canvas.getBoundingClientRect();
  const mx = ev.clientX - r.left, my = ev.clientY - r.top;
  if (!cons.rect) return null;
  const { cx, cy, Rx, Ry } = cons.rect;
  let best = null, bestD = 16;
  for (const n of cons.nodes.values()) {
    const d = Math.hypot(cx + n.x * Rx - mx, cy + n.y * Ry - my) - (n.r || 5);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

/* ---------------- animation loop ---------------- */
function frame(t) {
  anim.cpu += (anim.tCpu - anim.cpu) * 0.12;
  anim.mem += (anim.tMem - anim.mem) * 0.12;
  if (Math.abs(anim.cpu - anim.drawnCpu) > 0.0015) {
    Charts.ring($('#rail-cpu'), anim.cpu, C.cpu, { thickness: 5 });
    if (state.tab === 'overview') Charts.ring($('#ring-cpu'), anim.cpu, C.cpu);
    anim.drawnCpu = anim.cpu;
  }
  if (Math.abs(anim.mem - anim.drawnMem) > 0.0015) {
    Charts.ring($('#rail-mem'), anim.mem, C.mem, { thickness: 5 });
    if (state.tab === 'overview') Charts.ring($('#ring-mem'), anim.mem, C.mem);
    anim.drawnMem = anim.mem;
  }
  if (state.tab === 'remotes') drawConstellation(t);
  if (state.tab === 'logs') renderLogsFrame();
  requestAnimationFrame(frame);
}

/* ---------------- signals ---------------- */
function descendants(pid) {
  const out = [];
  const walk = (p) => {
    for (const k of state.kids.get(p) || []) { walk(k); out.push(k); }
  };
  walk(pid);
  return out;
}

async function sendSignal(pids, signal, what) {
  const res = await api.signal(pids, signal);
  const ok = res.filter((r) => r.ok);
  const bad = res.filter((r) => !r.ok);
  if (signal === 'SIGTERM' || signal === 'SIGKILL') {
    const until = Date.now() + 4000;
    ok.forEach((r) => state.dying.set(r.pid, until));
  }
  const verb = { SIGTERM: 'Asked to end', SIGKILL: 'Force-killed', SIGSTOP: 'Suspended', SIGCONT: 'Resumed' }[signal] || 'Signalled';
  if (ok.length) toast(`${verb} ${what}`);
  if (bad.length) toast(`${bad.length > 1 ? bad.length + ' failed: ' : ''}${bad[0].error}`, 'err');
  render();
  setTimeout(tick, 350);
  if (signal === 'SIGTERM' && ok.length === 1) {
    const pid = ok[0].pid;
    setTimeout(() => {
      if (state.byPid.has(pid)) toast(`${procName(pid)} is still running. Right-click → Force kill if it is stuck.`, 'err');
    }, 4000);
  }
}

const label = (pid) => `${procName(pid)} (${pid})`;
const endProc = (pid) => sendSignal([pid], 'SIGTERM', label(pid));

async function forceKill(pid) {
  const ok = await confirmBox('Force kill?', `<b>${esc(label(pid))}</b> will be stopped immediately with SIGKILL. Unsaved work in it will be lost.`, 'Force kill');
  if (ok) sendSignal([pid], 'SIGKILL', label(pid));
}

async function killTree(pid) {
  const kids = descendants(pid);
  const ok = await confirmBox('Kill process tree?', `End <b>${esc(label(pid))}</b> and its <b>${kids.length}</b> descendant process${kids.length === 1 ? '' : 'es'} with SIGTERM.`, 'Kill tree');
  if (ok) sendSignal([...kids, pid], 'SIGTERM', `${procName(pid)} and ${kids.length} children`);
}

async function killByName(name) {
  const pids = state.snap.procs.filter((p) => p.name === name).map((p) => p.pid);
  const ok = await confirmBox(`End all “${esc(name)}”?`, `Send SIGTERM to <b>${pids.length}</b> process${pids.length === 1 ? '' : 'es'} named <b>${esc(name)}</b>.`, 'End all');
  if (ok) sendSignal(pids, 'SIGTERM', `${pids.length} × ${name}`);
}

function toggleStop(pid) {
  const p = state.byPid.get(pid);
  if (!p) return;
  if (p.state === 'stopped') sendSignal([pid], 'SIGCONT', label(pid));
  else sendSignal([pid], 'SIGSTOP', label(pid));
}

/* ---------------- context menus ---------------- */
const ICONS = {
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  skull: '<svg viewBox="0 0 24 24"><path d="M12 3a8 8 0 0 0-8 8c0 3 1.5 4.5 3 5.5V20h10v-3.5c1.5-1 3-2.5 3-5.5a8 8 0 0 0-8-8z"/><circle cx="9" cy="11" r="1.5"/><circle cx="15" cy="11" r="1.5"/></svg>',
  tree: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M12 7v5M12 12l-6 5M12 12l6 5"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
  plug: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/></svg>',
  filter: '<svg viewBox="0 0 24 24"><path d="M4 5h16l-6 8v6l-4-2v-4z"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
};

let menuActions = [];
function openMenu(x, y, title, items) {
  const el = $('#ctx');
  menuActions = [];
  el.innerHTML = `<div class="ctx-title">${title}</div>` + items.map((it) => {
    if (it === '-') return '<hr>';
    menuActions.push(it.run);
    return `<button data-i="${menuActions.length - 1}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>${ICONS[it.icon] || ''}<span>${it.label}</span>${it.kbd ? `<kbd>${it.kbd}</kbd>` : ''}</button>`;
  }).join('');
  el.hidden = false;
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  el.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
const closeMenu = () => { $('#ctx').hidden = true; };

function procMenu(pid, x, y) {
  const p = state.byPid.get(pid);
  if (!p) return;
  const kids = descendants(pid).length;
  const hasSockets = state.conns.some((c) => c.pid === pid);
  const own = (state.info?.ownPids || []).includes(pid);
  openMenu(x, y, `<b>${esc(p.name)}</b> · PID ${pid} · ${esc(p.user)}`, [
    { label: 'End process', icon: 'x', kbd: 'Del', danger: true, disabled: own, run: () => endProc(pid) },
    { label: 'Force kill', icon: 'skull', kbd: '⇧Del', danger: true, disabled: own, run: () => forceKill(pid) },
    { label: `Kill process tree${kids ? ` (${kids} children)` : ''}`, icon: 'tree', danger: true, disabled: own || !kids, run: () => killTree(pid) },
    { label: `End all “${esc(p.name)}”`, icon: 'x', danger: true, disabled: own, run: () => killByName(p.name) },
    '-',
    p.state === 'stopped'
      ? { label: 'Resume', icon: 'play', disabled: own, run: () => toggleStop(pid) }
      : { label: 'Suspend', icon: 'pause', disabled: own, run: () => toggleStop(pid) },
    '-',
    { label: 'Details', icon: 'info', kbd: '↵', run: () => { switchTab('processes'); openDetail(pid); } },
    { label: 'Show its ports', icon: 'plug', disabled: !hasSockets, run: () => showPortsFor(pid) },
    { label: `Filter to “${esc(p.name)}”`, icon: 'filter', run: () => filterProcsTo(p.name) },
    { label: 'Copy PID', icon: 'copy', run: () => copy(String(pid)) },
    { label: 'Copy command line', icon: 'copy', run: () => copy(p.command || p.name) },
  ]);
}

function connMenu(c, x, y) {
  const name = c.pid ? procName(c.pid) : 'unknown owner';
  const local = `${c.localAddress}:${c.localPort}`;
  const remote = isWildcard(c.peerAddress) ? null : `${c.peerAddress}:${c.peerPort}`;
  openMenu(x, y, `<b>${esc(c.protocol)} ${esc(c.localPort)}</b> · ${esc(name)}${c.pid ? ` (${c.pid})` : ''}`, [
    { label: c.pid ? `Kill ${esc(name)}` : 'Owner hidden (another user)', icon: 'x', danger: true, disabled: !c.pid, run: () => endProc(c.pid) },
    { label: 'Force kill', icon: 'skull', danger: true, disabled: !c.pid, run: () => forceKill(c.pid) },
    '-',
    { label: 'Show process', icon: 'info', disabled: !c.pid, run: () => { switchTab('processes'); filterProcsTo(''); openDetail(c.pid); } },
    { label: `Copy ${esc(local)}`, icon: 'copy', run: () => copy(local) },
    { label: remote ? `Copy ${esc(remote)}` : 'Copy remote address', icon: 'copy', disabled: !remote, run: () => copy(remote) },
    { label: 'Copy PID', icon: 'copy', disabled: !c.pid, run: () => copy(String(c.pid)) },
  ]);
}

function copy(text) {
  api.copy(text);
  toast(`Copied ${text.length > 40 ? text.slice(0, 40) + '…' : text}`);
}

/* ---------------- modal + toast ---------------- */
function confirmBox(title, html, okLabel) {
  return new Promise((resolve) => {
    $('#modal-title').innerHTML = title;
    $('#modal-body').innerHTML = html;
    $('#modal-ok').textContent = okLabel;
    const m = $('#modal');
    m.hidden = false;
    $('#modal-ok').focus();
    const done = (v) => {
      m.hidden = true;
      m.onclick = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); done(true); }
    };
    document.addEventListener('keydown', onKey, true);
    m.onclick = (e) => {
      if (e.target.id === 'modal-ok') done(true);
      else if (e.target.id === 'modal-cancel' || e.target === m) done(false);
    };
  });
}

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3600);
}

/* ---------------- navigation helpers ---------------- */
function switchTab(tab) {
  state.tab = tab;
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + tab));
  closeMenu();
  anim.drawnCpu = anim.drawnMem = -1;
  if (tab === 'logs') { logs.dirty = true; logs.lastCharts = 0; }
  render();
}

function filterProcsTo(q) {
  state.proc.q = q;
  $('#proc-search').value = q;
  switchTab('processes');
}

function showPortsFor(pid) {
  state.net.q = String(pid);
  state.net.state = 'all';
  $('#net-search').value = String(pid);
  setChip('#net-state', 'nstate', 'all');
  switchTab('remotes');
}

function setChip(group, key, value) {
  $$(`${group} .chip`).forEach((c) => c.classList.toggle('active', c.dataset[key] === value));
}

function setPaused(p) {
  state.paused = p;
  document.body.classList.toggle('paused', p);
  const b = $('#pause-btn');
  b.classList.toggle('on', p);
  b.innerHTML = p ? `${ICONS.play}<span>Resume</span>` : `${ICONS.pause}<span>Pause</span>`;
  if (!p) tick();
}

/* ---------------- wiring ---------------- */
function wire() {
  $$('.tab-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#pause-btn').addEventListener('click', () => setPaused(!state.paused));
  $('#rate').addEventListener('change', (e) => { state.rate = +e.target.value; tick(); });

  // process filters
  $('#proc-search').addEventListener('input', (e) => { state.proc.q = e.target.value; renderProcesses(); });
  $('#proc-scope').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    state.proc.scope = c.dataset.scope; setChip('#proc-scope', 'scope', c.dataset.scope); renderProcesses();
  });
  $('#proc-state').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    state.proc.state = c.dataset.state; setChip('#proc-state', 'state', c.dataset.state); renderProcesses();
  });
  $('#hide-kernel').addEventListener('change', (e) => { state.proc.hideKernel = e.target.checked; renderProcesses(); });
  $('#cpu-min').addEventListener('input', (e) => {
    state.proc.cpuMin = +e.target.value;
    $('#cpu-min-v').textContent = e.target.value + '%';
    renderProcesses();
  });
  $('#proc-clear').addEventListener('click', () => {
    Object.assign(state.proc, { q: '', scope: 'all', state: 'any', hideKernel: true, cpuMin: 0 });
    $('#proc-search').value = '';
    $('#hide-kernel').checked = true;
    $('#cpu-min').value = 0;
    $('#cpu-min-v').textContent = '0%';
    setChip('#proc-scope', 'scope', 'all');
    setChip('#proc-state', 'state', 'any');
    renderProcesses();
  });
  $$('#proc-table th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    const f = state.proc;
    f.dir = f.sort === k ? -f.dir : (['name', 'user', 'state', 'command', 'started'].includes(k) ? 1 : -1);
    f.sort = k;
    $$('#proc-table th').forEach((h) => h.classList.remove('sorted', 'asc', 'desc'));
    th.classList.add('sorted', f.dir > 0 ? 'asc' : 'desc');
    state.lastOrder = [];
    state.tableHover = false;
    renderProcesses();
  }));

  const wrap = $('#tab-processes .table-wrap');
  wrap.addEventListener('mouseenter', () => { state.tableHover = true; });
  wrap.addEventListener('mouseleave', () => { state.tableHover = false; renderProcesses(); });

  const tbody = $('#proc-table tbody');
  // mousedown (not click) so a selection survives the row being re-rendered between press and release
  tbody.addEventListener('mousedown', (e) => {
    const tr = e.target.closest('tr'); if (!tr || e.button !== 0) return;
    openDetail(+tr.dataset.pid);
  });
  tbody.addEventListener('contextmenu', (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    e.preventDefault();
    const pid = +tr.dataset.pid;
    openDetail(pid);
    procMenu(pid, e.clientX, e.clientY);
  });

  $('#proc-detail').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const pid = state.selected;
    switch (b.dataset.act) {
      case 'close': closeDetail(); break;
      case 'term': endProc(pid); break;
      case 'kill': forceKill(pid); break;
      case 'stop': toggleStop(pid); break;
      case 'tree': killTree(pid); break;
      case 'goto': openDetail(+b.dataset.pid); break;
    }
  });

  // overview interactions
  $('#top-cpu').addEventListener('mousedown', (e) => {
    const li = e.target.closest('li'); if (!li || e.button !== 0) return;
    const pid = +li.dataset.pid;
    filterProcsTo('');
    openDetail(pid);
  });
  $('#top-cpu').addEventListener('contextmenu', (e) => {
    const li = e.target.closest('li'); if (!li) return;
    e.preventDefault();
    procMenu(+li.dataset.pid, e.clientX, e.clientY);
  });
  $('#treemap').addEventListener('mousedown', (e) => {
    const t = e.target.closest('.tile'); if (!t || e.button !== 0 || t.dataset.other) return;
    filterProcsTo(t.dataset.name);
  });
  $('#treemap').addEventListener('contextmenu', (e) => {
    const t = e.target.closest('.tile'); if (!t || t.dataset.other) return;
    e.preventDefault();
    const name = t.dataset.name;
    const n = state.snap.procs.filter((p) => p.name === name).length;
    openMenu(e.clientX, e.clientY, `<b>${esc(name)}</b> · ${n} process${n === 1 ? '' : 'es'}`, [
      { label: `End all “${esc(name)}”`, icon: 'x', danger: true, run: () => killByName(name) },
      '-',
      { label: 'Show in Processes', icon: 'filter', run: () => filterProcsTo(name) },
    ]);
  });

  // remotes
  $('#net-search').addEventListener('input', (e) => { state.net.q = e.target.value; renderRemotes(); });
  $('#net-state').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    state.net.state = c.dataset.nstate; setChip('#net-state', 'nstate', c.dataset.nstate); renderRemotes();
  });
  $('#net-proto').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    state.net.proto = c.dataset.proto; setChip('#net-proto', 'proto', c.dataset.proto); renderRemotes();
  });
  $('#hide-loopback').addEventListener('change', (e) => { state.net.hideLoop = e.target.checked; renderRemotes(); });
  $$('#net-table th[data-nsort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.nsort;
    const f = state.net;
    f.dir = f.sort === k ? -f.dir : 1;
    f.sort = k;
    $$('#net-table th').forEach((h) => h.classList.remove('sorted', 'asc', 'desc'));
    th.classList.add('sorted', f.dir > 0 ? 'asc' : 'desc');
    renderRemotes();
  }));
  $('#net-table tbody').addEventListener('contextmenu', (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    e.preventDefault();
    const c = state.netRows[+tr.dataset.i];
    if (c) connMenu(c, e.clientX, e.clientY);
  });

  const canvas = $('#constellation');
  canvas.addEventListener('mousemove', (e) => { cons.hover = nodeAt(e)?.key || null; canvas.style.cursor = cons.hover ? 'pointer' : 'crosshair'; });
  canvas.addEventListener('mouseleave', () => { cons.hover = null; });
  canvas.addEventListener('click', (e) => {
    const n = nodeAt(e); if (!n) return;
    const q = n.kind === 'host' ? n.name : n.pid ? String(n.pid) : '';
    state.net.q = q;
    $('#net-search').value = q;
    state.net.state = 'all';
    setChip('#net-state', 'nstate', 'all');
    renderRemotes();
  });
  canvas.addEventListener('contextmenu', (e) => {
    const n = nodeAt(e);
    e.preventDefault();
    if (n?.kind === 'proc' && n.pid) procMenu(n.pid, e.clientX, e.clientY);
  });

  // global: menus, keys, resize
  $('#ctx').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]'); if (!b || b.disabled) return;
    closeMenu();
    menuActions[+b.dataset.i]?.();
  });
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctx')) closeMenu(); }, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', () => { closeMenu(); render(); });
  document.addEventListener('scroll', closeMenu, true);

  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches('input, select');
    if (e.key === 'Escape') {
      if (!$('#ctx').hidden) return closeMenu();
      if (typing) { e.target.blur(); return; }
      if (state.tab === 'logs' && logs.selected) return closeLogDetail();
      if (state.selected) return closeDetail();
    }
    if ((e.ctrlKey || e.metaKey) && ['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      return switchTab(['overview', 'processes', 'remotes', 'logs'][+e.key - 1]);
    }
    if (typing) return;
    if (e.key === '/') {
      e.preventDefault();
      if (state.tab === 'remotes') $('#net-search').focus();
      else if (state.tab === 'logs') $('#log-search').focus();
      else { switchTab('processes'); $('#proc-search').focus(); }
    } else if (e.key === ' ') {
      e.preventDefault();
      setPaused(!state.paused);
    } else if (state.tab === 'processes' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const order = state.lastOrder;
      if (!order.length) return;
      const i = order.indexOf(state.selected);
      const next = order[Math.max(0, Math.min(order.length - 1, i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1)))];
      openDetail(next);
      $(`#proc-table tr[data-pid="${next}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Delete' && state.selected) {
      e.preventDefault();
      if (e.shiftKey) forceKill(state.selected);
      else endProc(state.selected);
    }
  });
}

async function boot() {
  wire();
  requestAnimationFrame(frame);
  state.info = await api.staticInfo();
  const i = state.info;
  $('#host-line').textContent = `${i.user}@${i.hostname}`;
  $('#cpu-line').textContent = `${i.cpuBrand} · ${i.physicalCores}C/${i.cores}T · ${i.distro} · kernel ${i.kernel}`;
  tick();
  initLogs();
}

boot();
