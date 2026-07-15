'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskRTC', Object.freeze({
  startAgent: (hostId, agentToken) => ipcRenderer.invoke('start-agent', { hostId, agentToken }),
  stopAgent: () => ipcRenderer.invoke('stop-agent'),
  onAgentLog: (callback) => {
    const listener = (_event, text) => callback(String(text));
    ipcRenderer.on('agent-log', listener);
    return () => ipcRenderer.removeListener('agent-log', listener);
  },
  onAgentExit: (callback) => {
    const listener = (_event, data) => callback(Object.freeze({ code: data?.code ?? null }));
    ipcRenderer.on('agent-exited', listener);
    return () => ipcRenderer.removeListener('agent-exited', listener);
  },
}));
