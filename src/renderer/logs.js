/* global Charts, api, state, $, $$, esc, hue, toast, copy, openMenu, endProc, forceKill, switchTab, filterProcsTo, openDetail, ICONS */
// Logs tab: a virtualised, filterable view over the live journal stream plus full-journal search.

const PRI_LABEL = ['EMERG', 'ALERT', 'CRIT', 'ERR', 'WARN', 'NOTICE', 'INFO', 'DEBUG'];
const LEVEL_CLASS = ['err', 'warn', 'notice', 'info', 'debug'];
const LEVEL_COLORS = ['#f43f5e', '#fbbf24', '#a78bfa', '#22d3ee', '#5c628c'];
const levelOf = (pri) => (pri <= 3 ? 0 : Math.min(4, pri - 3));
const ROW_H = 24;
const LOG_MAX = 10000;
const RATE_SECS = 120;

const logs = {
  all: [],
  view: [],
  q: '',
  level: 7,
  source: '',
  follow: true,
  selected: null,
  deep: null,
  unseen: 0,
  dirty: true,
  status: '',
  origin: '',
  freezeId: null,
  window: '',
  programmatic: false,
  lastCharts: 0,
  sourcesKey: '',
  searchToken: 0,
};

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function fmtLogTime(t) {
  const d = new Date(t);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (d.toDateString() === new Date().toDateString()) return `${hms}<b>.${pad(d.getMilliseconds(), 3)}</b>`;
  return `${d.toLocaleDateString([], { month: 'short', day: '2-digit' })} ${hms.slice(0, 5)}`;
}

function parseLogQuery() {
  const terms = logs.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const inc = terms.filter((t) => !t.startsWith('-') || t.length === 1);
  const exc = terms.filter((t) => t.startsWith('-') && t.length > 1).map((t) => t.slice(1));
  return { inc, exc, hl: inc.length ? new RegExp(inc.map(escRe).join('|'), 'gi') : null };
}

function logMatch(e, { inc, exc }) {
  if (e.pri > logs.level) return false;
  if (logs.source && e.src !== logs.source) return false;
  if (logs.freezeId != null && !logs.deep && e.id > logs.freezeId) return false;
  if (!inc.length && !exc.length) return true;
  const hay = e._l || (e._l = `${e.src} ${e.msg} ${e.unit} ${e.pid ?? ''}`.toLowerCase());
  return inc.every((t) => hay.includes(t)) && !exc.some((t) => hay.includes(t));
}

function highlight(text, re) {
  const flat = text.replace(/\n/g, ' ⏎ ');
  if (!re) return esc(flat);
  let out = '', last = 0;
  flat.replace(re, (m, idx) => {
    out += esc(flat.slice(last, idx)) + '<mark>' + esc(m) + '</mark>';
    last = idx + m.length;
    return m;
  });
  return out + esc(flat.slice(last));
}

/* ---------------- ingest ---------------- */
function ingestLogs(batch, live = true) {
  const now = Date.now();
  const q = parseLogQuery();
  let matched = 0;
  for (const e of batch) {
    if (live) e.arr = now;
    logs.all.push(e);
    if (live && !logs.deep && logMatch(e, q)) matched++;
  }
  if (logs.all.length > LOG_MAX) logs.all.splice(0, logs.all.length - LOG_MAX);
  if (!logs.follow && !state.paused) logs.unseen += matched;
  logs.dirty = true;
  updateLogBadge();
}

function updateLogBadge() {
  const since = Date.now() - 5 * 60 * 1000;
  let errs = 0;
  for (let i = logs.all.length - 1; i >= 0 && logs.all[i].t >= since; i--) if (logs.all[i].pri <= 3) errs++;
  const b = $('#badge-logs');
  b.textContent = errs;
  b.classList.toggle('hot', errs > 0);
}

/* ---------------- render ---------------- */
function buildLogView() {
  if (state.paused) {
    if (logs.freezeId == null) logs.freezeId = logs.all.length ? logs.all[logs.all.length - 1].id : 0;
  } else logs.freezeId = null;
  const q = parseLogQuery();
  const src = logs.deep ? logs.deep.entries : logs.all;
  logs.view = src.filter((e) => logMatch(e, q));
  logs.hl = q.hl;
}

function renderLogsFrame() {
  const now = Date.now();
  if (now - logs.lastCharts > 1000) {
    logs.lastCharts = now;
    renderLogCharts();
    logs.dirty = true; // refresh the "fresh" tint as rows age
  }
  if (logs.dirty) {
    logs.dirty = false;
    buildLogView();
    renderLogMeta();
    logs.window = '';
  }
  const sc = $('#log-scroll');
  const n = logs.view.length;
  $('#log-spacer').style.height = n * ROW_H + 'px';
  if (logs.follow) {
    const bottom = Math.max(0, sc.scrollHeight - sc.clientHeight);
    if (Math.abs(sc.scrollTop - bottom) > 1) {
      logs.programmatic = true;
      sc.scrollTop = bottom;
    }
  }
  const first = Math.max(0, Math.floor(sc.scrollTop / ROW_H) - 8);
  const last = Math.min(n, Math.ceil((sc.scrollTop + sc.clientHeight) / ROW_H) + 8);
  const key = `${first}:${last}:${n}:${logs.selected}`;
  if (key === logs.window) return;
  logs.window = key;
  const rows = $('#log-rows');
  rows.style.transform = `translateY(${first * ROW_H}px)`;
  let html = '';
  for (let i = first; i < last; i++) {
    const e = logs.view[i];
    const lc = LEVEL_CLASS[levelOf(e.pri)];
    const fresh = e.arr && now - e.arr < 1500 ? ' fresh' : '';
    html += `<div class="lrow ${lc}${e.id === logs.selected ? ' selected' : ''}${fresh}" data-id="${e.id}">` +
      `<span class="lt">${fmtLogTime(e.t)}</span>` +
      `<span><span class="lv ${lc}">${PRI_LABEL[e.pri] || e.pri}</span></span>` +
      `<span class="ls"><i style="background:hsl(${hue(e.src)} 70% 62%)"></i>${esc(e.src)}</span>` +
      `<span class="lp">${e.pid ?? ''}</span>` +
      `<span class="lm">${highlight(e.msg, logs.hl)}</span></div>`;
  }
  rows.innerHTML = html;
  $('#log-empty').hidden = n > 0;
}

function renderLogMeta() {
  const n = logs.view.length;
  const origin = logs.origin === 'journal' ? 'systemd journal' : logs.origin || '…';
  let sub = logs.deep
    ? `Full-journal results · showing ${n} of ${logs.deep.entries.length}`
    : `${state.paused ? 'Paused' : 'Live'} · ${origin} · ${logs.all.length} lines loaded · showing ${n}`;
  if (logs.status) sub += ` · ⚠ ${logs.status}`;
  $('#log-sub').textContent = sub;

  const jump = $('#log-jump');
  jump.hidden = logs.follow || logs.unseen === 0;
  jump.textContent = `↓ ${logs.unseen} new line${logs.unseen === 1 ? '' : 's'}`;
  $('#log-reset').hidden = !(logs.q || logs.level !== 7 || logs.source);

  // source dropdown: only rebuild when the set of sources changes
  const counts = new Map();
  for (const e of logs.deep ? logs.deep.entries : logs.all) counts.set(e.src, (counts.get(e.src) || 0) + 1);
  if (logs.source && !counts.has(logs.source)) counts.set(logs.source, 0);
  const key = [...counts.keys()].sort().join('|');
  if (key !== logs.sourcesKey) {
    logs.sourcesKey = key;
    const opts = [...counts].sort((a, b) => b[1] - a[1]);
    $('#log-source').innerHTML = `<option value="">All sources (${opts.length})</option>` +
      opts.map(([s, c]) => `<option value="${esc(s)}">${esc(s)} · ${c}</option>`).join('');
  }
  $('#log-source').value = logs.source;
}

function renderLogCharts() {
  const canvas = $('#log-rate');
  if (!canvas.clientWidth) return;
  const now = Date.now();
  const startSec = Math.floor(now / 1000) - RATE_SECS + 1;
  const buckets = Array.from({ length: RATE_SECS }, () => [0, 0, 0, 0, 0]);
  const tenMin = now - 10 * 60 * 1000;
  const bySrc = new Map();
  for (let i = logs.all.length - 1; i >= 0; i--) {
    const e = logs.all[i];
    if (e.t < tenMin) break;
    const s = Math.floor(e.t / 1000) - startSec;
    if (s >= 0 && s < RATE_SECS) buckets[s][levelOf(e.pri)]++;
    const g = bySrc.get(e.src) || { name: e.src, n: 0, lv: [0, 0, 0, 0, 0] };
    g.n++;
    g.lv[levelOf(e.pri)]++;
    bySrc.set(e.src, g);
  }
  Charts.bars(canvas, buckets, LEVEL_COLORS, { unit: '' });

  const top = [...bySrc.values()].sort((a, b) => b.n - a.n).slice(0, 7);
  const peak = top[0]?.n || 1;
  $('#log-src-list').innerHTML = top.length
    ? top.map((g) => `<div class="src-row${g.name === logs.source ? ' active' : ''}" data-src="${esc(g.name)}">
        <span class="nm">${esc(g.name)}</span>
        <span class="ct">${g.lv[0] ? `<b>${g.lv[0]} err</b>` : ''}${g.n}</span>
        <span class="bar" style="width:${(g.n / peak) * 100}%">${g.lv.map((v, k) => (v ? `<i style="flex:${v};background:${LEVEL_COLORS[k]}"></i>` : '')).join('')}</span>
      </div>`).join('')
    : '<span class="muted">Nothing logged in the last 10 minutes</span>';
}

/* ---------------- detail + actions ---------------- */
const findLog = (id) => (logs.deep?.entries.find((e) => e.id === id)) || logs.all.find((e) => e.id === id);

function openLogDetail(id) {
  const e = findLog(id);
  if (!e) return;
  logs.selected = id;
  logs.window = '';
  const p = e.pid && state.byPid.get(e.pid);
  const lc = LEVEL_CLASS[levelOf(e.pri)];
  const el = $('#log-detail');
  el.hidden = false;
  el.innerHTML = `
    <div class="top">
      <span class="avatar" style="background:hsl(${hue(e.src)} 75% 68%)">${esc(e.src[0]?.toUpperCase() || '?')}</span>
      <div style="min-width:0"><h3>${esc(e.src)}</h3><span class="muted">${new Date(e.t).toLocaleString()}</span></div>
      <button class="x" data-act="close" title="Close (Esc)">✕</button>
    </div>
    <div><span class="lv ${lc}">${PRI_LABEL[e.pri] || e.pri}</span></div>
    <div class="msg">${esc(e.msg)}</div>
    <dl class="kv">
      <dt>Priority</dt><dd>${e.pri} · ${(PRI_LABEL[e.pri] || '').toLowerCase()}</dd>
      <dt>PID</dt><dd>${e.pid ? (p ? `<a data-act="proc">${e.pid} · ${esc(p.name)}</a>` : `${e.pid} <span class="dim">(not running)</span>`) : '—'}</dd>
      ${e.unit ? `<dt>Unit</dt><dd>${esc(e.unit)}</dd>` : ''}
      ${e.uid != null ? `<dt>UID</dt><dd>${e.uid}</dd>` : ''}
    </dl>
    <div class="actions">
      <button class="ghost-btn" data-act="copy">Copy message</button>
      <button class="ghost-btn" data-act="nearby">Show nearby</button>
      <button class="ghost-btn" data-act="only">Only this source</button>
      <button class="danger-btn" data-act="kill" ${p ? '' : 'disabled'}>End process</button>
    </div>`;
}

function closeLogDetail() {
  logs.selected = null;
  logs.window = '';
  $('#log-detail').hidden = true;
}

function setLogSource(src) {
  logs.source = src;
  logs.dirty = true;
}

function setLogLevel(level) {
  logs.level = level;
  $$('#log-level .chip').forEach((c) => c.classList.toggle('active', +c.dataset.level === level));
  logs.dirty = true;
}

function setFollow(on) {
  logs.follow = on;
  $('#log-follow').checked = on;
  if (on) logs.unseen = 0;
  logs.dirty = true;
}

function resetLogFilters() {
  logs.q = '';
  $('#log-search').value = '';
  setLogSource('');
  setLogLevel(7);
}

function scrollToLog(id) {
  buildLogView();
  const idx = logs.view.findIndex((e) => e.id === id);
  if (idx < 0) return;
  setFollow(false);
  const sc = $('#log-scroll');
  $('#log-spacer').style.height = logs.view.length * ROW_H + 'px';
  sc.scrollTop = Math.max(0, idx * ROW_H - sc.clientHeight / 2);
  logs.window = '';
}

async function showNearby(id) {
  const e = findLog(id);
  if (!e) return;
  resetLogFilters();
  if (!logs.deep && logs.all.includes(e)) {
    scrollToLog(id);
    openLogDetail(id);
    return;
  }
  // the line came from a full-journal search: fetch the minute around it instead
  const s = Math.floor(e.t / 1000);
  const token = ++logs.searchToken;
  const res = await api.logsQuery({ since: `@${s - 30}`, until: `@${s + 30}`, limit: 3000 });
  if (token !== logs.searchToken) return;
  const hit = res.entries.find((x) => x.t === e.t && x.msg === e.msg);
  setDeep(res.entries, `Lines within 30 s of ${new Date(e.t).toLocaleString()}`, res.error);
  if (hit) { scrollToLog(hit.id); openLogDetail(hit.id); }
}

function setDeep(entries, label, error) {
  logs.deep = { entries, label, error };
  const b = $('#log-banner');
  b.hidden = false;
  b.classList.toggle('err', !!error);
  b.innerHTML = `${ICONS.filter}<span>${error ? esc(error) : esc(label)}</span><button class="ghost-btn small" data-act="live">Back to live</button>`;
  setFollow(true);
}

function backToLive() {
  logs.searchToken++;
  logs.deep = null;
  $('#log-banner').hidden = true;
  closeLogDetail();
  setFollow(true);
}

async function deepSearch() {
  const { inc } = parseLogQuery();
  const b = $('#log-banner');
  b.hidden = false;
  b.classList.remove('err');
  b.innerHTML = '<i class="spin"></i><span>Searching the full journal…</span>';
  // journalctl greps one pattern; use the longest term there and narrow by the rest locally
  const grep = [...inc].sort((a, c) => c.length - a.length)[0];
  const token = ++logs.searchToken;
  const res = await api.logsQuery({ grep: grep ? escRe(grep) : undefined, maxPriority: logs.level, ident: logs.source || undefined, limit: 3000 });
  if (token !== logs.searchToken) return; // superseded, or the user went back to live meanwhile
  const what = [logs.q.trim() && `“${logs.q.trim()}”`, logs.source && `from ${logs.source}`, logs.level < 7 && `${PRI_LABEL[logs.level].toLowerCase()} or worse`].filter(Boolean).join(' ');
  closeLogDetail();
  setDeep(res.entries, `Newest ${res.entries.length >= 3000 ? '3000 ' : ''}matches in the full journal${what ? ' for ' + what : ''}`, res.error);
}

function logMenu(e, x, y) {
  const p = e.pid && state.byPid.get(e.pid);
  openMenu(x, y, `<b>${esc(e.src)}</b> · ${new Date(e.t).toLocaleTimeString()}`, [
    { label: 'Copy message', icon: 'copy', run: () => copy(e.msg) },
    { label: 'Copy line', icon: 'copy', run: () => copy(`${new Date(e.t).toISOString()} ${e.src}${e.pid ? `[${e.pid}]` : ''}: ${e.msg}`) },
    '-',
    { label: `Only “${esc(e.src)}”`, icon: 'filter', run: () => setLogSource(e.src) },
    { label: 'Show surrounding lines', icon: 'info', run: () => showNearby(e.id) },
    '-',
    { label: p ? `Show process ${esc(p.name)} (${e.pid})` : 'Process not running', icon: 'info', disabled: !p, run: () => { filterProcsTo(''); openDetail(e.pid); } },
    { label: 'End process', icon: 'x', danger: true, disabled: !p, run: () => endProc(e.pid) },
    { label: 'Force kill', icon: 'skull', danger: true, disabled: !p, run: () => forceKill(e.pid) },
  ]);
}

/* ---------------- wiring ---------------- */
function wireLogs() {
  const sc = $('#log-scroll');
  sc.addEventListener('scroll', () => {
    if (logs.programmatic) { logs.programmatic = false; return; }
    const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - ROW_H;
    if (atBottom !== logs.follow) setFollow(atBottom);
  });
  sc.addEventListener('wheel', (e) => { if (e.deltaY < 0 && logs.follow) setFollow(false); }, { passive: true });

  const rows = $('#log-rows');
  rows.addEventListener('mousedown', (e) => {
    const r = e.target.closest('.lrow');
    if (r && e.button === 0) openLogDetail(+r.dataset.id);
  });
  rows.addEventListener('contextmenu', (e) => {
    const r = e.target.closest('.lrow');
    if (!r) return;
    e.preventDefault();
    const entry = findLog(+r.dataset.id);
    if (entry) { openLogDetail(entry.id); logMenu(entry, e.clientX, e.clientY); }
  });

  $('#log-search').addEventListener('input', (e) => { logs.q = e.target.value; logs.dirty = true; });
  $('#log-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); deepSearch(); } });
  $('#log-deep').addEventListener('click', deepSearch);
  $('#log-level').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) setLogLevel(+c.dataset.level); });
  $('#log-source').addEventListener('change', (e) => setLogSource(e.target.value));
  $('#log-follow').addEventListener('change', (e) => setFollow(e.target.checked));
  $('#log-jump').addEventListener('click', () => setFollow(true));
  $('#log-reset').addEventListener('click', resetLogFilters);
  $('#log-clear').addEventListener('click', () => {
    logs.all = [];
    backToLive();
    updateLogBadge();
  });
  $('#log-src-list').addEventListener('click', (e) => {
    const r = e.target.closest('.src-row');
    if (r) setLogSource(logs.source === r.dataset.src ? '' : r.dataset.src);
  });
  $('#log-banner').addEventListener('click', (e) => { if (e.target.closest('[data-act="live"]')) backToLive(); });
  $('#log-detail').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const entry = findLog(logs.selected);
    if (!entry) return;
    switch (b.dataset.act) {
      case 'close': closeLogDetail(); break;
      case 'copy': copy(entry.msg); break;
      case 'nearby': showNearby(entry.id); break;
      case 'only': setLogSource(entry.src); break;
      case 'proc': filterProcsTo(''); openDetail(entry.pid); break;
      case 'kill': endProc(entry.pid); break;
    }
  });
  window.addEventListener('resize', () => { logs.window = ''; });
}

async function initLogs() {
  wireLogs();
  // hold live batches until the backlog has landed so lines stay in time order
  let early = [];
  api.onLogs((batch) => (early ? early.push(...batch) : ingestLogs(batch)));
  const res = await api.logsStart();
  logs.origin = res.source;
  logs.status = res.status;
  ingestLogs(res.entries, false);
  ingestLogs(early);
  early = null;
}
