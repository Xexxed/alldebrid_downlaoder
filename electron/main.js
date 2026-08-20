/**
 * AllDebrid Downloader — Electron Main Process
 * High-Performance Desktop Client with System Tray & Native OS Integration
 */

import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { startServer, engine } from '../server/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

let mainWindow = null;
let tray = null;
let serverInstance = null;
let serverPort = process.env.PORT || 3000;
let isQuitting = false;

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

/**
 * Format bytes for tray status
 */
function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

/**
 * Get Application Icon
 */
function getAppIcon() {
  const iconPathPng = path.join(ROOT_DIR, 'assets', 'icon.png');
  const iconPathIco = path.join(ROOT_DIR, 'assets', 'icon.ico');

  if (process.platform === 'win32' && fs.existsSync(iconPathIco)) {
    return nativeImage.createFromPath(iconPathIco);
  }
  if (fs.existsSync(iconPathPng)) {
    return nativeImage.createFromPath(iconPathPng);
  }
  // Generate a fallback 32x32 colored icon if asset doesn't exist yet
  const fallback = nativeImage.createEmpty();
  return fallback;
}

/**
 * Create the Primary Desktop Window
 */
function createWindow() {
  const appIcon = getAppIcon();

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1000,
    minHeight: 680,
    title: 'AllDebrid Downloader',
    backgroundColor: '#090a0f',
    icon: appIcon,
    autoHideMenuBar: true,
    show: false, // Show when ready to prevent visual flicker
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  const appUrl = `http://localhost:${serverPort}`;
  mainWindow.loadURL(appUrl);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Minimize to tray on close
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (tray && process.platform === 'win32') {
        tray.displayBalloon?.({
          title: 'AllDebrid Downloader',
          content: 'Application is still running in the background. Access it from the system tray.',
        });
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in default OS browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

/**
 * Setup System Tray with dynamic metrics and quick actions
 */
function createTray() {
  const appIcon = getAppIcon();
  tray = new Tray(appIcon);
  tray.setToolTip('AllDebrid Downloader');

  updateTrayMenu();

  tray.on('click', () => {
    if (!mainWindow) {
      createWindow();
    } else if (mainWindow.isVisible()) {
      if (mainWindow.isFocused()) {
        mainWindow.hide();
      } else {
        mainWindow.focus();
      }
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;

  const tasks = engine ? engine.getAllTasks() : [];
  const activeCount = tasks.filter((t) => t.status === 'downloading' || t.status === 'extracting').length;
  const totalSpeed = engine ? engine.totalSpeed || 0 : 0;
  const speedText = totalSpeed > 0 ? `${formatBytes(totalSpeed)}/s` : 'Idle';

  const statusLabel = activeCount > 0
    ? `Active: ${activeCount} (${speedText})`
    : `Status: Idle`;

  tray.setToolTip(`AllDebrid Downloader — ${statusLabel}`);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'AllDebrid Downloader',
      enabled: false,
      icon: getAppIcon().resize({ width: 16, height: 16 }),
    },
    { type: 'separator' },
    {
      label: statusLabel,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Show Dashboard',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    {
      label: 'Open Downloads Directory',
      click: () => {
        const downloadDir = engine ? engine.downloadDir : path.join(ROOT_DIR, 'downloads');
        if (fs.existsSync(downloadDir)) {
          shell.openPath(downloadDir);
        } else {
          fs.mkdirSync(downloadDir, { recursive: true });
          shell.openPath(downloadDir);
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit AllDebrid',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

/**
 * Setup Native IPC Handlers
 */
function setupIpcHandlers() {
  // Folder selector dialog
  ipcMain.handle('dialog:selectFolder', async (_event, defaultPath) => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Download Directory',
      defaultPath: defaultPath || (engine ? engine.downloadDir : ROOT_DIR),
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });

    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  });

  // Open directory in OS Explorer / Finder
  ipcMain.handle('shell:openPath', async (_event, targetPath) => {
    if (!targetPath) return false;
    const resolved = path.resolve(targetPath);
    if (fs.existsSync(resolved)) {
      await shell.openPath(resolved);
      return true;
    }
    return false;
  });

  // Reveal item in Explorer / Finder
  ipcMain.handle('shell:showItemInFolder', async (_event, filePath) => {
    if (!filePath) return false;
    const resolved = path.resolve(filePath);
    if (fs.existsSync(resolved)) {
      shell.showItemInFolder(resolved);
      return true;
    }
    return false;
  });

  // Show Native OS Desktop Notification
  ipcMain.handle('app:showNotification', (_event, options = {}) => {
    if (Notification.isSupported()) {
      const notif = new Notification({
        title: options.title || 'AllDebrid Downloader',
        body: options.body || '',
        icon: getAppIcon(),
        silent: options.silent || false,
      });

      notif.on('click', () => {
        if (mainWindow) {
          if (!mainWindow.isVisible()) mainWindow.show();
          mainWindow.focus();
        }
      });

      notif.show();
      return true;
    }
    return false;
  });

  // Window control handles
  ipcMain.handle('window:minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.handle('window:maximize', () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  ipcMain.handle('window:close', () => {
    if (mainWindow) mainWindow.close();
  });

  ipcMain.handle('app:getVersion', () => {
    return app.getVersion();
  });
}

/**
 * Setup Engine Events for Tray and OS Notifications
 */
function setupEngineListeners() {
  if (!engine) return;

  // Update tray tooltip on progress tick (throttled)
  let lastTrayUpdate = 0;
  engine.on('progress', () => {
    const now = Date.now();
    if (now - lastTrayUpdate > 1000) {
      lastTrayUpdate = now;
      updateTrayMenu();
    }
  });

  engine.on('taskCompleted', (task) => {
    updateTrayMenu();
    if (Notification.isSupported()) {
      const notif = new Notification({
        title: '✅ Download Completed',
        body: `${task.name}\nSize: ${formatBytes(task.size)}`,
        icon: getAppIcon(),
      });
      notif.on('click', () => {
        if (mainWindow) {
          if (!mainWindow.isVisible()) mainWindow.show();
          mainWindow.focus();
        }
      });
      notif.show();
    }
  });

  engine.on('taskError', (task) => {
    updateTrayMenu();
    if (Notification.isSupported()) {
      const notif = new Notification({
        title: '❌ Download Error',
        body: `${task.name}: ${task.error || 'Unknown error occurred'}`,
        icon: getAppIcon(),
      });
      notif.show();
    }
  });

  engine.on('taskAdded', () => updateTrayMenu());
  engine.on('taskDeleted', () => updateTrayMenu());
}

/**
 * App Lifecycle
 */
app.whenReady().then(async () => {
  setupIpcHandlers();

  try {
    // Start Express + WebSocket backend server
    const serverResult = await startServer(serverPort);
    serverInstance = serverResult.server;
    serverPort = serverResult.port;
    console.log(`[Electron] Backend connected on port ${serverPort}`);
  } catch (err) {
    console.error('[Electron] Failed to start backend server:', err);
  }

  setupEngineListeners();
  createTray();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});
