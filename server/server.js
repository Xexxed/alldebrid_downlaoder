/**
 * AllDebrid Downloader Server
 * Express REST API + WebSocket live metrics stream
 */

import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import multer from 'multer';
import { spawn } from 'child_process';
import dotenv from 'dotenv';

import os from 'os';

import { AllDebridClient, parseDownloadInput, flattenFileTree, sanitizePathSegment, normalizeMagnetResponse, fetchRapidgatorFolder } from './alldebrid.js';
import { isArchiveFile } from './extractor.js';
import { DownloadEngine } from './downloader.js';
import { searchAggregator, extractHashFromMagnet } from './search.js';
import { Persistence } from './persistence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// In Electron packaged builds, write config to AppData/UserData; in standalone Node, use project root
const CONFIG_DIR = process.env.APP_DATA_DIR || ROOT_DIR;
const ENV_PATH = path.join(CONFIG_DIR, '.env');
const ROOT_ENV_PATH = path.join(ROOT_DIR, '.env');

if (fs.existsSync(ENV_PATH)) {
  dotenv.config({ path: ENV_PATH });
} else if (fs.existsSync(ROOT_ENV_PATH)) {
  dotenv.config({ path: ROOT_ENV_PATH });
} else {
  dotenv.config();
}

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Durable state (task queue + usage stats)
const STATE_PATH = process.env.STATE_PATH || path.join(CONFIG_DIR, 'state.json');
const persistence = new Persistence(STATE_PATH);

// Detect drives on Windows
const AVAILABLE_DRIVES = (() => {
  if (process.platform === 'win32') {
    const drives = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
      .map((l) => `${l}:\\`)
      .filter((d) => {
        try { return fs.existsSync(d); } catch { return false; }
      });
    return drives.length > 0 ? drives : ['C:\\'];
  }
  return ['/'];
})();

// Multer memory storage for .torrent uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// App State
let apiKey = process.env.ALLDEBRID_API_KEY || '';
let defaultDownloadDir = process.env.DOWNLOAD_DIR;
if (!defaultDownloadDir) {
  if (process.versions.electron) {
    defaultDownloadDir = path.join(os.homedir(), 'Downloads', 'AllDebrid');
  } else {
    defaultDownloadDir = path.resolve(ROOT_DIR, './downloads');
  }
}
let downloadDir = path.resolve(defaultDownloadDir);
let maxConcurrent = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 3;
let jackettUrl = process.env.JACKETT_URL || '';
let jackettApiKey = process.env.JACKETT_API_KEY || '';
let authToken = process.env.AUTH_TOKEN || '';
let speedLimitKbps = parseInt(process.env.SPEED_LIMIT_KBPS, 10) || 0;
let minFreeGb = parseFloat(process.env.MIN_FREE_GB);
if (Number.isNaN(minFreeGb)) minFreeGb = 5;
let scheduleEnabled = process.env.SCHEDULE_ENABLED === '1';
let scheduleStart = process.env.SCHEDULE_START || '';
let scheduleEnd = process.env.SCHEDULE_END || '';
let scheduleLimitKbps = parseInt(process.env.SCHEDULE_LIMIT_KBPS, 10) || 0;

const client = new AllDebridClient(apiKey);
const engine = new DownloadEngine(client, {
  downloadDir,
  maxConcurrent,
  persistence,
  maxRetries: parseInt(process.env.MAX_RETRIES, 10) || 3,
});
engine.setSpeedLimit(speedLimitKbps * 1024);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT_DIR, 'public')));
app.use('/assets', express.static(path.join(ROOT_DIR, 'assets')));

// ==========================================
// Auth (opt-in via AUTH_TOKEN setting)
// ==========================================

function extractRequestToken(req) {
  const header = req.headers['authorization'];
  if (header && /^bearer\s+/i.test(header)) {
    return header.replace(/^bearer\s+/i, '').trim();
  }
  if (req.query && typeof req.query.token === 'string') {
    return req.query.token.trim();
  }
  return '';
}

function requireAuth(req, res, next) {
  if (!authToken) return next();
  if (extractRequestToken(req) === authToken) return next();
  res.status(401).json({ error: 'Unauthorized: a valid auth token is required' });
}

// Public (unauthenticated) endpoint so the UI can detect lock state and pre-validate tokens
app.get('/api/auth-check', (req, res) => {
  if (!authToken) {
    return res.json({ authRequired: false, tokenValid: true });
  }
  const provided = extractRequestToken(req);
  res.json({ authRequired: true, tokenValid: provided === authToken });
});

app.use('/api', requireAuth);

// ==========================================
// Disk space utilities
// ==========================================

function getFreeBytes(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return null;
    // fs.statfs requires Node >= 18.15 on Windows; degrade gracefully
    const stats = fs.statfsSync(dirPath);
    return stats.bsize * stats.bavail;
  } catch {
    return null;
  }
}

// ==========================================
// Bandwidth scheduler (daily off-peak window)
// ==========================================

let effectiveLimitBytes = speedLimitKbps * 1024;

function parseHmToMinutes(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function isWithinScheduleWindow(now = new Date()) {
  const startMin = parseHmToMinutes(scheduleStart);
  const endMin = parseHmToMinutes(scheduleEnd);
  if (startMin === null || endMin === null) return false;
  const curMin = now.getHours() * 60 + now.getMinutes();
  if (startMin === endMin) return true; // full-day window
  if (startMin < endMin) return curMin >= startMin && curMin < endMin;
  return curMin >= startMin || curMin < endMin; // wraps past midnight
}

function applyBandwidthPolicy() {
  let targetKbps = speedLimitKbps;
  if (scheduleEnabled && isWithinScheduleWindow() && scheduleLimitKbps > 0) {
    targetKbps = scheduleLimitKbps;
  }
  const targetBytes = targetKbps * 1024;
  if (targetBytes !== effectiveLimitBytes) {
    effectiveLimitBytes = targetBytes;
    engine.setSpeedLimit(targetBytes);
    console.log(`[Scheduler] Speed limit set to ${targetKbps} KB/s`);
  }
}

applyBandwidthPolicy();
setInterval(applyBandwidthPolicy, 60_000).unref?.();

// ==========================================
// Runtime disk-space guard
// ==========================================

const MIN_FREE_BYTES = () => minFreeGb * 1024 ** 3;
let diskGuardTripped = false;

setInterval(() => {
  if (minFreeGb <= 0) return;
  const activeTasks = engine.getAllTasks().filter((t) => t.status === 'downloading');
  if (activeTasks.length === 0) {
    diskGuardTripped = false;
    return;
  }

  const dirs = [...new Set(activeTasks.map((t) => t.outputDir))];
  for (const dir of dirs) {
    const free = getFreeBytes(dir);
    if (free === null) continue;
    if (free < MIN_FREE_BYTES()) {
      if (!diskGuardTripped) {
        diskGuardTripped = true;
        const pausedCount = engine.pauseAll();
        const message = `Low disk space (${(free / 1024 ** 3).toFixed(1)} GB free, threshold ${minFreeGb} GB). Paused ${pausedCount} task(s).`;
        console.warn(`[DiskGuard] ${message}`);
        broadcast({ type: 'disk_warning', message, freeBytes: free });
        engine.emit('diskWarning', { message, freeBytes: free });
      }
      return;
    }
  }
  diskGuardTripped = false;
}, 60_000).unref?.();

// Flush durable state cleanly on shutdown
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try { engine.flushPersistenceSync(); } catch {}
    process.exit(0);
  });
}
process.on('exit', () => {
  try { engine.flushPersistenceSync(); } catch {}
});

// Broadcast updates to all connected WebSocket clients
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((wsClient) => {
    if (wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(msg);
    }
  });
}

// Attach engine events to WebSockets
engine.on('progress', () => {
  broadcast({
    type: 'progress_tick',
    tasks: engine.getAllTasks(),
    globalSpeed: engine.totalSpeed || 0,
  });
});

engine.on('taskAdded', (task) => {
  broadcast({ type: 'task_added', task });
});

engine.on('taskUpdated', (task) => {
  broadcast({ type: 'task_updated', task });
});

engine.on('taskCompleted', (task) => {
  broadcast({ type: 'task_completed', task });
});

engine.on('taskDeleted', (taskId) => {
  broadcast({ type: 'task_deleted', taskId });
});

wss.on('connection', (ws, req) => {
  // Enforce auth token on WebSocket handshakes when configured
  if (authToken) {
    let token = '';
    try {
      const url = new URL(req.url, 'http://localhost');
      token = url.searchParams.get('token') || '';
    } catch {}
    if (token !== authToken) {
      ws.close(4401, 'Unauthorized');
      return;
    }
  }

  // Send initial snapshot
  ws.send(
    JSON.stringify({
      type: 'initial_state',
      tasks: engine.getAllTasks(),
      globalSpeed: engine.totalSpeed || 0,
      settings: {
        hasApiKey: !!apiKey,
        downloadDir,
        maxConcurrent,
        speedLimitKbps,
        scheduleEnabled,
        scheduleStart,
        scheduleEnd,
        scheduleLimitKbps,
      },
    })
  );
});

// ==========================================
// API ROUTES
// ==========================================

/**
 * Browse local filesystem directory for folder browser
 */
app.get('/api/browse-directory', (req, res) => {
  try {
    const drives = AVAILABLE_DRIVES;
    let targetPath = req.query.path ? path.resolve(req.query.path) : downloadDir;

    if (!req.query.path && !fs.existsSync(targetPath)) {
      targetPath = drives[0] || ROOT_DIR;
    }

    if (!fs.existsSync(targetPath)) {
      targetPath = drives[0] || ROOT_DIR;
    }

    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      targetPath = path.dirname(targetPath);
    }

    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const directories = [];

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('$') && !entry.name.startsWith('.')) {
        try {
          const fullSubPath = path.join(targetPath, entry.name);
          directories.push({
            name: entry.name,
            path: fullSubPath,
          });
        } catch {}
      }
    }

    directories.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const parsedPath = path.parse(targetPath);
    const isRoot = parsedPath.root === targetPath || targetPath === '/' || targetPath === '';
    const parentPath = isRoot ? null : path.dirname(targetPath);

    res.json({
      currentPath: targetPath,
      parentPath,
      isRoot,
      directories,
      drives,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Create a new folder
 */
app.post('/api/create-directory', (req, res) => {
  const { parentPath, folderName } = req.body;
  if (!parentPath || !folderName) {
    return res.status(400).json({ error: 'parentPath and folderName are required' });
  }
  try {
    const cleanName = sanitizePathSegment(folderName);
    const newDir = path.join(path.resolve(parentPath), cleanName);
    if (!fs.existsSync(newDir)) {
      fs.mkdirSync(newDir, { recursive: true });
    }
    res.json({ success: true, path: newDir });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Health & User Account info
 */
app.get('/api/status', async (req, res) => {
  let userInfo = null;
  let userError = null;

  if (apiKey) {
    try {
      const data = await client.getUserInfo();
      userInfo = data?.user || null;
    } catch (err) {
      userError = err.message;
    }
  }

  res.json({
    status: 'ok',
    hasApiKey: !!apiKey,
    userInfo,
    userError,
    downloadDir,
    maxConcurrent,
    activeTasksCount: engine.getAllTasks().filter((t) => t.status === 'downloading').length,
    globalSpeed: engine.totalSpeed || 0,
  });
});

/**
 * Resolve torrent/magnet preview metadata and file list
 */
async function resolveMagnetPreview(magnetId, defaultName = '', defaultSize = 0, isReady = false, initialFiles = null) {
  let name = defaultName ? sanitizePathSegment(defaultName) : `Torrent_${magnetId}`;
  let filesTree = initialFiles;
  let totalSize = defaultSize;
  let ready = isReady;

  try {
    const [statusRes, filesRes] = await Promise.all([
      ready ? null : client.getMagnetStatus(magnetId).catch(() => null),
      client.getMagnetFiles(magnetId).catch(() => null),
    ]);

    const mStatus = normalizeMagnetResponse(statusRes, magnetId);
    if (mStatus?.filename) name = sanitizePathSegment(mStatus.filename);
    if (mStatus?.size) totalSize = mStatus.size;
    if (mStatus?.statusCode === 4) ready = true;

    const mFiles = normalizeMagnetResponse(filesRes, magnetId)?.files;
    if (mFiles) {
      filesTree = mFiles;
      ready = true;
    }
  } catch {}

  const flattenedFiles = filesTree ? flattenFileTree(filesTree) : [];
  if (flattenedFiles.length > 0) {
    totalSize = flattenedFiles.reduce((acc, f) => acc + f.size, 0);
  }

  return {
    type: 'torrent',
    magnetId,
    name,
    totalSize,
    isReady: ready,
    filesTree,
    flattenedFiles,
    defaultOutputDir: path.join(downloadDir, name),
  };
}

/**
 * Preview Download Structure before queueing
 */
app.post('/api/downloads/preview', upload.array('torrents'), async (req, res) => {
  if (!apiKey) {
    return res.status(400).json({ error: 'AllDebrid API Key is not set. Please update it in Settings.' });
  }

  const previews = [];
  const errors = [];

  // 1. Process uploaded .torrent files
  if (req.files && req.files.length > 0) {
    for (const file of req.files) {
      try {
        const uploadRes = await client.uploadTorrentFile(file.buffer, file.originalname);
        const fileData = uploadRes?.files?.[0];

        if (fileData?.error) {
          errors.push(`Torrent ${file.originalname}: ${fileData.error.message || fileData.error.code}`);
          continue;
        }

        if (fileData) {
          previews.push(await resolveMagnetPreview(fileData.id, fileData.name || file.originalname.replace(/\.torrent$/i, ''), fileData.size, fileData.ready));
        }
      } catch (err) {
        errors.push(`Error processing ${file.originalname}: ${err.message}`);
      }
    }
  }

  // 2. Process text inputs
  if (req.body.input && typeof req.body.input === 'string') {
    const items = parseDownloadInput(req.body.input);
    for (const item of items) {
      try {
        if (item.type === 'folderLink' || (item.type === 'directLink' && /https?:\/\/(?:www\.)?(?:rapidgator\.net|rg\.to)\/folder\//i.test(item.url))) {
          const folderUrl = item.url || item.original;
          const folderData = await fetchRapidgatorFolder(folderUrl);
          const folderName = folderData.folderName || 'Rapidgator_Folder';
          const hasArchives = folderData.files.some((f) => isArchiveFile(f.name));

          previews.push({
            type: 'folder',
            host: item.host || 'rapidgator',
            name: folderName,
            totalSize: folderData.totalSize,
            isReady: true,
            filesTree: null,
            hasArchives,
            flattenedFiles: folderData.files.map((f) => ({
              name: f.name,
              relativePath: f.relativePath || f.name,
              size: f.size,
              sizeStr: f.sizeStr,
              link: f.link,
            })),
            defaultOutputDir: path.join(downloadDir, folderName),
          });
        } else if (item.type === 'getMagnet' || item.type === 'magnetId') {
          const preview = await resolveMagnetPreview(item.id);
          preview.hasArchives = preview.flattenedFiles?.some((f) => isArchiveFile(f.name));
          previews.push(preview);
        } else if (item.type === 'magnet') {
          const uploadRes = await client.uploadMagnet(item.uri);
          const uploaded = uploadRes?.magnets?.[0];

          if (uploaded?.error) {
            errors.push(`Magnet error: ${uploaded.error.message || uploaded.error.code}`);
            continue;
          }

          if (uploaded) {
            const preview = await resolveMagnetPreview(uploaded.id, uploaded.name, uploaded.size, uploaded.ready);
            preview.hasArchives = preview.flattenedFiles?.some((f) => isArchiveFile(f.name));
            previews.push(preview);
          }
        } else if (item.type === 'directLink') {
          const unlockData = await client.unlockLink(item.url);
          const filename = sanitizePathSegment(unlockData.filename || 'download.file');
          const size = Number(unlockData.filesize) || 0;
          previews.push({
            type: 'directLink',
            url: item.url,
            name: filename,
            totalSize: size,
            isReady: true,
            filesTree: null,
            hasArchives: isArchiveFile(filename),
            flattenedFiles: [{ name: filename, relativePath: filename, size, link: item.url }],
            defaultOutputDir: path.join(downloadDir, filename),
          });
        }
      } catch (err) {
        errors.push(`Error parsing ${item.original || item.url || item.id}: ${err.message}`);
      }
    }
  }

  // Annotate all preview files with on-disk state
  for (const p of previews) {
    const targetDir = p.defaultOutputDir;
    if (p.flattenedFiles && p.flattenedFiles.length > 0) {
      for (const f of p.flattenedFiles) {
        const relativeNorm = f.relativePath.split('/').join(path.sep);
        const fullPath = path.join(targetDir, relativeNorm);
        f.existsOnDisk = false;
        f.diskBytes = 0;
        f.isCompleteOnDisk = false;
        try {
          if (fs.existsSync(fullPath)) {
            const stat = fs.statSync(fullPath);
            f.existsOnDisk = true;
            f.diskBytes = stat.size;
            if (f.size > 0 && stat.size >= f.size) {
              f.isCompleteOnDisk = true;
            }
          }
        } catch {}
      }
    }

    // Disk-space pre-flight: warn before queueing tasks larger than available space
    let probeDir = targetDir;
    while (probeDir && !fs.existsSync(probeDir)) {
      const parent = path.dirname(probeDir);
      if (parent === probeDir) break;
      probeDir = parent;
    }
    p.freeSpaceBytes = probeDir ? getFreeBytes(probeDir) : null;
    if (p.freeSpaceBytes !== null && p.totalSize > 0) {
      p.fitsOnDisk = p.freeSpaceBytes - p.totalSize > MIN_FREE_BYTES();
    } else {
      p.fitsOnDisk = true; // unknown volume capacity: don't block
    }
  }

  res.json({ previews, errors });
});

/**
 * Add downloads (accepts confirmed review items or direct text input)
 */
app.post('/api/downloads/add', async (req, res) => {
  if (!apiKey) {
    return res.status(400).json({ error: 'AllDebrid API Key is not set. Please update it in Settings.' });
  }

  const addedTasks = [];
  const errors = [];

  // Handle structured items confirmed from the Download Review Screen
  if (Array.isArray(req.body.items) && req.body.items.length > 0) {
    for (const item of req.body.items) {
      try {
        const options = {
          autoExtract: !!item.autoExtract,
          deleteArchiveAfterExtract: !!item.deleteArchiveAfterExtract,
        };

        if (item.type === 'folder' && Array.isArray(item.files)) {
          const task = await engine.addFolderTask(
            item.name,
            item.files,
            item.customOutputDir,
            item.selectedFiles,
            options
          );
          addedTasks.push(task);
        } else if (item.type === 'torrent' && item.magnetId) {
          const task = await engine.addMagnetTask(
            item.magnetId,
            item.name,
            item.filesTree,
            item.customOutputDir,
            item.selectedFiles,
            options
          );
          addedTasks.push(task);
        } else if (item.type === 'directLink' && item.url) {
          const task = await engine.addDirectLinkTask(
            item.url,
            item.name,
            item.customOutputDir,
            options
          );
          addedTasks.push(task);
        }
      } catch (err) {
        errors.push(`Error adding ${item.name || item.magnetId}: ${err.message}`);
      }
    }

    return res.json({
      success: true,
      addedCount: addedTasks.length,
      tasks: addedTasks.map((t) => t.id),
      errors,
    });
  }

  // Fallback direct text input
  const { input, autoExtract, deleteArchiveAfterExtract } = req.body;
  if (!input || typeof input !== 'string') {
    return res.status(400).json({ error: 'Input or items is required' });
  }

  const items = parseDownloadInput(input);
  if (items.length === 0) {
    return res.status(400).json({ error: 'No valid download links or magnet URIs detected' });
  }

  const defaultOptions = {
    autoExtract: !!autoExtract,
    deleteArchiveAfterExtract: !!deleteArchiveAfterExtract,
  };

  for (const item of items) {
    try {
      if (item.type === 'folderLink' || (item.type === 'directLink' && /https?:\/\/(?:www\.)?(?:rapidgator\.net|rg\.to)\/folder\//i.test(item.url))) {
        const folderData = await fetchRapidgatorFolder(item.url || item.original);
        const task = await engine.addFolderTask(
          folderData.folderName,
          folderData.files,
          null,
          null,
          defaultOptions
        );
        addedTasks.push(task);
      } else if (item.type === 'getMagnet' || item.type === 'magnetId') {
        const task = await engine.addMagnetTask(item.id, '', null, null, null, defaultOptions);
        addedTasks.push(task);
      } else if (item.type === 'magnet') {
        const uploadRes = await client.uploadMagnet(item.uri);
        const uploaded = uploadRes?.magnets?.[0];

        if (uploaded) {
          if (uploaded.error) {
            errors.push(`Magnet upload error: ${uploaded.error.message || uploaded.error.code}`);
            continue;
          }

          const task = await engine.addMagnetTask(uploaded.id, uploaded.name, null, null, null, defaultOptions);
          addedTasks.push(task);
        }
      } else if (item.type === 'directLink') {
        const task = await engine.addDirectLinkTask(item.url, '', null, defaultOptions);
        addedTasks.push(task);
      }
    } catch (err) {
      errors.push(`Error adding ${item.original}: ${err.message}`);
    }
  }

  res.json({
    success: true,
    addedCount: addedTasks.length,
    tasks: addedTasks.map((t) => t.id),
    errors,
  });
});

/**
 * Upload .torrent file(s)
 */
app.post('/api/downloads/upload-torrent', upload.array('torrents'), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No .torrent files provided' });
  }

  if (!apiKey) {
    return res.status(400).json({ error: 'AllDebrid API Key is not set. Please update it in Settings.' });
  }

  const addedTasks = [];
  const errors = [];

  for (const file of req.files) {
    try {
      const uploadRes = await client.uploadTorrentFile(file.buffer, file.originalname);
      const fileData = uploadRes?.files?.[0];

      if (fileData) {
        if (fileData.error) {
          errors.push(`Torrent error for ${file.originalname}: ${fileData.error.message || fileData.error.code}`);
          continue;
        }

        const task = await engine.addMagnetTask(fileData.id, fileData.name);
        addedTasks.push(task);
      }
    } catch (err) {
      errors.push(`Error uploading ${file.originalname}: ${err.message}`);
    }
  }

  res.json({
    success: true,
    addedCount: addedTasks.length,
    tasks: addedTasks.map((t) => t.id),
    errors,
  });
});

/**
 * List all downloads
 */
app.get('/api/downloads', (req, res) => {
  res.json({
    tasks: engine.getAllTasks(),
    globalSpeed: engine.totalSpeed || 0,
  });
});

/**
 * Get full task details including file tree
 */
app.get('/api/downloads/:id', (req, res) => {
  const task = engine.getTaskDetails(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.json({ task });
});

/**
 * Pause download task
 */
app.post('/api/downloads/:id/pause', (req, res) => {
  const ok = engine.pauseTask(req.params.id);
  res.json({ success: ok });
});

/**
 * Resume download task
 */
app.post('/api/downloads/:id/resume', (req, res) => {
  const ok = engine.resumeTask(req.params.id);
  res.json({ success: ok });
});

/**
 * Retry failed files in task
 */
app.post('/api/downloads/:id/retry', (req, res) => {
  const ok = engine.retryTask(req.params.id);
  res.json({ success: ok });
});

/**
 * Cancel and remove download task
 */
app.post('/api/downloads/:id/cancel', (req, res) => {
  const deleteFiles = req.body.deleteFiles === true;
  const ok = engine.cancelTask(req.params.id, deleteFiles);
  res.json({ success: ok });
});

/**
 * Open local folder in OS File Explorer
 */
app.post('/api/downloads/:id/open-folder', (req, res) => {
  const task = engine.getTaskDetails(req.params.id);
  const targetPath = task?.outputDir || downloadDir;

  if (fs.existsSync(targetPath)) {
    // spawn with array args (no shell interpolation) to avoid path injection
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(cmd, [targetPath], { detached: true, stdio: 'ignore' });
    child.unref();
    child.on('error', () => {
      // explorer.exe returns non-zero even on success; only surface spawn errors
    });
    res.json({ success: true, opened: targetPath });
  } else {
    res.status(404).json({ error: 'Folder does not exist yet on disk' });
  }
});

/**
 * Update queue priority of a task (0=high, 1=normal, 2=low)
 */
app.post('/api/downloads/:id/priority', (req, res) => {
  const ok = engine.setTaskPriority(req.params.id, req.body?.priority);
  if (!ok) {
    return res.status(400).json({ error: 'Invalid task id or priority (0=high, 1=normal, 2=low)' });
  }
  res.json({ success: true, priority: engine.getTaskDetails(req.params.id)?.priority });
});

/**
 * Usage statistics (today / all-time)
 */
app.get('/api/stats', (req, res) => {
  res.json(engine.getStats());
});

/**
 * Manually trigger archive extraction on a task
 */
app.post('/api/downloads/:id/extract', async (req, res) => {
  try {
    const result = await engine.extractTask(req.params.id);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Extraction failed' });
  }
});

/**
 * List cloud magnets on user's AllDebrid account
 */
app.get('/api/cloud-magnets', async (req, res) => {
  if (!apiKey) {
    return res.status(400).json({ error: 'API key is not configured' });
  }

  try {
    const data = await client.getMagnetStatus();
    res.json({
      magnets: data?.magnets || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Trigger download of an existing cloud magnet to local storage
 */
app.post('/api/cloud-magnets/:id/download', async (req, res) => {
  const magnetId = Number(req.params.id);
  const name = req.body?.name || '';
  try {
    const task = await engine.addMagnetTask(magnetId, name);
    res.json({ success: true, task });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Delete a cloud magnet from AllDebrid account
 */
app.post('/api/cloud-magnets/:id/delete', async (req, res) => {
  const magnetId = req.params.id;
  try {
    await client.deleteMagnet(magnetId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Restart an errored cloud magnet on AllDebrid account
 */
app.post('/api/cloud-magnets/:id/restart', async (req, res) => {
  const magnetId = req.params.id;
  try {
    await client.restartMagnet(magnetId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Bulk delete cloud magnets from AllDebrid account
 */
app.post('/api/cloud-magnets/delete-bulk', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }

  const deleted = [];
  const failed = [];
  for (const id of ids) {
    try {
      await client.deleteMagnet(id);
      deleted.push(id);
    } catch (err) {
      failed.push({ id, error: err.message });
    }
  }

  res.json({ success: failed.length === 0, deletedCount: deleted.length, deleted, failed });
});

/**
 * Multi-Indexer Torrent Search with AllDebrid Instant Cache enrichment
 */
app.get('/api/search', async (req, res) => {
  const query = req.query.q || '';
  const category = req.query.category || 'all';
  const onlyCached = req.query.onlyCached === 'true';

  if (!query.trim()) {
    return res.json({ results: [], total: 0, query: '', instantCount: 0 });
  }

  try {
    const searchRes = await searchAggregator(query, {
      category,
      onlyCached,
      alldebridClient: apiKey ? client : null,
      jackettUrl,
      jackettApiKey,
    });
    res.json(searchRes);
  } catch (err) {
    res.status(500).json({ error: err.message, results: [], total: 0 });
  }
});

/**
 * Standalone Batch Magnet & Hash Instant Cache Inspector
 */
app.post('/api/magnet/check-cache', async (req, res) => {
  if (!apiKey) {
    return res.status(400).json({ error: 'AllDebrid API Key is required for cache checking' });
  }

  const { magnets } = req.body;
  if (!magnets) {
    return res.status(400).json({ error: 'magnets input is required' });
  }

  let rawList = [];
  if (Array.isArray(magnets)) {
    rawList = magnets;
  } else if (typeof magnets === 'string') {
    rawList = magnets.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  const parsedHashesOrMagnets = rawList
    .map((item) => {
      const hash = extractHashFromMagnet(item);
      return hash || item.trim();
    })
    .filter(Boolean);

  if (parsedHashesOrMagnets.length === 0) {
    return res.json({ success: true, total: 0, results: [] });
  }

  try {
    const cacheResults = await client.checkInstantAvailability(parsedHashesOrMagnets);
    res.json({
      success: true,
      total: cacheResults.length,
      instantCount: cacheResults.filter((r) => r.ready).length,
      results: cacheResults,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get Settings
 */
app.get('/api/settings', (req, res) => {
  res.json({
    apiKey: apiKey ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : '',
    hasApiKey: !!apiKey,
    downloadDir,
    maxConcurrent,
    jackettUrl,
    jackettApiKey: jackettApiKey ? `${jackettApiKey.slice(0, 4)}...` : '',
    hasJackett: !!(jackettUrl && jackettApiKey),
    host: HOST,
    hasAuthToken: !!authToken,
    authTokenMasked: authToken ? `${authToken.slice(0, 3)}...${authToken.slice(-3)}` : '',
    speedLimitKbps,
    maxRetries: engine.maxRetries ?? 3,
    minFreeGb,
    scheduleEnabled,
    scheduleStart,
    scheduleEnd,
    scheduleLimitKbps,
  });
});

/**
 * Update Settings & write to .env
 */
app.post('/api/settings', async (req, res) => {
  const {
    newApiKey, newDownloadDir, newMaxConcurrent, newJackettUrl, newJackettApiKey,
    newAuthToken, newSpeedLimitKbps, newMaxRetries, newMinFreeGb,
    newScheduleEnabled, newScheduleStart, newScheduleEnd, newScheduleLimitKbps,
  } = req.body;

  if (newApiKey !== undefined && newApiKey.trim() !== '') {
    apiKey = newApiKey.trim();
    client.setApiKey(apiKey);
  }

  if (newDownloadDir && newDownloadDir.trim() !== '') {
    downloadDir = path.resolve(newDownloadDir.trim());
    engine.setDownloadDir(downloadDir);
  }

  if (newMaxConcurrent !== undefined && newMaxConcurrent !== '') {
    maxConcurrent = Math.max(1, parseInt(newMaxConcurrent, 10) || 3);
    engine.setMaxConcurrent(maxConcurrent);
  }

  if (newJackettUrl !== undefined) {
    jackettUrl = newJackettUrl.trim();
  }

  if (newJackettApiKey !== undefined && newJackettApiKey.trim() !== '') {
    jackettApiKey = newJackettApiKey.trim();
  }

  if (newAuthToken !== undefined) {
    authToken = String(newAuthToken).trim();
  }

  if (newSpeedLimitKbps !== undefined && newSpeedLimitKbps !== '') {
    speedLimitKbps = Math.max(0, parseInt(newSpeedLimitKbps, 10) || 0);
  }

  if (newMaxRetries !== undefined && newMaxRetries !== '') {
    engine.setMaxRetries(parseInt(newMaxRetries, 10) || 0);
  }

  if (newMinFreeGb !== undefined && newMinFreeGb !== '') {
    const parsed = parseFloat(newMinFreeGb);
    minFreeGb = Number.isNaN(parsed) ? 5 : Math.max(0, parsed);
  }

  if (newScheduleEnabled !== undefined) {
    scheduleEnabled = newScheduleEnabled === true || newScheduleEnabled === '1' || newScheduleEnabled === 'true';
  }
  if (newScheduleStart !== undefined) {
    scheduleStart = String(newScheduleStart).trim();
  }
  if (newScheduleEnd !== undefined) {
    scheduleEnd = String(newScheduleEnd).trim();
  }
  if (newScheduleLimitKbps !== undefined && newScheduleLimitKbps !== '') {
    scheduleLimitKbps = Math.max(0, parseInt(newScheduleLimitKbps, 10) || 0);
  }

  // Validate schedule window if enabled
  if (scheduleEnabled && (parseHmToMinutes(scheduleStart) === null || parseHmToMinutes(scheduleEnd) === null)) {
    return res.status(400).json({ error: 'Schedule window requires valid HH:MM start and end times' });
  }

  applyBandwidthPolicy();

  // Update .env file in CONFIG_DIR
  try {
    const envContent = `# AllDebrid API Key (Generate one from https://alldebrid.com/apikeys)
ALLDEBRID_API_KEY=${apiKey}

# Server Configuration
PORT=${PORT}
# Bind address (127.0.0.1 = local only; set 0.0.0.0 to expose on LAN, AUTH_TOKEN strongly recommended)
HOST=${HOST}

# Download Settings
DOWNLOAD_DIR=${downloadDir}
MAX_CONCURRENT_DOWNLOADS=${maxConcurrent}
SPEED_LIMIT_KBPS=${speedLimitKbps}
MAX_RETRIES=${engine.maxRetries ?? 3}
MIN_FREE_GB=${minFreeGb}

# Access Protection (when set, all API/WebSocket calls require this token)
AUTH_TOKEN=${authToken}

# Bandwidth Schedule (daily off-peak speed override)
SCHEDULE_ENABLED=${scheduleEnabled ? '1' : '0'}
SCHEDULE_START=${scheduleStart}
SCHEDULE_END=${scheduleEnd}
SCHEDULE_LIMIT_KBPS=${scheduleLimitKbps}

# Optional Jackett / Prowlarr Integration
JACKETT_URL=${jackettUrl}
JACKETT_API_KEY=${jackettApiKey}
`;
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(ENV_PATH, envContent, 'utf-8');
  } catch (err) {
    console.error('Failed to write .env:', err);
  }

  res.json({
    success: true,
    settings: {
      hasApiKey: !!apiKey,
      downloadDir,
      maxConcurrent,
      jackettUrl,
      hasJackett: !!(jackettUrl && jackettApiKey),
      host: HOST,
      hasAuthToken: !!authToken,
      authTokenMasked: authToken ? `${authToken.slice(0, 3)}...${authToken.slice(-3)}` : '',
      speedLimitKbps,
      maxRetries: engine.maxRetries ?? 3,
      minFreeGb,
      scheduleEnabled,
      scheduleStart,
      scheduleEnd,
      scheduleLimitKbps,
    },
  });
});

// Fallback index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'index.html'));
});

// Start Server function
export function startServer(customPort = null) {
  const portToUse = customPort || PORT;
  return new Promise((resolve, reject) => {
    server.listen(portToUse, HOST, () => {
      console.log(`=================================================`);
      console.log(`🚀 AllDebrid Downloader is running!`);
      console.log(`🌐 Web Interface: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${portToUse}`);
      console.log(`📁 Download Path : ${downloadDir}`);
      console.log(`🔑 API Key Status: ${apiKey ? 'Configured ✅' : 'Missing (Set in UI) ⚠️'}`);
      console.log(`🔒 Access Guard  : ${authToken ? 'Token Required 🔐' : 'Open (local only)'}`);
      if (HOST === '0.0.0.0' && !authToken) {
        console.warn('⚠️  WARNING: Server is exposed to the network without an AUTH_TOKEN!');
      }
      console.log(`=================================================`);
      resolve({ server, app, engine, wss, port: portToUse });
    });
    server.on('error', (err) => {
      reject(err);
    });
  });
}

// Auto-start if run directly from node CLI (e.g. node server/server.js)
const isDirectExecution = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('server.js')
);

if (isDirectExecution && !process.versions.electron) {
  startServer(PORT).catch((err) => {
    console.error('Failed to start server:', err);
  });
}

export { app, server, engine, wss, client, PORT };

