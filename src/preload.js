const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  staticInfo: () => ipcRenderer.invoke('sys:static'),
  snapshot: () => ipcRenderer.invoke('sys:snapshot'),
  connections: () => ipcRenderer.invoke('net:connections'),
  signal: (pids, signal) => ipcRenderer.invoke('proc:signal', { pids, signal }),
  copy: (text) => ipcRenderer.invoke('clip:write', text),
  logsStart: () => ipcRenderer.invoke('logs:start'),
  logsQuery: (opts) => ipcRenderer.invoke('logs:query', opts),
  onLogs: (fn) => ipcRenderer.on('logs:batch', (_e, batch) => fn(batch)),
});
