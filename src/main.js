const { app, BrowserWindow, ipcMain, clipboard, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const readline = require('readline');
const { spawn, execFile, execFileSync } = require('child_process');
const si = require('systeminformation');

const SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGSTOP', 'SIGCONT', 'SIGINT', 'SIGHUP']);

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    title: 'Remote Tasks',
    backgroundColor: '#0a0c16',
    autoHideMenuBar: true,
    icon: nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// PIDs belonging to this app: signalling them would take the task manager down with it.
function ownPids() {
  const pids = new Set([process.pid]);
  for (const m of app.getAppMetrics()) pids.add(m.pid);
  return pids;
}

const sum = (rows, key) => rows.reduce((acc, r) => acc + (r[key] || 0), 0);

ipcMain.handle('sys:static', async () => {
  const [cpu, info] = await Promise.all([si.cpu(), si.osInfo()]);
  return {
    cpuBrand: `${cpu.manufacturer} ${cpu.brand}`.trim(),
    cores: cpu.cores,
    physicalCores: cpu.physicalCores,
    speed: cpu.speed,
    distro: `${info.distro} ${info.release}`.trim(),
    kernel: info.kernel,
    hostname: os.hostname(),
    arch: info.arch,
    user: os.userInfo().username,
    ownPids: [...ownPids()],
  };
});

ipcMain.handle('sys:snapshot', async () => {
  const [load, mem, net, fs, procs, temp] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.networkStats('*'),
    si.fsStats().catch(() => null),
    si.processes(),
    si.cpuTemperature().catch(() => null),
  ]);
  const ifaces = net.filter((n) => n.iface !== 'lo');
  const appUsed = mem.total - mem.available;
  return {
    t: Date.now(),
    uptime: si.time().uptime,
    loadavg: os.loadavg(),
    temp: temp && temp.main > 0 ? temp.main : null,
    cpu: {
      total: load.currentLoad,
      user: load.currentLoadUser,
      system: load.currentLoadSystem,
      cores: load.cpus.map((c) => c.load),
    },
    mem: {
      total: mem.total,
      used: appUsed,
      cache: mem.available - mem.free,
      free: mem.free,
      swapTotal: mem.swaptotal,
      swapUsed: mem.swapused,
    },
    net: { rx: sum(ifaces, 'rx_sec'), tx: sum(ifaces, 'tx_sec') },
    disk: { read: (fs && fs.rx_sec) || 0, write: (fs && fs.wx_sec) || 0 },
    counts: {
      all: procs.all,
      running: procs.running,
      sleeping: procs.sleeping,
      blocked: procs.blocked,
      unknown: procs.unknown,
    },
    procs: procs.list.map((p) => ({
      pid: p.pid,
      ppid: p.parentPid,
      name: p.name,
      cpu: p.cpu,
      mem: p.mem,
      rss: p.memRss * 1024,
      user: p.user,
      state: p.state,
      nice: p.nice,
      started: p.started,
      command: [p.command, p.params].filter(Boolean).join(' '),
      path: p.path,
    })),
  };
});

ipcMain.handle('net:connections', async () => {
  const conns = await si.networkConnections();
  return conns.map((c) => ({
    protocol: c.protocol,
    localAddress: c.localAddress,
    localPort: c.localPort,
    peerAddress: c.peerAddress,
    peerPort: c.peerPort,
    state: c.state || (c.protocol.startsWith('udp') ? 'UDP' : ''),
    pid: c.pid || null,
    process: c.process || '',
  }));
});

ipcMain.handle('proc:signal', async (_e, { pids, signal }) => {
  if (!SIGNALS.has(signal) || !Array.isArray(pids)) {
    return [{ pid: null, ok: false, error: 'Invalid request' }];
  }
  const protectedPids = ownPids();
  return pids.map((pid) => {
    if (!Number.isInteger(pid) || pid <= 1) return { pid, ok: false, error: 'Refusing to signal PID ' + pid };
    if (protectedPids.has(pid)) return { pid, ok: false, error: 'That is Remote Tasks itself' };
    try {
      process.kill(pid, signal);
      return { pid, ok: true };
    } catch (err) {
      const error =
        err.code === 'EPERM' ? 'Permission denied (owned by another user)'
        : err.code === 'ESRCH' ? 'Process no longer exists'
        : err.message;
      return { pid, ok: false, error };
    }
  });
});

ipcMain.handle('clip:write', (_e, text) => {
  clipboard.writeText(String(text));
});

/* ---------------- logs ---------------- */
// One long-lived `journalctl -f` feeds a ring buffer here; the renderer gets the buffer on
// start and then small batches, so a reload never loses history.

const LOG_RING = 5000;
const LOG_BACKLOG = 1500;
const JOURNAL_FIELDS = 'MESSAGE,PRIORITY,SYSLOG_IDENTIFIER,_COMM,_PID,SYSLOG_PID,_SYSTEMD_UNIT,_TRANSPORT,_UID';
const logRing = [];
let logPending = [];
let logProc = null;
let logSource = null;
let logStatus = '';
let logSeq = 0;

function journalMessage(m) {
  if (Array.isArray(m)) return Buffer.from(m).toString('utf8');
  return m == null ? '' : String(m);
}

function fromJournal(line) {
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  return {
    id: ++logSeq,
    t: Math.floor(Number(j.__REALTIME_TIMESTAMP) / 1000),
    pri: j.PRIORITY != null ? Number(j.PRIORITY) : 6,
    src: j.SYSLOG_IDENTIFIER || j._COMM || (j._TRANSPORT === 'kernel' ? 'kernel' : 'unknown'),
    pid: Number(j._PID || j.SYSLOG_PID) || null,
    unit: j._SYSTEMD_UNIT || '',
    uid: j._UID != null ? Number(j._UID) : null,
    msg: journalMessage(j.MESSAGE),
  };
}

// "Nov  5 13:46:01 host ident[123]: message" (classic rsyslog format) or the RFC 3339 variant
const SYSLOG_RE = /^(\w{3}\s+\d+\s[\d:]{8}|\d{4}-\d\d-\d\dT[\d:.]+[+-Z][\d:]*)\s+\S+\s+([^:[\s]+)(?:\[(\d+)\])?:\s?(.*)$/;
function fromSyslog(line) {
  const m = SYSLOG_RE.exec(line);
  if (!m) return null;
  let t = Date.parse(m[1]);
  if (isNaN(t)) t = Date.parse(`${m[1]} ${new Date().getFullYear()}`);
  return { id: ++logSeq, t: isNaN(t) ? Date.now() : t, pri: guessPriority(m[4]), src: m[2], pid: Number(m[3]) || null, unit: '', uid: null, msg: m[4] };
}
function guessPriority(msg) {
  if (/\b(fatal|panic|critical)\b/i.test(msg)) return 2;
  if (/\b(error|failed|failure)\b/i.test(msg)) return 3;
  if (/\bwarn(ing)?\b/i.test(msg)) return 4;
  return 6;
}

function pushLog(entry) {
  if (!entry) return;
  logRing.push(entry);
  if (logRing.length > LOG_RING) logRing.splice(0, logRing.length - LOG_RING);
  logPending.push(entry);
}

setInterval(() => {
  if (!logPending.length || !win || win.isDestroyed()) return;
  win.webContents.send('logs:batch', logPending);
  logPending = [];
}, 250);

function hasJournalAccess() {
  if (process.getuid && process.getuid() === 0) return true;
  try {
    const groups = execFileSync('id', ['-nG'], { encoding: 'utf8' }).split(/\s+/);
    return groups.some((g) => ['adm', 'systemd-journal', 'wheel'].includes(g));
  } catch {
    return false;
  }
}

function startLogs() {
  if (logProc) return;
  const journal = spawn('journalctl', ['-f', '-o', 'json', '-n', String(LOG_BACKLOG), '--no-pager', `--output-fields=${JOURNAL_FIELDS}`]);
  journal.on('error', () => {
    // no systemd journal: fall back to following the classic syslog file
    logProc = null;
    const file = ['/var/log/syslog', '/var/log/messages'].find((f) => fs.existsSync(f));
    if (!file) { logStatus = 'No journalctl and no syslog file found'; return; }
    const tail = spawn('tail', ['-n', String(LOG_BACKLOG), '-F', file]);
    logProc = tail;
    logSource = file;
    readline.createInterface({ input: tail.stdout }).on('line', (l) => pushLog(fromSyslog(l)));
    tail.stderr.on('data', (d) => { logStatus = String(d).trim(); });
  });
  logProc = journal;
  logSource = 'journal';
  logStatus = hasJournalAccess() ? '' : 'Only your own logs are visible. Add yourself to the systemd-journal group to see system logs.';
  readline.createInterface({ input: journal.stdout }).on('line', (l) => pushLog(fromJournal(l)));
  journal.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (s) logStatus = s;
  });
  journal.on('exit', () => { if (logProc === journal) logProc = null; });
}

ipcMain.handle('logs:start', () => {
  startLogs();
  logPending = [];
  return { entries: logRing.slice(), source: logSource, status: logStatus };
});

// Deep search: grep the whole persistent journal rather than the live buffer.
ipcMain.handle('logs:query', (_e, { grep, maxPriority, ident, since, until, limit }) => new Promise((resolve) => {
  if (logSource !== 'journal') return resolve({ entries: [], error: 'Deep search needs the systemd journal' });
  const args = ['-o', 'json', '--no-pager', '-r', `--output-fields=${JOURNAL_FIELDS}`, '-n', String(Math.min(5000, limit || 2000))];
  if (grep) args.push('-g', String(grep));
  if (maxPriority != null && maxPriority < 7) args.push('-p', String(maxPriority));
  if (ident) args.push('-t', String(ident));
  if (since) args.push('--since', String(since));
  if (until) args.push('--until', String(until));
  execFile('journalctl', args, { maxBuffer: 128 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
    const entries = stdout.split('\n').filter(Boolean).map(fromJournal).filter(Boolean).reverse();
    // journalctl exits 1 when nothing matched; that is not an error worth showing
    const error = err && !entries.length && stderr.trim() && !/^-- No entries --$/m.test(stderr) ? stderr.trim() : null;
    resolve({ entries, error });
  });
}));

app.on('before-quit', () => {
  if (logProc) logProc.kill();
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
