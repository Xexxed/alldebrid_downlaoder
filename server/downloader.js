/**
 * High-Performance Download Manager with Recursive Folder Preservation & Resume Support
 */

import fs from 'fs';
import path from 'path';
import EventEmitter from 'events';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { flattenFileTree, sanitizePathSegment, normalizeMagnetResponse } from './alldebrid.js';
import { extractTaskArchives, isArchiveFile } from './extractor.js';

/**
 * Shared token-bucket bandwidth limiter.
 * limit = bytes per second, 0 = unlimited. FIFO-fair across all streams.
 */
class SpeedLimiter {
  constructor() {
    this.limit = 0;
    this.tokens = 0;
    this.waiters = [];
    this._timer = setInterval(() => this._refill(), 100);
    if (this._timer.unref) this._timer.unref();
  }

  setLimit(bytesPerSec) {
    const next = Math.max(0, Number(bytesPerSec) || 0);
    if (next === this.limit) return;
    this.limit = next;
    if (next === 0) this.tokens = 0;
    this._wake();
  }

  _refill() {
    if (this.limit <= 0) return;
    this.tokens = Math.min(this.limit, this.tokens + this.limit * 0.1);
    this._wake();
  }

  _wake() {
    if (this.limit <= 0) {
      this.waiters.splice(0).forEach((w) => w.resolve());
      return;
    }
    while (this.waiters.length > 0 && this.tokens >= this.waiters[0].bytes) {
      const w = this.waiters.shift();
      this.tokens -= w.bytes;
      w.resolve();
    }
  }

  consume(bytes) {
    if (this.limit <= 0) return Promise.resolve();
    if (bytes > this.limit) bytes = this.limit;
    return new Promise((resolve) => {
      if (this.waiters.length === 0 && this.tokens >= bytes) {
        this.tokens -= bytes;
        resolve();
      } else {
        this.waiters.push({ bytes, resolve });
      }
    });
  }

  destroy() {
    clearInterval(this._timer);
    this.waiters.splice(0).forEach((w) => w.resolve());
  }
}

function localDayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export class DownloadEngine extends EventEmitter {
  constructor(alldebridClient, options = {}) {
    super();
    this.client = alldebridClient;
    this.downloadDir = path.resolve(options.downloadDir || './downloads');
    this.maxConcurrent = options.maxConcurrent || 3;
    this.maxRetries = Math.max(0, Number(options.maxRetries ?? 3) || 0);
    this.retryBackoffMs = Array.isArray(options.retryBackoffMs) && options.retryBackoffMs.length > 0
      ? options.retryBackoffMs
      : [30_000, 120_000, 600_000];
    this.persistence = options.persistence || null;
    this.tasks = new Map(); // taskId -> Task
    this.activeFileStreams = new Map(); // fileId -> { abortController, writeStream }
    this.speedLimiter = new SpeedLimiter();
    this.pollInterval = null;
    this.speedTrackerInterval = null;
    this.persistSweepInterval = null;
    this.stats = { totalBytes: 0, activeSeconds: 0, peakSpeed: 0, perDay: {} };

    this.ensureDownloadDir();
    this.restoreFromPersistence();
    this.startBackgroundLoops();
  }

  ensureDownloadDir() {
    try {
      if (!fs.existsSync(this.downloadDir)) {
        fs.mkdirSync(this.downloadDir, { recursive: true });
      }
    } catch (err) {
      console.warn(`[Engine] Cannot create download dir "${this.downloadDir}": ${err.message}. Downloads to it will fail until available.`);
    }
  }

  setDownloadDir(newDir) {
    this.downloadDir = path.resolve(newDir);
    this.ensureDownloadDir();
  }

  setMaxConcurrent(num) {
    this.maxConcurrent = Math.max(1, parseInt(num, 10) || 3);
    this.processQueue();
  }

  setSpeedLimit(bytesPerSec) {
    this.speedLimiter.setLimit(bytesPerSec);
  }

  setMaxRetries(num) {
    this.maxRetries = Math.max(0, Number(num) || 0);
  }

  startBackgroundLoops() {
    // Speed and ETA recalculator loop (every 1 second)
    this.speedTrackerInterval = setInterval(() => {
      this.recalculateSpeeds();
      this.emit('progress');
    }, 1000);
    if (this.speedTrackerInterval.unref) this.speedTrackerInterval.unref();

    // Cloud magnet status poller loop (every 3 seconds)
    this.pollInterval = setInterval(() => {
      this.pollCloudMagnets();
    }, 3000);
    if (this.pollInterval.unref) this.pollInterval.unref();

    // Persistence sweep: capture stats + any missed task mutations (every 30 seconds)
    this.persistSweepInterval = setInterval(() => {
      this._persist();
    }, 30_000);
    if (this.persistSweepInterval.unref) this.persistSweepInterval.unref();
  }

  // ==========================================
  // Persistence
  // ==========================================

  _persist() {
    if (!this.persistence) return;
    try {
      this.persistence.data.tasks = Array.from(this.tasks.values()).map((t) => this.serializeTask(t));
      this.persistence.data.stats = { ...this.stats, perDay: { ...this.stats.perDay } };
      this.persistence.scheduleFlush();
    } catch (err) {
      console.error('[Engine] Persist failed:', err.message);
    }
  }

  flushPersistenceSync() {
    if (!this.persistence) return;
    this._persist();
    this.persistence.flushSync();
  }

  serializeTask(task) {
    let status = task.status;
    if (status === 'downloading' || status === 'extracting' || status === 'initializing') {
      status = task.magnetId && task.files.length === 0 ? 'waiting_cloud' : 'ready_to_download';
    }
    return {
      id: task.id,
      magnetId: task.magnetId,
      name: task.name,
      type: task.type,
      status,
      cloudStatus: task.cloudStatus,
      cloudProgress: task.cloudProgress,
      totalSize: task.totalSize,
      downloadedSize: task.downloadedSize,
      progress: task.progress,
      error: task.error,
      outputDir: task.outputDir,
      baseOutputDir: task.baseOutputDir,
      selectedPaths: task.selectedPaths ? Array.from(task.selectedPaths) : null,
      autoExtract: !!task.autoExtract,
      deleteArchiveAfterExtract: !!task.deleteArchiveAfterExtract,
      extractionStatus: task.extractionStatus,
      extractionError: task.extractionError,
      extractionMessage: task.extractionMessage,
      extracted: !!task.extracted,
      addedAt: task.addedAt,
      completedAt: task.completedAt,
      priority: task.priority ?? 1,
      files: (task.files || []).map((f) => ({
        id: f.id,
        taskId: f.taskId,
        name: f.name,
        relativePath: f.relativePath,
        fullLocalPath: f.fullLocalPath,
        size: f.size,
        downloaded: f.downloaded,
        link: f.link || null,
        status: f.status === 'completed' ? 'completed' : 'pending',
        error: f.error,
        progress: f.progress,
        retryCount: f.retryCount || 0,
      })),
    };
  }

  restoreFromPersistence() {
    if (!this.persistence) return;
    const savedTasks = this.persistence.data.tasks || [];
    for (const s of savedTasks) {
      try {
        const task = {
          ...s,
          selectedPaths: Array.isArray(s.selectedPaths) ? new Set(s.selectedPaths) : null,
          isExtracting: false,
          speed: 0,
          eta: 0,
          priority: s.priority ?? 1,
          // Direct URLs expire server-side; force re-unlock on resume
          files: (s.files || []).map((f) => ({
            ...f,
            directUrl: null,
            speed: 0,
            bytesSample: 0,
            retryAt: null,
            retryCount: f.retryCount || 0,
          })),
        };

        if (task.status !== 'completed') {
          // Keep waiting_cloud so the background poller re-syncs magnet state;
          // everything else resumes locally from disk.
          if (task.status !== 'waiting_cloud') {
            task.status = 'ready_to_download';
          }
          for (const f of task.files) {
            if (f.status !== 'completed') {
              f.status = 'pending';
              f.error = null;
            }
          }
        }

        this.tasks.set(task.id, task);
      } catch (err) {
        console.error(`[Engine] Failed to restore task ${s?.id}:`, err.message);
      }
    }

    if (this.tasks.size > 0) {
      // Re-scan disk so partial/complete files are detected before queueing
      for (const task of this.tasks.values()) {
        for (const f of task.files) this.checkExistingFileSize(f);
        this.updateTaskProgress(task);
      }
      console.log(`[Engine] Restored ${this.tasks.size} task(s) from previous session.`);
    }

    const savedStats = this.persistence.data.stats;
    if (savedStats) {
      this.stats = {
        totalBytes: savedStats.totalBytes || 0,
        activeSeconds: savedStats.activeSeconds || 0,
        peakSpeed: savedStats.peakSpeed || 0,
        perDay: { ...(savedStats.perDay || {}) },
      };
    }
  }

  getStats() {
    const dayKey = localDayKey();
    return {
      totalBytes: this.stats.totalBytes,
      activeSeconds: this.stats.activeSeconds,
      peakSpeed: this.stats.peakSpeed,
      todayBytes: this.stats.perDay[dayKey] || 0,
      dayKey,
    };
  }

  /**
   * Add a new torrent / magnet task
   */
  async addMagnetTask(magnetId, name = '', initialFilesTree = null, customOutputDir = null, selectedRelativePaths = null, options = {}) {
    const taskId = `magnet_${magnetId}_${Date.now()}`;
    const cleanName = sanitizePathSegment(name) || `Torrent_${magnetId}`;
    
    let baseDir = customOutputDir ? path.resolve(customOutputDir) : this.downloadDir;
    let targetFolder;

    // Check if the destination path already ends with the torrent name
    if (path.basename(baseDir).toLowerCase() === cleanName.toLowerCase()) {
      targetFolder = baseDir;
      baseDir = path.dirname(baseDir);
    } else {
      targetFolder = path.join(baseDir, cleanName);
    }

    const task = {
      id: taskId,
      magnetId: Number(magnetId),
      name: cleanName,
      type: 'torrent',
      status: 'initializing',
      cloudStatus: null,
      cloudProgress: 0,
      totalSize: 0,
      downloadedSize: 0,
      progress: 0,
      speed: 0,
      eta: 0,
      error: null,
      outputDir: targetFolder,
      baseOutputDir: baseDir,
      selectedPaths: selectedRelativePaths ? new Set(selectedRelativePaths) : null,
      autoExtract: !!options.autoExtract,
      deleteArchiveAfterExtract: !!options.deleteArchiveAfterExtract,
      extractionStatus: null,
      extractionError: null,
      extractionMessage: null,
      extracted: false,
      isExtracting: false,
      addedAt: new Date().toISOString(),
      completedAt: null,
      priority: Number.isInteger(options.priority) ? Math.min(2, Math.max(0, options.priority)) : 1,
      files: [],
    };

    this.tasks.set(taskId, task);
    this.emit('taskAdded', task);
    this._persist();

    // If files tree is provided, setup files right away
    if (initialFilesTree && initialFilesTree.length > 0) {
      this.setupTaskFiles(task, initialFilesTree);
    } else {
      // Check magnet status / fetch files
      await this.syncMagnetState(task);
    }

    this.processQueue();
    return task;
  }

  /**
   * Add a multi-file folder download task (e.g. Rapidgator folder)
   */
  async addFolderTask(folderName, files, customOutputDir = null, selectedRelativePaths = null, options = {}) {
    const taskId = `folder_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const cleanName = sanitizePathSegment(folderName) || `Folder_${Date.now()}`;
    
    let baseDir = customOutputDir ? path.resolve(customOutputDir) : this.downloadDir;
    let targetFolder;

    if (path.basename(baseDir).toLowerCase() === cleanName.toLowerCase()) {
      targetFolder = baseDir;
      baseDir = path.dirname(baseDir);
    } else {
      targetFolder = path.join(baseDir, cleanName);
    }

    const task = {
      id: taskId,
      magnetId: null,
      name: cleanName,
      type: 'folder',
      status: 'ready_to_download',
      cloudStatus: null,
      cloudProgress: 100,
      totalSize: 0,
      downloadedSize: 0,
      progress: 0,
      speed: 0,
      eta: 0,
      error: null,
      outputDir: targetFolder,
      baseOutputDir: baseDir,
      selectedPaths: selectedRelativePaths ? new Set(selectedRelativePaths) : null,
      autoExtract: !!options.autoExtract,
      deleteArchiveAfterExtract: !!options.deleteArchiveAfterExtract,
      extractionStatus: null,
      extractionError: null,
      extractionMessage: null,
      extracted: false,
      isExtracting: false,
      addedAt: new Date().toISOString(),
      completedAt: null,
      priority: Number.isInteger(options.priority) ? Math.min(2, Math.max(0, options.priority)) : 1,
      files: [],
    };

    const selectedSet = selectedRelativePaths ? new Set(selectedRelativePaths) : null;
    const filteredFiles = selectedSet
      ? files.filter((f) => selectedSet.has(f.relativePath || f.name))
      : files;

    if (filteredFiles.length === 0) {
      this.tasks.set(taskId, task);
      this.emit('taskAdded', task);
      this.markTaskError(task, 'No files selected for folder download');
      return task;
    }

    let totalBytes = 0;
    const fileObjects = filteredFiles.map((item, idx) => {
      const relPath = item.relativePath || item.name;
      const relativeNorm = relPath.split('/').join(path.sep);
      const fullLocalPath = path.join(targetFolder, relativeNorm);
      const size = Number(item.size) || 0;
      totalBytes += size;

      const fObj = {
        id: `${taskId}_f${idx}`,
        taskId,
        name: item.name || path.basename(relPath),
        relativePath: relPath,
        fullLocalPath,
        size,
        downloaded: 0,
        link: item.link || item.url,
        directUrl: item.directUrl || null,
        status: 'pending',
        error: null,
        speed: 0,
        bytesSample: 0,
        progress: 0,
        retryCount: 0,
        retryAt: null,
      };

      this.checkExistingFileSize(fObj);
      return fObj;
    });

    task.files = fileObjects;
    task.totalSize = totalBytes;

    this.tasks.set(taskId, task);
    this.emit('taskAdded', task);
    this._persist();
    this.updateTaskProgress(task);
    this.processQueue();
    return task;
  }

  /**
   * Add direct file download task (or link list)
   */
  async addDirectLinkTask(url, customName = '', customOutputDir = null, options = {}) {
    const taskId = `link_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const baseDir = customOutputDir ? path.resolve(customOutputDir) : this.downloadDir;
    const task = {
      id: taskId,
      magnetId: null,
      name: customName || 'Direct Download',
      type: 'directLink',
      status: 'initializing',
      cloudStatus: null,
      cloudProgress: 100,
      totalSize: 0,
      downloadedSize: 0,
      progress: 0,
      speed: 0,
      eta: 0,
      error: null,
      outputDir: baseDir,
      baseOutputDir: baseDir,
      autoExtract: !!options.autoExtract,
      deleteArchiveAfterExtract: !!options.deleteArchiveAfterExtract,
      extractionStatus: null,
      extractionError: null,
      extractionMessage: null,
      extracted: false,
      isExtracting: false,
      addedAt: new Date().toISOString(),
      completedAt: null,
      priority: Number.isInteger(options.priority) ? Math.min(2, Math.max(0, options.priority)) : 1,
      files: [],
    };

    this.tasks.set(taskId, task);
    this.emit('taskAdded', task);
    this._persist();

    try {
      // Unlock link to get metadata
      const unlockData = await this.client.unlockLink(url);
      const filename = sanitizePathSegment(unlockData.filename || customName || 'download.file');
      task.name = filename;
      const fullPath = path.join(baseDir, filename);

      const fileObj = {
        id: `${taskId}_f0`,
        taskId,
        name: filename,
        relativePath: filename,
        fullLocalPath: fullPath,
        size: Number(unlockData.filesize) || 0,
        downloaded: 0,
        link: url,
        directUrl: unlockData.link,
        status: 'pending',
        error: null,
        speed: 0,
        bytesSample: 0,
        progress: 0,
        retryCount: 0,
        retryAt: null,
      };

      task.files = [fileObj];
      task.totalSize = fileObj.size;
      task.status = 'ready_to_download';
      this.checkExistingFileSize(fileObj);
    } catch (err) {
      this.markTaskError(task, err.message || 'Failed to unlock direct link');
    }

    this.processQueue();
    return task;
  }

  /**
   * Setup files array and folder structure for a torrent task
   */
  setupTaskFiles(task, filesTree) {
    const flatList = flattenFileTree(filesTree);
    if (flatList.length === 0) {
      this.markTaskError(task, 'No downloadable files found in this torrent');
      return;
    }

    // If task name is still default Torrent_<id>, derive real name from tree or single file
    if (task.name.startsWith('Torrent_')) {
      if (filesTree.length === 1 && filesTree[0].n && Array.isArray(filesTree[0].e)) {
        task.name = sanitizePathSegment(filesTree[0].n);
      } else if (flatList.length === 1 && flatList[0].name) {
        task.name = flatList[0].name;
      }
    }

    // Determine target output directory
    const baseDir = task.baseOutputDir || this.downloadDir;
    if (flatList.length === 1 && !flatList[0].relativePath.includes('/')) {
      // Single file at root: save directly in base output folder (no unnecessary wrapper subfolder)
      task.outputDir = baseDir;
    } else {
      // Multi-file folder: preserve folder structure inside task folder
      if (path.basename(baseDir).toLowerCase() === task.name.toLowerCase()) {
        task.outputDir = baseDir;
      } else {
        task.outputDir = path.join(baseDir, task.name);
      }
    }

    // Filter by selected files if requested
    const filteredList = task.selectedPaths
      ? flatList.filter((item) => task.selectedPaths.has(item.relativePath))
      : flatList;

    if (filteredList.length === 0) {
      this.markTaskError(task, 'No files selected for download');
      return;
    }

    let totalBytes = 0;
    const fileObjects = filteredList.map((item, idx) => {
      // Map path to local disk inside task.outputDir
      const relativeNorm = item.relativePath.split('/').join(path.sep);
      const fullLocalPath = path.join(task.outputDir, relativeNorm);
      totalBytes += item.size;

      const fObj = {
        id: `${task.id}_f${idx}`,
        taskId: task.id,
        name: item.name,
        relativePath: item.relativePath,
        fullLocalPath,
        size: item.size,
        downloaded: 0,
        link: item.link,
        directUrl: null,
        status: 'pending',
        error: null,
        speed: 0,
        bytesSample: 0,
        progress: 0,
        retryCount: 0,
        retryAt: null,
      };

      this.checkExistingFileSize(fObj);
      return fObj;
    });

    task.files = fileObjects;
    task.totalSize = totalBytes;
    task.status = 'ready_to_download';
    this.updateTaskProgress(task);
  }

  /**
   * Check if file already exists or has partial data on disk
   */
  checkExistingFileSize(file) {
    try {
      if (fs.existsSync(file.fullLocalPath)) {
        const stat = fs.statSync(file.fullLocalPath);
        if (file.size > 0 && stat.size >= file.size) {
          file.downloaded = file.size;
          file.progress = 100;
          file.status = 'completed';
        } else {
          file.downloaded = stat.size;
          file.progress = file.size > 0 ? Math.round((stat.size / file.size) * 100) : 0;
        }
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Sync magnet status from AllDebrid
   */
  async syncMagnetState(task) {
    if (!task.magnetId) return;

    try {
      const [filesRes, statusRes] = await Promise.all([
        this.client.getMagnetFiles(task.magnetId).catch(() => null),
        this.client.getMagnetStatus(task.magnetId).catch(() => null),
      ]);

      const magnetData = normalizeMagnetResponse(filesRes, task.magnetId);
      const mStatus = normalizeMagnetResponse(statusRes, task.magnetId);

      // Update name if still default
      const resolvedName = sanitizePathSegment(mStatus?.filename || magnetData?.filename || magnetData?.name || '');
      if (resolvedName && (task.name.startsWith('Torrent_') || !task.name)) {
        task.name = resolvedName;
        const baseDir = task.baseOutputDir || this.downloadDir;
        if (path.basename(baseDir).toLowerCase() === resolvedName.toLowerCase()) {
          task.outputDir = baseDir;
        } else {
          task.outputDir = path.join(baseDir, resolvedName);
        }
      }

      if (mStatus) {
        task.cloudStatus = mStatus.status;
        task.cloudProgress = mStatus.statusCode === 4 ? 100 : (mStatus.size > 0 && typeof mStatus.downloaded === 'number') ? Math.round((mStatus.downloaded / mStatus.size) * 100) : 0;
      }

      if (magnetData && Array.isArray(magnetData.files) && magnetData.files.length > 0) {
        this.setupTaskFiles(task, magnetData.files);
        return;
      }

      if (mStatus) {
        if (mStatus.statusCode === 4) {
          // Ready! Query files
          const filesRetry = await this.client.getMagnetFiles(task.magnetId);
          const readyData = normalizeMagnetResponse(filesRetry, task.magnetId);
          if (readyData && Array.isArray(readyData.files) && readyData.files.length > 0) {
            this.setupTaskFiles(task, readyData.files);
            return;
          }
        } else if (mStatus.statusCode >= 5) {
          this.markTaskError(task, `Cloud torrent error: ${mStatus.status || 'Failed'}`);
        } else {
          task.status = 'waiting_cloud';
        }
      }
    } catch (err) {
      if (task.status === 'initializing') {
        this.markTaskError(task, err.message || 'Failed to query AllDebrid for magnet');
      }
    }
  }

  /**
   * Mark a task as errored; emits taskError only on transition into the error state
   */
  markTaskError(task, message) {
    const wasError = task.status === 'error';
    task.status = 'error';
    task.error = message;
    if (!wasError) {
      this.emit('taskError', task);
    }
    this._persist();
  }

  /**
   * Background polling for magnets still downloading in the AllDebrid cloud
   */
  async pollCloudMagnets() {
    const cloudWaitingTasks = Array.from(this.tasks.values()).filter(
      (t) => t.status === 'waiting_cloud' && t.magnetId
    );

    if (cloudWaitingTasks.length === 0) return;

    for (const task of cloudWaitingTasks) {
      await this.syncMagnetState(task);
    }

    this.processQueue();
  }

  /**
   * Main Queue Processor: schedules file downloads based on concurrency limit.
   * Tasks are scheduled by priority (0=high..2=low), then by insertion order.
   */
  async processQueue() {
    let runningCount = this.activeFileStreams.size;
    if (runningCount >= this.maxConcurrent) return;

    const orderedTasks = Array.from(this.tasks.values()).sort(
      (a, b) => (a.priority ?? 1) - (b.priority ?? 1) || String(a.addedAt).localeCompare(String(b.addedAt))
    );

    // Find candidate files that are 'pending' from active or ready tasks
    for (const task of orderedTasks) {
      if (['paused', 'error', 'completed', 'waiting_cloud'].includes(task.status)) {
        continue;
      }

      let allFilesDone = true;
      let hasDownloading = false;
      let hasSchedulable = false;
      let firstError = null;

      for (const file of task.files) {
        if (file.status === 'completed') {
          continue;
        }

        if (file.status === 'downloading') {
          hasDownloading = true;
          allFilesDone = false;
        } else if (file.status === 'pending') {
          allFilesDone = false;

          // Files waiting out an auto-retry backoff window are not schedulable yet
          if (file.retryAt && file.retryAt > Date.now()) continue;
          hasSchedulable = true;

          if (runningCount < this.maxConcurrent) {
            runningCount++;
            task.status = 'downloading';
            this.downloadFileStream(task, file).catch((err) => {
              console.error(`Download error for file ${file.name}:`, err);
            });
          }
        } else if (file.status === 'error' || file.status === 'paused') {
          allFilesDone = false;
          if (file.status === 'error' && !firstError) firstError = file.error;
        }
      }

      this.updateTaskProgress(task);

      // Terminal error state: nothing running/schedulable but failed files remain
      if (
        !allFilesDone &&
        !hasDownloading &&
        !hasSchedulable &&
        firstError &&
        !['error', 'paused', 'completed', 'waiting_cloud', 'extracting'].includes(task.status)
      ) {
        this.markTaskError(task, firstError);
      } else if (hasDownloading) {
        task.status = 'downloading';
      }

      if (allFilesDone && task.files.length > 0 && task.status !== 'completed' && task.status !== 'extracting') {
        this.handleTaskCompletion(task);
      }
    }
  }

  /**
   * Handles task completion: triggers auto-extraction if enabled or marks completed
   */
  async handleTaskCompletion(task) {
    if (task.status === 'completed' || task.status === 'extracting') return;

    task.progress = 100;

    if (task.autoExtract && !task.extracted && !task.isExtracting) {
      task.isExtracting = true;
      task.status = 'extracting';
      task.extractionStatus = 'extracting';
      this.emit('taskUpdated', task);

      try {
        const result = await extractTaskArchives(task, task.deleteArchiveAfterExtract);
        task.isExtracting = false;
        task.extracted = true;
        task.extractionStatus = 'completed';
        task.extractionMessage = result.message;
        task.status = 'completed';
        task.completedAt = new Date().toISOString();
        this.emit('taskCompleted', task);
      } catch (err) {
        console.error(`Auto-extraction failed for ${task.name}:`, err);
        task.isExtracting = false;
        task.extractionStatus = 'error';
        task.extractionError = err.message || 'Extraction failed';
        task.status = 'completed';
        task.completedAt = new Date().toISOString();
        this.emit('taskCompleted', task);
      }
    } else {
      task.status = 'completed';
      task.completedAt = new Date().toISOString();
      this.emit('taskCompleted', task);
    }
    this._persist();
  }

  /**
   * Manually triggers archive extraction on a task
   */
  async extractTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('Task not found');

    task.isExtracting = true;
    task.extractionStatus = 'extracting';
    task.extractionError = null;
    this.emit('taskUpdated', task);

    try {
      const result = await extractTaskArchives(task, task.deleteArchiveAfterExtract);
      task.isExtracting = false;
      task.extracted = true;
      task.extractionStatus = 'completed';
      task.extractionMessage = result.message;
      this.emit('taskUpdated', task);
      return result;
    } catch (err) {
      task.isExtracting = false;
      task.extractionStatus = 'error';
      task.extractionError = err.message || 'Extraction failed';
      this.emit('taskUpdated', task);
      throw err;
    }
  }

  /**
   * Handles downloading a single file with folder creation, link unlock, and range resume
   */
  async downloadFileStream(task, file) {
    // 1. Check if file is already fully downloaded on disk before making any network calls
    this.checkExistingFileSize(file);
    if (file.status === 'completed') {
      this.updateTaskProgress(task);
      this.processQueue();
      return;
    }

    file.status = 'downloading';
    file.error = null;
    this.emit('fileStatusChange', { task, file });

    const abortController = new AbortController();
    let writeStream = null;

    try {
      // 2. Ensure target directory exists on disk (preserving folder structure)
      const targetDir = path.dirname(file.fullLocalPath);
      await fs.promises.mkdir(targetDir, { recursive: true });

      // 3. Check resume offset
      let startOffset = 0;
      if (fs.existsSync(file.fullLocalPath)) {
        const stat = await fs.promises.stat(file.fullLocalPath);
        if (file.size > 0 && stat.size >= file.size) {
          // File already completely downloaded!
          file.downloaded = file.size;
          file.progress = 100;
          file.status = 'completed';
          this.updateTaskProgress(task);
          this.processQueue();
          return;
        }
        startOffset = stat.size;
      }

      file.downloaded = startOffset;

      // 3. Resolve direct CDN download URL
      let downloadUrl = file.directUrl;
      if (!downloadUrl) {
        const unlockRes = await this.client.unlockLink(file.link);
        downloadUrl = unlockRes.link;
        file.directUrl = downloadUrl;
        if (unlockRes.filesize && !file.size) {
          file.size = Number(unlockRes.filesize);
        }
      }

      // 4. Send HTTP request with Range header for resuming
      const headers = {};
      if (startOffset > 0) {
        headers['Range'] = `bytes=${startOffset}-`;
      }

      const response = await fetch(downloadUrl, {
        headers,
        signal: abortController.signal,
      });

      if (!response.ok && response.status !== 206) {
        // If range request failed (416 Range Not Satisfiable), restart from beginning
        if (response.status === 416) {
          startOffset = 0;
          file.downloaded = 0;
          const retryRes = await fetch(downloadUrl, { signal: abortController.signal });
          if (!retryRes.ok) throw new Error(`HTTP ${retryRes.status}: ${retryRes.statusText}`);
          return this.pipeResponseToDisk(task, file, retryRes, 0, abortController);
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // If file size wasn't known beforehand, read from Content-Length or Content-Range
      if (!file.size) {
        const cl = response.headers.get('content-length');
        if (cl) file.size = startOffset + Number(cl);
      }

      await this.pipeResponseToDisk(task, file, response, startOffset, abortController);
    } catch (err) {
      if (abortController.signal.aborted) {
        // Paused or cancelled by user
        if (file.status !== 'paused') file.status = 'pending';
      } else {
        this.handleFileFailure(task, file, err);
      }
    } finally {
      this.activeFileStreams.delete(file.id);
      this.updateTaskProgress(task);
      this.processQueue();
    }
  }

  /**
   * Handles a failed file stream: auto-retries with exponential backoff until
   * maxRetries is exhausted, then leaves the file in a terminal error state.
   */
  handleFileFailure(task, file, err) {
    const message = err?.message || 'Download failed';
    const attempts = (file.retryCount || 0) + 1;

    if (attempts <= this.maxRetries) {
      const delay = this.retryBackoffMs[Math.min(attempts - 1, this.retryBackoffMs.length - 1)];
      file.retryCount = attempts;
      file.status = 'pending';
      file.retryAt = Date.now() + delay;
      file.error = `${message} (retry ${attempts}/${this.maxRetries} in ${Math.round(delay / 1000)}s)`;
      console.warn(`[Engine] ${file.name} failed (${message}). Auto-retry ${attempts}/${this.maxRetries} in ${delay}ms`);

      setTimeout(() => {
        if (!this.tasks.has(task.id)) return;
        if (file.status !== 'pending' || !file.retryAt) return;
        if (task.status === 'paused') return;
        file.retryAt = null;
        file.directUrl = null; // cached unlock URLs may have expired
        this.processQueue();
      }, delay);
    } else {
      file.status = 'error';
      file.error = message;
      file.retryAt = null;
      console.error(`[Engine] ${file.name} failed permanently after ${attempts - 1} retries: ${message}`);
    }
  }

  /**
   * Pipe incoming HTTP stream to file on disk using native pipeline and backpressure
   */
  async pipeResponseToDisk(task, file, response, startOffset, abortController) {
    const writeStream = fs.createWriteStream(file.fullLocalPath, {
      flags: startOffset > 0 ? 'a' : 'w',
      highWaterMark: 512 * 1024, // 512KB chunk buffer for smooth mechanical HDD pacing
    });

    this.activeFileStreams.set(file.id, { abortController, writeStream });

    const nodeReadable = Readable.fromWeb(response.body);

    const progressTransform = new Transform({
      transform: (chunk, encoding, callback) => {
        this.speedLimiter.consume(chunk.length).then(
          () => {
            file.downloaded += chunk.length;
            file.bytesSample += chunk.length;
            file.progress = file.size > 0 ? Math.min(100, Math.round((file.downloaded / file.size) * 100)) : 0;

            // Usage statistics: count bytes as they hit the wire
            this.stats.totalBytes += chunk.length;
            const dayKey = localDayKey();
            this.stats.perDay[dayKey] = (this.stats.perDay[dayKey] || 0) + chunk.length;

            callback(null, chunk);
          },
          (err) => callback(err)
        );
      },
    });

    try {
      await pipeline(nodeReadable, progressTransform, writeStream, {
        signal: abortController.signal,
      });

      file.status = 'completed';
      file.progress = 100;
      file.retryCount = 0;
      file.retryAt = null;
      this._persist();
    } catch (err) {
      if (abortController.signal.aborted) {
        // Aborted cleanly by pause or cancel
        return;
      }
      throw err;
    } finally {
      this.activeFileStreams.delete(file.id);
    }
  }

  /**
   * Calculate real-time instantaneous speeds and ETAs for files and tasks
   */
  recalculateSpeeds() {
    let totalActiveSpeed = 0;

    for (const task of this.tasks.values()) {
      let taskSpeed = 0;
      let taskDownloaded = 0;

      for (const file of task.files) {
        if (file.status === 'downloading') {
          file.speed = file.bytesSample;
          file.bytesSample = 0;
          taskSpeed += file.speed;
        } else {
          file.speed = 0;
        }
        taskDownloaded += file.downloaded;
      }

      task.downloadedSize = taskDownloaded;
      task.speed = taskSpeed;
      totalActiveSpeed += taskSpeed;

      if (task.totalSize > 0) {
        task.progress = Math.min(100, Math.round((task.downloadedSize / task.totalSize) * 100));
        const remainingBytes = task.totalSize - task.downloadedSize;
        task.eta = task.speed > 0 ? Math.ceil(remainingBytes / task.speed) : 0;
      }
    }

      this.totalSpeed = totalActiveSpeed;

      // Activity statistics: active seconds + peak throughput
      if (totalActiveSpeed > 0) {
        this.stats.activeSeconds += 1;
        if (totalActiveSpeed > this.stats.peakSpeed) {
          this.stats.peakSpeed = totalActiveSpeed;
        }
      }
    }

  updateTaskProgress(task) {
    let totalDownloaded = 0;
    let allDone = true;

    for (const f of task.files) {
      totalDownloaded += f.downloaded;
      if (f.status !== 'completed') {
        allDone = false;
      }
    }

    task.downloadedSize = totalDownloaded;
    task.progress = task.totalSize > 0 ? Math.min(100, Math.round((totalDownloaded / task.totalSize) * 100)) : 0;

    if (allDone && task.files.length > 0 && task.status !== 'completed' && task.status !== 'extracting') {
      this.handleTaskCompletion(task);
    }
  }

  /**
   * Pause a specific task
   */
  pauseTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    task.status = 'paused';

    for (const file of task.files) {
      if (file.status === 'downloading') {
        file.status = 'paused';
        const stream = this.activeFileStreams.get(file.id);
        if (stream) {
          try { stream.abortController.abort(); } catch {}
          try { stream.writeStream?.destroy(); } catch {}
          this.activeFileStreams.delete(file.id);
        }
      } else if (file.status === 'pending') {
        file.status = 'paused';
        file.retryAt = null;
      }
    }

    this.emit('taskUpdated', task);
    this._persist();
    return true;
  }

  /**
   * Pause every actively running / queued task (disk guard, manual panic button)
   */
  pauseAll() {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (['downloading', 'ready_to_download', 'waiting_cloud'].includes(task.status)) {
        if (this.pauseTask(task.id)) count++;
      }
    }
    return count;
  }

  /**
   * Resume a paused task
   */
  resumeTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    task.status = 'ready_to_download';
    for (const file of task.files) {
      this.checkExistingFileSize(file);
      if (file.status !== 'completed') {
        if (file.status === 'paused' || file.status === 'error') {
          file.status = 'pending';
          file.error = null;
          file.retryCount = 0;
          file.retryAt = null;
        }
      }
    }

    this.updateTaskProgress(task);
    this.emit('taskUpdated', task);
    this._persist();
    this.processQueue();
    return true;
  }

  /**
   * Retry failed files in a task
   */
  retryTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    task.status = 'ready_to_download';
    task.error = null;
    for (const file of task.files) {
      this.checkExistingFileSize(file);
      if (file.status !== 'completed' && file.status === 'error') {
        file.status = 'pending';
        file.error = null;
        file.directUrl = null; // Clear cached URL to re-unlock
        file.retryCount = 0;
        file.retryAt = null;
      }
    }

    this.updateTaskProgress(task);
    this.emit('taskUpdated', task);
    this._persist();
    this.processQueue();
    return true;
  }

  /**
   * Update queue priority of a task (0=high, 1=normal, 2=low)
   */
  setTaskPriority(taskId, priority) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    const p = parseInt(priority, 10);
    if (Number.isNaN(p)) return false;
    task.priority = Math.min(2, Math.max(0, p));
    this.emit('taskUpdated', task);
    this._persist();
    this.processQueue();
    return true;
  }

  /**
   * Cancel and delete task (with optional file removal)
   */
  cancelTask(taskId, deleteFiles = false) {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    // Abort active streams
    for (const file of task.files) {
      const stream = this.activeFileStreams.get(file.id);
      if (stream) {
        try { stream.abortController.abort(); } catch {}
        try { stream.writeStream?.destroy(); } catch {}
        this.activeFileStreams.delete(file.id);
      }
    }

    if (deleteFiles && fs.existsSync(task.outputDir)) {
      try {
        fs.rmSync(task.outputDir, { recursive: true, force: true });
      } catch (err) {
        console.error(`Error deleting folder ${task.outputDir}:`, err);
      }
    }

    this.tasks.delete(taskId);
    this.emit('taskDeleted', taskId);
    this._persist();
    this.processQueue();
    return true;
  }

  /**
   * Get all tasks summary
   */
  getAllTasks() {
    return Array.from(this.tasks.values()).map((task) => ({
      id: task.id,
      magnetId: task.magnetId,
      name: task.name,
      type: task.type,
      status: task.status,
      cloudStatus: task.cloudStatus,
      cloudProgress: task.cloudProgress,
      totalSize: task.totalSize,
      downloadedSize: task.downloadedSize,
      progress: task.progress,
      speed: task.speed,
      eta: task.eta,
      error: task.error,
      outputDir: task.outputDir,
      autoExtract: !!task.autoExtract,
      deleteArchiveAfterExtract: !!task.deleteArchiveAfterExtract,
      extractionStatus: task.extractionStatus,
      extractionError: task.extractionError,
      extractionMessage: task.extractionMessage,
      extracted: !!task.extracted,
      isExtracting: !!task.isExtracting,
      addedAt: task.addedAt,
      completedAt: task.completedAt,
      priority: task.priority ?? 1,
      retryingCount: task.files.filter((f) => f.status === 'pending' && f.retryAt && f.retryAt > Date.now()).length,
      nextRetryAt: task.files.reduce((min, f) => (f.retryAt && (!min || f.retryAt < min) ? f.retryAt : min), null),
      fileCount: task.files.length,
      completedFileCount: task.files.filter((f) => f.status === 'completed').length,
    }));
  }

  /**
   * Get full details of a specific task including all files
   */
  getTaskDetails(taskId) {
    return this.tasks.get(taskId) || null;
  }
}
