/**
 * ⚡ FlashTap — Windows desktop shell.
 *
 * Starts the game server as a child process (Electron's binary running as
 * plain Node via ELECTRON_RUN_AS_NODE), then opens the host screen in a
 * maximised window. Players still use their phones against the LAN URL in
 * the QR code.
 *
 * License gate: the server only starts and the window only opens once the
 * license validates (online check with a 7-day offline grace).
 */
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const lic = require('./license.cjs');

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

  // License gate — nothing starts until this passes.
  const gate = await licenseGate();
  if (gate !== 'start') return; // 'blocked' waits on its lock window; 'stop' quits

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
  startRevalLoop();
  ensureFirewallRule();
});

app.on('before-quit', () => {
  quitting = true;
  if (serverProc) {
    try { serverProc.kill(); } catch {}
    serverProc = null;
  }
});

app.on('window-all-closed', () => app.quit());

// ---------------------------------------------------------------------------
// License gate
// ---------------------------------------------------------------------------
const dataUrl = (html) =>
  'data:text/html;base64,' + Buffer.from(html, 'utf8').toString('base64');

function shellHtml({ title, prefill, message }) {
  const msg = message
    ? `<div id="msg" class="msg${/revoked/i.test(message) ? ' bad' : ''}">${message.replace(/[&<>"]/g, '')}</div>`
    : '<div id="msg" class="msg"></div>';
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{height:100%;margin:0;background:#140f2b;color:#efeaff;
    font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center}
  .card{width:330px;padding:26px 28px;background:#1d1540;border:1px solid #3d2f77;border-radius:14px}
  h1{font-size:20px;margin:0 0 4px}h1 span{color:#ffc94d}
  p{margin:0 0 14px;font-size:12px;color:#b8b0e0;line-height:1.5}
  input{width:100%;box-sizing:border-box;padding:11px 12px;font:16px ui-monospace,monospace;
    letter-spacing:1px;background:#0f0b24;color:#fff;border:1px solid #4a3a95;border-radius:8px;text-transform:uppercase}
  button{width:100%;margin-top:12px;padding:11px;font-size:14px;font-weight:600;color:#160b00;
    background:linear-gradient(180deg,#ffd66e,#f7a625);border:0;border-radius:8px;cursor:pointer}
  .msg{min-height:34px;margin-top:10px;font-size:12px;color:#8f86c9;line-height:1.45}
  .msg.bad{color:#ff8ba0}
</style></head><body>
<div class="card">
  <h1>⚡ Flash<span>TAP</span></h1>
  <p>${title}</p>
  <input id="key" placeholder="FT-XXXXX-XXXXX-XXXXX" value="${prefill || ''}" autocomplete="off" spellcheck="false" autofocus>
  <button onclick="go()">Activate</button>
  ${msg}
</div>
<script>
  function go(){var k=document.getElementById('key').value.trim();
    if(k) location.href='https://_activate.flastap.invalid/?key='+encodeURIComponent(k);}
  function showMsg(m,bad){var e=document.getElementById('msg');e.textContent=m;e.className='msg'+(bad?' bad':'');}
  document.getElementById('key').addEventListener('keydown',function(e){if(e.key==='Enter')go();});
</script></body></html>`;
}

function promptKey(prefill, message) {
  return new Promise((resolve) => {
    const lw = new BrowserWindow({
      width: 430, height: 340, useContentSize: true,
      resizable: false, minimizable: true, maximizable: false, fullscreenable: false,
      backgroundColor: '#140f2b', title: 'Activate FlashTap',
      autoHideMenuBar: true, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    lw.setMenuBarVisibility(false);
    lw.loadURL(dataUrl(shellHtml({ title: 'Enter the license key you were given to play.', prefill, message })));
    lw.once('ready-to-show', () => { lw.show(); lw.focus(); });
    lw.webContents.on('will-navigate', (e, url) => {
      if (url.startsWith('https://_activate.flastap.invalid/')) {
        e.preventDefault();
        try { resolve(decodeURIComponent(new URL(url).searchParams.get('key') || '')); }
        catch { resolve(''); }
      }
    });
    lw.on('closed', () => resolve(null));
    lw.isPrompt = true;
    promptKey.win = lw;
  });
}
function updatePrompt(prefill, message) {
  const lw = promptKey.win;
  if (!lw || lw.isDestroyed() || !lw.isPrompt) return null;
  lw.loadURL(dataUrl(shellHtml({ title: 'Enter the license key you were given to play.', prefill, message })));
  return lw;
}

function readInstalledKey() {
  // The installer seeds HKCU\Software\FlashTap\LicenseKey — prefill from it.
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\FlashTap', '/v', 'LicenseKey'], (err, so) => {
      try {
        if (err) return resolve(null);
        const m = String(so).match(/LicenseKey\s+REG_SZ\s+(FT-[0-9A-Z-]+)/i);
        resolve(m ? m[1] : null);
      } catch { resolve(null); }
    });
  });
}

async function licenseGate() {
  const ud = app.getPath('userData');
  const decision = await lic.evaluate(ud);
  if (decision.status === 'ok') return 'start';
  if (decision.status === 'revoked') {
    const bw = new BrowserWindow({
      width: 470, height: 300, resizable: false, minimizable: false, maximizable: false,
      backgroundColor: '#140f2b', autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    bw.loadURL(dataUrl(shellHtml({
      title: '⚠️ ✖ LICENSE REVOKED.',
      message: 'This license key has been revoked. FlashTap is locked until the key is reinstated. Contact the issuer.',
    })));
    return 'blocked'; // window-all-closed quits the app when the user closes this
  }
  // ---- activation loop ----
  let prefill = decision.savedKey || (await readInstalledKey());
  let message = '';
  for (;;) {
    const key = await promptKey(prefill, message);
    if (!key) return 'stop'; // user closed the window
    const r = await lic.activate(ud, key);
    if (r.ok) return 'start';
    if (!r.reachable) message = `⚠ No internet right now — first launch needs one online check. ${r.reason}`;
    else { message = r.reason; prefill = key; }
  }
}

async function startRevalLoop() {
  const ud = app.getPath('userData');
  setInterval(async () => {
    if (quitting) return;
    try {
      const decision = await lic.evaluate(ud);
      if (decision.status === 'revoked') {
        if (serverProc) { try { serverProc.kill(); serverProc = null; } catch {} }
        if (win) { try { win.destroy(); win = null; } catch {} }
        dialog.showErrorBox('FlashTap — license revoked',
          'The license key on this machine has been revoked by the issuer.\n\nFlashTap is locked until the key is reinstated.');
        app.quit();
      }
    } catch {}
  }, 30 * 60 * 1000).unref?.();
}

// ---------------------------------------------------------------------------
// Windows firewall — phones can only join if FlashTap.exe is allowed inbound.
// The installer adds a rule (best effort); when it is missing, offer the fix
// here. "Not now" is remembered so we don't nag on every launch.
// ---------------------------------------------------------------------------
const RULE_NAME = 'FlashTap';

function firewallRuleMissing() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${RULE_NAME}`], (err, so) => {
      resolve(!!err || !String(so).includes(RULE_NAME));
    });
  });
}

function addFirewallRuleElevated() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  // -EncodedCommand sidesteps every quoting pitfall (paths with spaces, etc.)
  const script = [
    `$exe = '${process.execPath.replace(/'/g, "''")}'`,
    "$prog = 'program=\"' + $exe + '\"'",
    "Start-Process netsh -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @(" +
      "'advfirewall','firewall','add','rule','name=FlashTap'," +
      "'dir=in','action=allow','enable=yes','profile=any',$prog)",
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { timeout: 120000 }, (err) => {
      resolve(!err);
    });
  });
}

async function ensureFirewallRule() {
  try {
    if (process.platform !== 'win32') return;
    if (!(await firewallRuleMissing())) return;

    const skipFile = path.join(app.getPath('userData'), 'firewall-skip.json');
    try { if (JSON.parse(require('node:fs').readFileSync(skipFile, 'utf8')).skipped) return; } catch {}

    const parent = win && !win.isDestroyed() ? win : null;
    const { response } = await dialog.showMessageBox(parent, {
      type: 'question',
      title: 'FlashTap',
      message: "Allow phones on the Wi-Fi to join FlashTap?",
      detail:
        'Windows Firewall has no allow rule for FlashTap, so phones on the same ' +
        'network may not be able to open the player page.\n\n' +
        'Adding the rule needs one administrator permission prompt.',
      buttons: ['Add firewall rule', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) {
      try { require('node:fs').writeFileSync(skipFile, JSON.stringify({ skipped: Date.now() })); } catch {}
      return;
    }
    await addFirewallRuleElevated();
    if (await firewallRuleMissing()) {
      dialog.showMessageBox(parent, {
        type: 'info', title: 'FlashTap',
        message: 'The firewall rule was not added.',
        detail: 'Phones may not be able to connect. Add an inbound allow rule for FlashTap.exe, or run the installer again.',
        buttons: ['OK'], noLink: true,
      });
    }
  } catch {}
}

// pre-existing helpers below this line
