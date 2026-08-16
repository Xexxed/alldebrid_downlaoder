/**
 * AllDebrid Downloader Server
 * Express REST API + WebSocket live metrics stream
 */

// Configure larger threadpool for heavy concurrent file I/O operations
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '32';

import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import multer from 'multer';
import cors from 'cors';
import dotenv from 'dotenv';
import { exec } from 'child_process';

import { AllDebridClient, parseDownloadInput, flattenFileTree, sanitizePathSegment } from './alldebrid.js';
import { DownloadEngine } from './downloader.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Helper to detect drives on Windows
function getAvailableDrives() {
  if (process.platform === 'win32') {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const drives = [];
    for (const l of letters) {
      const driveRoot = `${l}:\\`;
      try {
        if (fs.existsSync(driveRoot)) {
          drives.push(driveRoot);
        }
      } catch {}
    }
    return drives.length > 0 ? drives : ['C:\\'];
  }
  return ['/'];
}

// Multer memory storage for .torrent uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// App State
let apiKey = process.env.ALLDEBRID_API_KEY || '';
let downloadDir = path.resolve(ROOT_DIR, process.env.DOWNLOAD_DIR || './downloads');
let maxConcurrent = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 3;

const client = new AllDebridClient(apiKey);
const engine = new DownloadEngine(client, {
  downloadDir,
  maxConcurrent,
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT_DIR, 'public')));

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

wss.on('connection', (ws) => {
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
    const drives = getAvailableDrives();
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
          const magnetId = fileData.id;
          let filesTree = null;
          let flattenedFiles = [];
          let totalSize = fileData.size || 0;
          let isReady = fileData.ready;

          // If ready, query files tree
          try {
            const filesRes = await client.getMagnetFiles(magnetId);
            const mData = filesRes?.magnets?.[0];
            if (mData?.files) {
              filesTree = mData.files;
              flattenedFiles = flattenFileTree(filesTree);
              totalSize = flattenedFiles.reduce((acc, f) => acc + f.size, 0);
              isReady = true;
            }
          } catch {}

          const name = sanitizePathSegment(fileData.name || file.originalname.replace(/\.torrent$/i, ''));
          previews.push({
            type: 'torrent',
            magnetId,
            name,
            totalSize,
            isReady,
            filesTree,
            flattenedFiles,
            defaultOutputDir: path.join(downloadDir, name),
          });
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
        if (item.type === 'getMagnet' || item.type === 'magnetId') {
          const magnetId = item.id;
          let name = `Torrent_${magnetId}`;
          let filesTree = null;
          let flattenedFiles = [];
          let totalSize = 0;
          let isReady = false;

          try {
            const [statusRes, filesRes] = await Promise.all([
              client.getMagnetStatus(magnetId).catch(() => null),
              client.getMagnetFiles(magnetId).catch(() => null),
            ]);

            const mStatus = statusRes?.magnets?.find((m) => m.id === magnetId) || statusRes?.magnets?.[0];
            if (mStatus?.filename) {
              name = sanitizePathSegment(mStatus.filename);
            }
            if (mStatus?.size) {
              totalSize = mStatus.size;
            }
            if (mStatus?.statusCode === 4) {
              isReady = true;
            }

            const mFiles = filesRes?.magnets?.[0];
            if (mFiles?.files) {
              filesTree = mFiles.files;
              flattenedFiles = flattenFileTree(filesTree);
              totalSize = flattenedFiles.reduce((acc, f) => acc + f.size, 0);
              isReady = true;
            }
          } catch (err) {
            console.error('Error fetching magnet preview:', err);
          }

          previews.push({
            type: 'torrent',
            magnetId,
            name,
            totalSize,
            isReady,
            filesTree,
            flattenedFiles,
            defaultOutputDir: path.join(downloadDir, name),
          });
        } else if (item.type === 'magnet') {
          const uploadRes = await client.uploadMagnet(item.uri);
          const uploaded = uploadRes?.magnets?.[0];

          if (uploaded?.error) {
            errors.push(`Magnet error: ${uploaded.error.message || uploaded.error.code}`);
            continue;
          }

          if (uploaded) {
            const magnetId = uploaded.id;
            let filesTree = null;
            let flattenedFiles = [];
            let totalSize = uploaded.size || 0;
            let isReady = uploaded.ready;

            if (uploaded.ready) {
              try {
                const filesRes = await client.getMagnetFiles(magnetId);
                const mFiles = filesRes?.magnets?.[0];
                if (mFiles?.files) {
                  filesTree = mFiles.files;
                  flattenedFiles = flattenFileTree(filesTree);
                  totalSize = flattenedFiles.reduce((acc, f) => acc + f.size, 0);
                }
              } catch {}
            }

            const name = sanitizePathSegment(uploaded.name || `Torrent_${magnetId}`);
            previews.push({
              type: 'torrent',
              magnetId,
              name,
              totalSize,
              isReady,
              filesTree,
              flattenedFiles,
              defaultOutputDir: path.join(downloadDir, name),
            });
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
            flattenedFiles: [
              {
                name: filename,
                relativePath: filename,
                size,
                link: item.url,
              },
            ],
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
        if (item.type === 'torrent' && item.magnetId) {
          const task = await engine.addMagnetTask(
            item.magnetId,
            item.name,
            item.filesTree,
            item.customOutputDir,
            item.selectedFiles
          );
          addedTasks.push(task);
        } else if (item.type === 'directLink' && item.url) {
          const task = await engine.addDirectLinkTask(
            item.url,
            item.name,
            item.customOutputDir
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
  const { input } = req.body;
  if (!input || typeof input !== 'string') {
    return res.status(400).json({ error: 'Input or items is required' });
  }

  const items = parseDownloadInput(input);
  if (items.length === 0) {
    return res.status(400).json({ error: 'No valid download links or magnet URIs detected' });
  }

  for (const item of items) {
    try {
      if (item.type === 'getMagnet' || item.type === 'magnetId') {
        const task = await engine.addMagnetTask(item.id);
        addedTasks.push(task);
      } else if (item.type === 'magnet') {
        const uploadRes = await client.uploadMagnet(item.uri);
        const uploaded = uploadRes?.magnets?.[0];

        if (uploaded) {
          if (uploaded.error) {
            errors.push(`Magnet upload error: ${uploaded.error.message || uploaded.error.code}`);
            continue;
          }

          const task = await engine.addMagnetTask(uploaded.id, uploaded.name);
          addedTasks.push(task);
        }
      } else if (item.type === 'directLink') {
        const task = await engine.addDirectLinkTask(item.url);
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
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const cmd = isWindows ? `explorer "${targetPath}"` : isMac ? `open "${targetPath}"` : `xdg-open "${targetPath}"`;

    exec(cmd, (err) => {
      if (err) {
        return res.status(500).json({ error: 'Could not open file manager' });
      }
      res.json({ success: true, opened: targetPath });
    });
  } else {
    res.status(404).json({ error: 'Folder does not exist yet on disk' });
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
  try {
    const task = await engine.addMagnetTask(magnetId);
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
 * Get Settings
 */
app.get('/api/settings', (req, res) => {
  res.json({
    apiKey: apiKey ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : '',
    hasApiKey: !!apiKey,
    downloadDir,
    maxConcurrent,
  });
});

/**
 * Update Settings & write to .env
 */
app.post('/api/settings', async (req, res) => {
  const { newApiKey, newDownloadDir, newMaxConcurrent } = req.body;

  if (newApiKey !== undefined && newApiKey.trim() !== '') {
    apiKey = newApiKey.trim();
    client.setApiKey(apiKey);
  }

  if (newDownloadDir && newDownloadDir.trim() !== '') {
    downloadDir = path.resolve(newDownloadDir.trim());
    engine.setDownloadDir(downloadDir);
  }

  if (newMaxConcurrent) {
    maxConcurrent = Math.max(1, parseInt(newMaxConcurrent, 10) || 3);
    engine.setMaxConcurrent(maxConcurrent);
  }

  // Update .env file
  try {
    const envContent = `# AllDebrid API Key (Generate one from https://alldebrid.com/apikeys)
ALLDEBRID_API_KEY=${apiKey}

# Server Configuration
PORT=${PORT}

# Download Settings
DOWNLOAD_DIR=${downloadDir}
MAX_CONCURRENT_DOWNLOADS=${maxConcurrent}
`;
    fs.writeFileSync(path.join(ROOT_DIR, '.env'), envContent, 'utf-8');
  } catch (err) {
    console.error('Failed to write .env:', err);
  }

  res.json({
    success: true,
    settings: {
      hasApiKey: !!apiKey,
      downloadDir,
      maxConcurrent,
    },
  });
});

// Fallback index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'index.html'));
});

// Start Server
server.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`🚀 AllDebrid Downloader is running!`);
  console.log(`🌐 Web Interface: http://localhost:${PORT}`);
  console.log(`📁 Download Path : ${downloadDir}`);
  console.log(`🔑 API Key Status: ${apiKey ? 'Configured ✅' : 'Missing (Set in UI) ⚠️'}`);
  console.log(`=================================================`);
});
