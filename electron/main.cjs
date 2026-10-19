/**
 * ⚡ FlashTap — Windows desktop shell.
 *
 * Starts the game server as a child process (Electron's binary running as
 * plain Node via ELECTRON_RUN_AS_NODE), then opens the host screen in a
 * maximised window. Players still use their phones against the LAN URL in
 * the QR code.
 */
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

const APP_ROOT = path.join(__dirname, '..');
const PORT_START = 3210;
const PORT_TRIES = 15;

let serverProc = null;
let win = null;
let quitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

async function pickPort() {
  for (let p = PORT_START; p < PORT_START + PORT_TRIES; p++) {
    if (await portFree(p)) return p;
  }
  return PORT_START;
}

async function waitForHealth(base) {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function startGameServer() {
  const port = await pickPort();
  const args = [
    path.join(APP_ROOT, 'server.js'),
    '--port', String(port),
    '--question-sets', path.join(APP_ROOT, 'question-sets'),
    '--config', path.join(app.getPath('userData'), 'game-config.json'),
    '--quiet',
  ];
  serverProc = spawn(process.execPath, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProc.stdout.on('data', (d) => process.stdout.write(`[flashtap] ${d}`));
  serverProc.stderr.on('data', (d) => process.stderr.write(`[flashtap] ${d}`));
  serverProc.on('exit', (code) => {
    serverProc = null;
    if (!quitting) {
      dialog.showErrorBox('FlashTap', `The game server stopped unexpectedly (code ${code}).\n\nClose the app and start it again.`);
      app.quit();
    }
  });

  const base = `http://127.0.0.1:${port}`;
  const healthy = await waitForHealth(base);
  return healthy ? { port, base } : null;
}

function createWindow(base) {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#140f2b',
    title: 'FlashTap',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  win.loadURL(`${base}/host`);
  // external links (Jaxtech credit, venue promos) open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // F11 toggles fullscreen for TVs / projectors
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.jaxtech.flastap');
  const server = await startGameServer();
  if (!server) {
    dialog.showErrorBox(
      'FlashTap',
      'The game server could not start.\n\nCheck that no other app is using ports ' +
        `${PORT_START}-${PORT_START + PORT_TRIES - 1} and try again.`
    );
    app.quit();
    return;
  }
  createWindow(server.base);
});

app.on('before-quit', () => {
  quitting = true;
  if (serverProc) {
    try { serverProc.kill(); } catch {}
    serverProc = null;
  }
});

app.on('window-all-closed', () => app.quit());
