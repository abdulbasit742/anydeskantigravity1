const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

process.env.PORT = process.env.PORT || '5000';
const baseUrl = `http://localhost:${process.env.PORT}`;
let mainWindow;
let agentProcess;

require('./server');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL(baseUrl);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

ipcMain.handle('start-agent', async (_event, { hostId, serverUrl }) => {
  if (agentProcess) agentProcess.kill();
  const py = process.platform === 'win32' ? 'python' : 'python3';
  agentProcess = spawn(py, [path.join(__dirname, 'host-agent.py'), '--id', hostId, '--server', serverUrl], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  agentProcess.stdout.on('data', data => mainWindow?.webContents.send('agent-log', data.toString()));
  agentProcess.stderr.on('data', data => mainWindow?.webContents.send('agent-log', data.toString()));
  agentProcess.on('close', code => {
    mainWindow?.webContents.send('agent-exited', { code });
    agentProcess = null;
  });
  agentProcess.on('error', err => {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Python agent failed',
      message: 'Could not start the Python remote-control agent.',
      detail: err.message
    });
  });

  return { ok: true };
});

ipcMain.handle('stop-agent', async () => {
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
