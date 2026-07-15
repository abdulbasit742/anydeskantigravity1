'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { normalizeHostId, hashToken } = require('./lib/security');

process.env.PORT = process.env.PORT || '5000';
process.env.BIND_HOST = '127.0.0.1';
const baseUrl = `http://127.0.0.1:${process.env.PORT}`;
let mainWindow;
let agentProcess;

require('./server');

function isTrustedSender(event) {
  try {
    return new URL(event.senderFrame.url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.loadURL(baseUrl);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin !== new URL(baseUrl).origin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
}

ipcMain.handle('start-agent', async (event, { hostId, agentToken } = {}) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted renderer request');
  const normalizedHostId = normalizeHostId(hostId);
  if (!hashToken(agentToken)) throw new Error('Invalid agent credential');
  if (agentProcess) {
    agentProcess.kill();
    agentProcess = null;
  }

  const py = process.platform === 'win32' ? 'python' : 'python3';
  agentProcess = spawn(py, [
    path.join(__dirname, 'host-agent.py'),
    '--id', normalizedHostId,
    '--server', baseUrl,
    '--agent-token', String(agentToken),
  ], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  agentProcess.stdout.on('data', (data) => mainWindow?.webContents.send('agent-log', data.toString()));
  agentProcess.stderr.on('data', (data) => mainWindow?.webContents.send('agent-log', data.toString()));
  agentProcess.on('close', (code) => {
    mainWindow?.webContents.send('agent-exited', { code: Number.isInteger(code) ? code : null });
    agentProcess = null;
  });
  agentProcess.on('error', () => {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Python agent failed',
      message: 'Could not start the local host-control agent.',
      detail: 'Verify Python and the packages in requirements.txt, then try again.',
    });
  });

  return { ok: true };
});

ipcMain.handle('stop-agent', async (event) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted renderer request');
  if (agentProcess) {
    agentProcess.kill();
    agentProcess = null;
  }
  return { ok: true };
});

app.whenReady().then(createWindow);
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('will-quit', () => {
  if (agentProcess) agentProcess.kill();
});
