const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskRTC', {
  startAgent: (hostId, serverUrl) => ipcRenderer.invoke('start-agent', { hostId, serverUrl }),
  stopAgent: () => ipcRenderer.invoke('stop-agent'),
  onAgentLog: (callback) => ipcRenderer.on('agent-log', (_event, text) => callback(String(text))),
  onAgentExit: (callback) => ipcRenderer.on('agent-exited', (_event, data) => callback(data))
});
