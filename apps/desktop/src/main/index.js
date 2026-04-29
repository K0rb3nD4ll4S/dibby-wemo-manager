'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, clipboard, shell } = require('electron');
const path       = require('path');
const wemo       = require('./wemo');
const store      = require('./store');
const webServer  = require('./web-server');
const firewall   = require('./firewall');

// Portable mode: store data next to .exe
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'WemoManagerData'));
}

// Surface stray errors as console output instead of the cryptic
// "A JavaScript error occurred in the main process: undefined: undefined"
// dialog. Errors that need to be shown to the user are surfaced via toast
// from explicit IPC error handlers; this just keeps the app alive on background failures.
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason && (reason.stack || reason.message || reason));
});
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err && (err.stack || err.message || err));
});

let mainWindow      = null;
let tray            = null;
let forceQuit       = false; // set true only when user chooses Quit from tray/menu
let firewallActive  = false; // cached result of last firewall check

function getResourcesDir() {
  return app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', '..', 'resources');
}
const ICON_PATH = () => path.join(getResourcesDir(), 'icon.png');

// ── Tray ────────────────────────────────────────────────────────────────────

function buildTrayMenu() {
  const schedulerModule = (() => { try { return require('./scheduler'); } catch { return null; } })();
  const isRunning = schedulerModule?.getStatus?.()?.running ?? false;
  const remoteURL = webServer.getURL();

  return Menu.buildFromTemplate([
    { label: 'Dibby Wemo Manager', enabled: false },
    { type: 'separator' },
    {
      label: isRunning ? '🟢 Scheduler running' : '⚫ Scheduler stopped',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: `📱 Web Remote: ${remoteURL}`,
      enabled: false,
    },
    {
      label: 'Copy Web Remote URL',
      click: () => clipboard.writeText(remoteURL),
    },
    {
      label: 'Open Web Remote in Browser',
      click: () => shell.openExternal(remoteURL),
    },
    {
      label: '📷 Show QR Code',
      click: () => showQR(remoteURL),
    },
    ...(process.platform === 'win32' ? [
      {
        label: firewallActive ? '✅ Firewall rule active' : '🔓 Open Port in Windows Firewall',
        enabled: !firewallActive,
        click: () => openFirewallPort(),
      },
      {
        label: '🗑 Delete Firewall Rule',
        enabled: firewallActive,
        click: () => deleteFirewallRule(),
      },
    ] : []),
    { type: 'separator' },
    { label: 'Open', click: showWindow },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        forceQuit = true;
        app.quit();
      },
    },
  ]);
}

function openFirewallPort() {
  const port = webServer.WEB_PORT;
  firewall.openPort(port, process.execPath, (err) => {
    if (err) {
      console.error('[Firewall] Failed to open port:', err.message);
      return;
    }
    // Re-check status after a short delay to allow the rule to register
    setTimeout(() => {
      firewall.checkRule((_e, active) => {
        firewallActive = active;
        if (tray) tray.setContextMenu(buildTrayMenu());
      });
    }, 1500);
  });
}

function deleteFirewallRule() {
  firewall.deleteRule((err) => {
    if (err) {
      console.error('[Firewall] Failed to delete rule:', err.message);
      return;
    }
    setTimeout(() => {
      firewall.checkRule((_e, active) => {
        firewallActive = active;
        if (tray) tray.setContextMenu(buildTrayMenu());
      });
    }, 1500);
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH());
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Dibby Wemo Manager — scheduler running');
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', showWindow);
  // Refresh menu every 5 s for scheduler + firewall status
  setInterval(() => {
    if (!tray) return;
    firewall.checkRule((_e, active) => {
      firewallActive = active;
      tray.setContextMenu(buildTrayMenu());
    });
  }, 5000);
  // Do an immediate firewall check on startup
  firewall.checkRule((_e, active) => {
    firewallActive = active;
    if (tray) tray.setContextMenu(buildTrayMenu());
  });
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
  } else if (mainWindow.isMinimized()) {
    mainWindow.restore();
  } else {
    mainWindow.show();
  }
  mainWindow.focus();
}

// ── Main window ──────────────────────────────────────────────────────────────

function createWindow() {
  const isDark = store.getTheme() !== 'light';

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: isDark ? '#0d1b27' : '#f0f4f0',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
    title: 'Dibby Wemo Manager',
    icon: ICON_PATH(),
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'out', 'renderer', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Close button → hide to tray (keep scheduler alive); only quit when forceQuit
  mainWindow.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault();
      mainWindow.hide();
      if (tray) {
        tray.displayBalloon({
          title: 'Dibby Wemo Manager',
          content: 'Minimized to tray — scheduler is still running.',
          noSound: true,
        });
      }
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; wemo.stopDiscovery(); });
}

// ── App menu ─────────────────────────────────────────────────────────────────

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Discover Devices', accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.webContents.send('trigger-discovery') },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => { forceQuit = true; app.quit(); },
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Help Guide',
          accelerator: 'F1',
          click: () => showHelp(),
        },
        { type: 'separator' },
        { label: 'About Dibby Wemo Manager', click: () => showAbout() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

let helpWindow = null;

function showHelp() {
  if (helpWindow && !helpWindow.isDestroyed()) {
    helpWindow.focus();
    return;
  }
  helpWindow = new BrowserWindow({
    width: 960,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    title: 'Dibby Wemo Manager — Help',
    icon: ICON_PATH(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
  });
  helpWindow.loadFile(path.join(getResourcesDir(), 'help.html'));
  helpWindow.on('closed', () => { helpWindow = null; });
}

let qrWindow = null;

function showQR(remoteURL) {
  if (qrWindow && !qrWindow.isDestroyed()) { qrWindow.focus(); return; }
  qrWindow = new BrowserWindow({
    width: 360, height: 480, resizable: false,
    title: 'DWM Web Remote — QR Code',
    icon: ICON_PATH(),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
    autoHideMenuBar: true, minimizable: false, maximizable: false,
  });
  qrWindow.loadURL((remoteURL || webServer.getURL()) + '/qr');
  qrWindow.on('closed', () => { qrWindow = null; });
}

let aboutWindow = null;

function showAbout() {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.focus();
    return;
  }
  aboutWindow = new BrowserWindow({
    width: 600,
    height: 800,
    resizable: false,
    title: 'About Dibby Wemo Manager',
    icon: ICON_PATH(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
    minimizable: false,
    maximizable: false,
  });
  aboutWindow.loadFile(path.join(getResourcesDir(), 'about.html'));
  aboutWindow.on('closed', () => { aboutWindow = null; });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Seed wemo module with stored location
  const loc = store.getLocation();
  if (loc) wemo.setLocation(loc);

  // Register all IPC handlers
  require('./ipc/devices.ipc')();
  require('./ipc/rules.ipc')();
  require('./ipc/wifi.ipc')();
  require('./ipc/system.ipc')();
  require('./ipc/scheduler.ipc')();
  require('./ipc/homekit.ipc')();

  // Start embedded web remote server (phone access on local network)
  const scheduler = (() => { try { return require('./scheduler'); } catch { return null; } })();
  webServer.start(scheduler, store, wemo);

  buildMenu();
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Prevent default quit-on-all-windows-closed — tray keeps the app alive
app.on('window-all-closed', () => {
  // On macOS keep running; on Windows/Linux only quit if forceQuit
  if (process.platform === 'darwin' && !forceQuit) return;
  if (!forceQuit) return; // window was just hidden to tray
  app.quit();
});
