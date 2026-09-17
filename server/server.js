/**
 * AllDebrid Downloader Server
 * Express REST API + WebSocket live metrics stream
 */

import express from 'express';
import http from 'http';
import path from 'path';
import globalFilesystem from 'fs';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import multer from 'multer';
import { spawn as globalSpawn } from 'child_process';

import os from 'os';

import { AllDebridClient, parseDownloadInput, flattenFileTree, sanitizePathSegment, normalizeMagnetResponse, fetchRapidgatorFolder } from './alldebrid.js';
import { isArchiveFile } from './extractor.js';
import { DownloadEngine } from './downloader.js';
import { searchAggregator, extractHashFromMagnet } from './search.js';
import { Persistence } from './persistence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export function createApplication({
  config,
  client,
  persistence,
  filesystem: fs = globalFilesystem,
  clock = globalThis,
  processRunner: spawn = globalSpawn,
  engineFactory = (client, options) => new DownloadEngine(client, options),
} = {}) {
if (!config?.configDir || !config?.downloadDir || !client || persistence === undefined) {
  throw new TypeError('Explicit configDir, downloadDir, client and persistence are required');
}
const CONFIG_DIR = path.resolve(config.configDir);
const ENV_PATH = path.join(CONFIG_DIR, '.env');
const PORT = config.port ?? 3000;
const HOST = config.host ?? '127.0.0.1';
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
wss.on('error', () => {});
let startPromise;
let closePromise;
let closing = false;
const timers = new Set();
const engineListeners = [];
const sockets = new Set();
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});

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
let apiKey = config.apiKey ?? '';
let downloadDir = path.resolve(config.downloadDir);
let maxConcurrent = config.maxConcurrent ?? 3;
let jackettUrl = config.jackettUrl ?? '';
let jackettApiKey = config.jackettApiKey ?? '';
let authToken = config.authToken ?? '';
let speedLimitKbps = config.speedLimitKbps ?? 0;
let minFreeGb = config.minFreeGb ?? 5;
let scheduleEnabled = config.scheduleEnabled ?? false;
let scheduleStart = config.scheduleStart ?? '';
let scheduleEnd = config.scheduleEnd ?? '';
let scheduleLimitKbps = config.scheduleLimitKbps ?? 0;

const engine = engineFactory(client, {
  downloadDir,
  maxConcurrent,
  persistence,
  maxRetries: config.maxRetries ?? 3,
  autoStart: false,
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
  return '';
}

function extractQueryToken(req) {
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
  // Explicit header wins over any stored/query token so rotated credentials
  // can be validated even when a stale token is still stored client-side.
  const provided = extractRequestToken(req) || extractQueryToken(req);
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


// ==========================================
// Runtime disk-space guard
// ==========================================

const MIN_FREE_BYTES = () => minFreeGb * 1024 ** 3;
let diskGuardTripped = false;

function checkDiskSpace() {
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
}

function onEngine(event, listener) {
  engine.on(event, listener);
  engineListeners.push([event, listener]);
}

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
onEngine('progress', () => {
  broadcast({
    type: 'progress_tick',
    tasks: engine.getAllTasks(),
    globalSpeed: engine.totalSpeed || 0,
  });
});

onEngine('taskAdded', (task) => {
  broadcast({ type: 'task_added', task });
});

onEngine('taskUpdated', (task) => {
  broadcast({ type: 'task_updated', task });
});

onEngine('taskCompleted', (task) => {
  broadcast({ type: 'task_completed', task });
});

onEngine('taskDeleted', (taskId) => {
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
/**
 * In-memory DownloadPlan registry (Stage C): preview resolves a validated plan
 * with an expiring ID; dispatch reloads and revalidates the same plan instead
 * of trusting client-supplied paths/metadata.
 */
const PLAN_TTL_MS = 10 * 60 * 1000;
const downloadPlans = new Map();

function createPlanSnapshot(preview, options = {}) {
  const planId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  const plan = {
    id: planId,
    createdAt: now,
    expiresAt: now + PLAN_TTL_MS,
    type: preview.type,
    name: preview.name,
    url: preview.url ?? null,
    magnetId: preview.magnetId ?? null,
    filesTree: preview.filesTree ?? null,
    flattenedFiles: preview.flattenedFiles ?? null,
    totalSize: preview.totalSize ?? 0,
    hasArchives: preview.hasArchives ?? false,
    defaultOutputDir: preview.defaultOutputDir,
    customOutputDir: options.customOutputDir ?? null,
    selectedFiles: options.selectedFiles ?? null,
    autoExtract: !!options.autoExtract,
    deleteArchiveAfterExtract: !!options.deleteArchiveAfterExtract,
  };
  downloadPlans.set(planId, plan);
  return plan;
}

function loadPlanForDispatch(planId) {
  const plan = typeof planId === 'string' ? downloadPlans.get(planId) : undefined;
  if (!plan) throw Object.assign(new Error('Download plan not found or expired; request a new preview'), { status: 410 });
  if (Date.now() > plan.expiresAt) {
    downloadPlans.delete(planId);
    throw Object.assign(new Error('Download plan expired; request a new preview'), { status: 410 });
  }
  downloadPlans.delete(planId); // single-use dispatch
  return plan;
}

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

  // Annotate all preview files with on-disk state and attach durable plans
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
            if (f.size > 0 && stat.size === f.size) {
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

  res.json({
    previews: previews.map((p) => ({ ...p, planId: createPlanSnapshot(p).id })),
    errors,
  });
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
        let plan = null;
        if (item.planId) {
          plan = loadPlanForDispatch(item.planId);
        } else {
          // Legacy client without plan support: accept but re-derive from item
          plan = {
            type: item.type,
            name: item.name,
            url: item.url ?? null,
            magnetId: item.magnetId ?? null,
            filesTree: item.filesTree ?? null,
            customOutputDir: item.customOutputDir ?? null,
            selectedFiles: item.selectedFiles ?? null,
            autoExtract: !!item.autoExtract,
            deleteArchiveAfterExtract: !!item.deleteArchiveAfterExtract,
          };
        }
        const options = {
          autoExtract: plan.autoExtract,
          deleteArchiveAfterExtract: plan.deleteArchiveAfterExtract,
        };

        if (plan.type === 'folder' && Array.isArray(plan.flattenedFiles || item.files)) {
          const task = await engine.addFolderTask(
            plan.name ?? item.name,
            plan.flattenedFiles || item.files,
            plan.customOutputDir ?? item.customOutputDir,
            plan.selectedFiles ?? item.selectedFiles,
            options
          );
          addedTasks.push(task);
        } else if (plan.type === 'torrent' && (plan.magnetId ?? item.magnetId)) {
          const task = await engine.addMagnetTask(
            plan.magnetId ?? item.magnetId,
            plan.name ?? item.name,
            plan.filesTree ?? item.filesTree,
            plan.customOutputDir ?? item.customOutputDir,
            plan.selectedFiles ?? item.selectedFiles,
            options
          );
          addedTasks.push(task);
        } else if (plan.type === 'directLink' && (plan.url ?? item.url)) {
          const task = await engine.addDirectLinkTask(
            plan.url ?? item.url,
            plan.name ?? item.name,
            plan.customOutputDir ?? item.customOutputDir,
            options
          );
          addedTasks.push(task);
        } else {
          throw Object.assign(new Error('Unsupported plan type for dispatch'), { status: 400 });
        }
      } catch (err) {
        errors.push(`Error adding ${item.name || item.magnetId}: ${err.message}`);
      }
    }

    return res.json({
      success: addedTasks.length > 0,
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
 * Cancel and remove download task (metadata-only; files are preserved)
 */
app.post('/api/downloads/:id/cancel', (req, res) => {
  const ok = engine.cancelTask(req.params.id);
  res.json({ success: ok, filesPreserved: true });
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
 * Update Settings — transactional: validate the complete candidate, write the
 * .env snapshot atomically first, and only then activate live values. A failed
 * write leaves runtime and persisted settings unchanged.
 */
app.post('/api/settings', async (req, res) => {
  const {
    newApiKey, newDownloadDir, newMaxConcurrent, newJackettUrl, newJackettApiKey,
    newAuthToken, newSpeedLimitKbps, newMaxRetries, newMinFreeGb,
    newScheduleEnabled, newScheduleStart, newScheduleEnd, newScheduleLimitKbps,
  } = req.body;

  // Build the complete candidate from current live values.
  const candidate = {
    apiKey,
    downloadDir,
    maxConcurrent,
    jackettUrl,
    jackettApiKey,
    authToken,
    speedLimitKbps,
    maxRetries: engine.maxRetries ?? 3,
    minFreeGb,
    scheduleEnabled,
    scheduleStart,
    scheduleEnd,
    scheduleLimitKbps,
  };

  try {
    if (newApiKey !== undefined) {
      if (typeof newApiKey !== 'string') throw Object.assign(new Error('API key must be a string'), { status: 400 });
      if (newApiKey.trim() !== '') candidate.apiKey = newApiKey.trim();
    }
    if (newDownloadDir !== undefined) {
      if (typeof newDownloadDir !== 'string' || newDownloadDir.trim() === '') throw Object.assign(new Error('Download directory must be a non-empty string'), { status: 400 });
      candidate.downloadDir = path.resolve(newDownloadDir.trim());
    }
    if (newMaxConcurrent !== undefined && newMaxConcurrent !== '') {
      const parsed = parseInt(newMaxConcurrent, 10);
      if (!Number.isInteger(parsed) || String(parsed) !== String(newMaxConcurrent).trim() || parsed < 1 || parsed > 10) {
        throw Object.assign(new Error('Max concurrent downloads must be an integer between 1 and 10'), { status: 400 });
      }
      candidate.maxConcurrent = parsed;
    }
    if (newJackettUrl !== undefined) {
      if (typeof newJackettUrl !== 'string') throw Object.assign(new Error('Jackett URL must be a string'), { status: 400 });
      candidate.jackettUrl = newJackettUrl.trim();
    }
    if (newJackettApiKey !== undefined) {
      if (typeof newJackettApiKey !== 'string') throw Object.assign(new Error('Jackett API key must be a string'), { status: 400 });
      if (newJackettApiKey.trim() !== '') candidate.jackettApiKey = newJackettApiKey.trim();
    }
    if (newAuthToken !== undefined) {
      if (typeof newAuthToken !== 'string') throw Object.assign(new Error('Auth token must be a string'), { status: 400 });
      candidate.authToken = String(newAuthToken).trim();
    }
    if (newSpeedLimitKbps !== undefined && newSpeedLimitKbps !== '') {
      const parsed = parseInt(newSpeedLimitKbps, 10);
      if (!Number.isInteger(parsed) || String(parsed) !== String(newSpeedLimitKbps).trim() || parsed < 0 || parsed > 100_000_000) {
        throw Object.assign(new Error('Speed limit must be a non-negative integer (KB/s)'), { status: 400 });
      }
      candidate.speedLimitKbps = parsed;
    }
    if (newMaxRetries !== undefined && newMaxRetries !== '') {
      const parsed = parseInt(newMaxRetries, 10);
      if (!Number.isInteger(parsed) || String(parsed) !== String(newMaxRetries).trim() || parsed < 0 || parsed > 10) {
        throw Object.assign(new Error('Max retries must be an integer between 0 and 10'), { status: 400 });
      }
      candidate.maxRetries = parsed;
    }
    if (newMinFreeGb !== undefined && newMinFreeGb !== '') {
      const parsed = parseFloat(newMinFreeGb);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1024 * 1024) {
        throw Object.assign(new Error('Minimum free space must be a finite non-negative number of GB'), { status: 400 });
      }
      candidate.minFreeGb = parsed;
    }
    if (newScheduleEnabled !== undefined) {
      candidate.scheduleEnabled = newScheduleEnabled === true || newScheduleEnabled === '1' || newScheduleEnabled === 'true';
    }
    if (newScheduleStart !== undefined) {
      if (typeof newScheduleStart !== 'string') throw Object.assign(new Error('Schedule start must be a string'), { status: 400 });
      candidate.scheduleStart = newScheduleStart.trim();
    }
    if (newScheduleEnd !== undefined) {
      if (typeof newScheduleEnd !== 'string') throw Object.assign(new Error('Schedule end must be a string'), { status: 400 });
      candidate.scheduleEnd = newScheduleEnd.trim();
    }
    if (newScheduleLimitKbps !== undefined && newScheduleLimitKbps !== '') {
      const parsed = parseInt(newScheduleLimitKbps, 10);
      if (!Number.isInteger(parsed) || String(parsed) !== String(newScheduleLimitKbps).trim() || parsed < 0 || parsed > 100_000_000) {
        throw Object.assign(new Error('Schedule speed limit must be a non-negative integer (KB/s)'), { status: 400 });
      }
      candidate.scheduleLimitKbps = parsed;
    }
    if (candidate.scheduleEnabled && (parseHmToMinutes(candidate.scheduleStart) === null || parseHmToMinutes(candidate.scheduleEnd) === null)) {
      throw Object.assign(new Error('Schedule window requires valid HH:MM start and end times'), { status: 400 });
    }
  } catch (error) {
    return res.status(error.status ?? 400).json({ error: error.message });
  }

  // Candidate validated: persist the snapshot atomically BEFORE activating it.
  const envContent = `# AllDebrid API Key (Generate one from https://alldebrid.com/apikeys)
ALLDEBRID_API_KEY=${candidate.apiKey}

# Server Configuration
PORT=${PORT}
# Bind address (127.0.0.1 = local only; set 0.0.0.0 to expose on LAN, AUTH_TOKEN strongly recommended)
HOST=${HOST}

# Download Settings
DOWNLOAD_DIR=${candidate.downloadDir}
MAX_CONCURRENT_DOWNLOADS=${candidate.maxConcurrent}
SPEED_LIMIT_KBPS=${candidate.speedLimitKbps}
MAX_RETRIES=${candidate.maxRetries}
MIN_FREE_GB=${candidate.minFreeGb}

# Access Protection (when set, all API/WebSocket calls require this token)
AUTH_TOKEN=${candidate.authToken}

# Bandwidth Schedule (daily off-peak speed override)
SCHEDULE_ENABLED=${candidate.scheduleEnabled ? '1' : '0'}
SCHEDULE_START=${candidate.scheduleStart}
SCHEDULE_END=${candidate.scheduleEnd}
SCHEDULE_LIMIT_KBPS=${candidate.scheduleLimitKbps}

# Optional Jackett / Prowlarr Integration
JACKETT_URL=${candidate.jackettUrl}
JACKETT_API_KEY=${candidate.jackettApiKey}
`;
  const tmpPath = `${ENV_PATH}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(tmpPath, envContent, 'utf-8');
    fs.renameSync(tmpPath, ENV_PATH);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    console.error('Failed to write .env:', err.message);
    return res.status(500).json({ error: 'Settings were not saved: persisting configuration failed. Live values are unchanged.' });
  }

  // Persisted: now activate live values.
  const previousAuthToken = authToken;
  apiKey = candidate.apiKey;
  downloadDir = candidate.downloadDir;
  maxConcurrent = candidate.maxConcurrent;
  jackettUrl = candidate.jackettUrl;
  jackettApiKey = candidate.jackettApiKey;
  authToken = candidate.authToken;
  speedLimitKbps = candidate.speedLimitKbps;
  minFreeGb = candidate.minFreeGb;
  scheduleEnabled = candidate.scheduleEnabled;
  scheduleStart = candidate.scheduleStart;
  scheduleEnd = candidate.scheduleEnd;
  scheduleLimitKbps = candidate.scheduleLimitKbps;

  engine.setDownloadDir(downloadDir);
  engine.setMaxConcurrent(maxConcurrent);
  engine.setMaxRetries(candidate.maxRetries);
  if (apiKey !== undefined) client.setApiKey(apiKey);
  applyBandwidthPolicy();
  if (previousAuthToken !== authToken) {
    for (const wsClient of wss.clients) wsClient.terminate();
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

let teardownPromise;
function teardown() {
  if (teardownPromise) return teardownPromise;
  closing = true;
  for (const timer of timers) clock.clearInterval(timer);
  timers.clear();
  teardownPromise = (async () => {
    const stopped = Promise.resolve().then(() => engine.stop());
    const websocketClosed = new Promise((resolve) => {
      wss.close(() => resolve());
      for (const ws of wss.clients) ws.terminate();
    });
    const httpClosed = new Promise((resolve, reject) => {
      server.close((error) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
      for (const socket of sockets) socket.destroy();
    });
    const results = await Promise.allSettled([stopped, websocketClosed, httpClosed]);
    try { await persistence?.close?.(); } catch (reason) { results.push({ status: 'rejected', reason }); }
    for (const [event, listener] of engineListeners) engine.off(event, listener);
    engineListeners.length = 0;
    wss.removeAllListeners();
    server.removeAllListeners();
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  })();
  return teardownPromise;
}

function start(customPort = PORT) {
  if (closing) return Promise.reject(new Error('Application is closed'));
  if (startPromise) return startPromise;
  startPromise = (async () => {
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(customPort ?? PORT, HOST);
      });
      if (closing) throw new Error('Application closed during startup');
      applyBandwidthPolicy();
      await engine.start();
      if (closing) throw new Error('Application closed during startup');
      for (const callback of [applyBandwidthPolicy, checkDiskSpace]) {
        const timer = clock.setInterval(callback, 60_000);
        timers.add(timer);
        timer.unref?.();
      }
      return application;
    } catch (error) {
      try { await teardown(); } catch (cleanupError) { error.cleanupError = cleanupError; }
      throw error;
    }
  })();
  return startPromise;
}

function close() {
  if (closePromise) return closePromise;
  closing = true;
  closePromise = (async () => {
    if (startPromise) await startPromise.catch(() => {});
    await teardown();
  })();
  return closePromise;
}

const application = {
  app, server, engine, wss, client, persistence, start, close,
  get port() { return server.address()?.port ?? null; },
};
return application;
}

export async function loadConfiguration({ environment = process.env, filesystem = globalFilesystem } = {}) {
  const launch = { ...environment };
  if (launch.APP_DATA_DIR !== undefined && !launch.APP_DATA_DIR) {
    throw new TypeError('APP_DATA_DIR must not be empty');
  }
  const configDir = path.resolve(launch.APP_DATA_DIR ?? ROOT_DIR);
  const envPath = path.join(configDir, '.env');
  let persisted = {};
  if (filesystem.existsSync(envPath)) {
    const { parse } = await import('dotenv');
    persisted = parse(filesystem.readFileSync(envPath, 'utf-8'));
  }
  const env = { ...persisted, ...launch };
  const integer = (value, fallback) => value === undefined || value === '' ? fallback : parseInt(value, 10);
  const decimal = (value, fallback) => value === undefined || value === '' ? fallback : parseFloat(value);
  return {
    configDir,
    statePath: env.STATE_PATH || path.join(configDir, 'state.json'),
    downloadDir: env.DOWNLOAD_DIR || (process.versions.electron
      ? path.join(os.homedir(), 'Downloads', 'AllDebrid')
      : path.join(ROOT_DIR, 'downloads')),
    port: integer(env.PORT, 3000),
    host: env.HOST || '127.0.0.1',
    apiKey: env.ALLDEBRID_API_KEY || '',
    maxConcurrent: integer(env.MAX_CONCURRENT_DOWNLOADS, 3),
    maxRetries: integer(env.MAX_RETRIES, 3),
    speedLimitKbps: integer(env.SPEED_LIMIT_KBPS, 0),
    minFreeGb: decimal(env.MIN_FREE_GB, 5),
    jackettUrl: env.JACKETT_URL || '',
    jackettApiKey: env.JACKETT_API_KEY || '',
    authToken: env.AUTH_TOKEN || '',
    scheduleEnabled: env.SCHEDULE_ENABLED === '1',
    scheduleStart: env.SCHEDULE_START || '',
    scheduleEnd: env.SCHEDULE_END || '',
    scheduleLimitKbps: integer(env.SCHEDULE_LIMIT_KBPS, 0),
  };
}

export async function startServer(customPort = null, options = {}) {
  const config = options.config ?? await loadConfiguration(options);
  const client = options.client ?? new AllDebridClient(config.apiKey);
  const persistence = options.persistence === undefined
    ? new Persistence(config.statePath ?? path.join(config.configDir, 'state.json'))
    : options.persistence;
  let application;
  try {
    application = createApplication({ ...options, config, client, persistence });
    return await application.start(customPort ?? config.port);
  } catch (error) {
    if (!application && options.persistence === undefined) {
      try { await persistence?.close?.(); } catch (cleanupError) { error.cleanupError = cleanupError; }
    }
    throw error;
  }
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectExecution && !process.versions.electron) {
  startServer().then((application) => {
    console.log(`AllDebrid Downloader listening on port ${application.port}`);
    const shutdown = async () => {
      try { await application.close(); } catch (error) {
        console.error('Failed to close server:', error.message);
        process.exitCode = 1;
      } finally {
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
      }
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch((error) => {
    console.error('Failed to start server:', error.message);
    process.exitCode = 1;
  });
}

