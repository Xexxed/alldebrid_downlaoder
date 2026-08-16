/**
 * High-Performance Download Manager with Recursive Folder Preservation & Resume Support
 */

import fs from 'fs';
import path from 'path';
import EventEmitter from 'events';
import { flattenFileTree, sanitizePathSegment } from './alldebrid.js';

export class DownloadEngine extends EventEmitter {
  constructor(alldebridClient, options = {}) {
    super();
    this.client = alldebridClient;
    this.downloadDir = path.resolve(options.downloadDir || './downloads');
    this.maxConcurrent = options.maxConcurrent || 3;
    this.tasks = new Map(); // taskId -> Task
    this.activeFileStreams = new Map(); // fileId -> { abortController, writeStream }
    this.pollInterval = null;
    this.speedTrackerInterval = null;

    this.ensureDownloadDir();
    this.startBackgroundLoops();
  }

  ensureDownloadDir() {
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
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

  startBackgroundLoops() {
    // Speed and ETA recalculator loop (every 1 second)
    this.speedTrackerInterval = setInterval(() => {
      this.recalculateSpeeds();
      this.emit('progress');
    }, 1000);

    // Cloud magnet status poller loop (every 3 seconds)
    this.pollInterval = setInterval(() => {
      this.pollCloudMagnets();
    }, 3000);
  }

  /**
   * Add a new torrent / magnet task
   */
  async addMagnetTask(magnetId, name = '', initialFilesTree = null, customOutputDir = null, selectedRelativePaths = null) {
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
      addedAt: new Date().toISOString(),
      completedAt: null,
      files: [],
    };

    this.tasks.set(taskId, task);
    this.emit('taskAdded', task);

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
   * Add direct file download task (or link list)
   */
  async addDirectLinkTask(url, customName = '', customOutputDir = null) {
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
      addedAt: new Date().toISOString(),
      completedAt: null,
      files: [],
    };

    this.tasks.set(taskId, task);
    this.emit('taskAdded', task);

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
      };

      task.files = [fileObj];
      task.totalSize = fileObj.size;
      task.status = 'ready_to_download';
      this.checkExistingFileSize(fileObj);
    } catch (err) {
      task.status = 'error';
      task.error = err.message || 'Failed to unlock direct link';
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
      task.status = 'error';
      task.error = 'No downloadable files found in this torrent';
      return;
    }

    // If single file torrent at root, save directly in base output folder
    if (flatList.length === 1 && !flatList[0].relativePath.includes('/') && task.name === flatList[0].name) {
      task.outputDir = task.baseOutputDir || this.downloadDir;
    }

    // Filter by selected files if requested
    const filteredList = task.selectedPaths
      ? flatList.filter((item) => task.selectedPaths.has(item.relativePath))
      : flatList;

    if (filteredList.length === 0) {
      task.status = 'error';
      task.error = 'No files selected for download';
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
      // 1. Check if files are already ready on AllDebrid
      const filesRes = await this.client.getMagnetFiles(task.magnetId);
      const magnetData = filesRes?.magnets?.[0];

      if (magnetData && Array.isArray(magnetData.files) && magnetData.files.length > 0) {
        this.setupTaskFiles(task, magnetData.files);
        return;
      }

      // 2. If files not returned, query magnet status
      const statusRes = await this.client.getMagnetStatus(task.magnetId);
      const mStatus = statusRes?.magnets?.find((m) => m.id === task.magnetId) || statusRes?.magnets?.[0];

      if (mStatus) {
        task.cloudStatus = mStatus.status;
        task.cloudProgress = mStatus.size > 0 ? Math.round((mStatus.downloaded / mStatus.size) * 100) : 0;
        if (mStatus.filename && task.name.startsWith('Torrent_')) {
          task.name = sanitizePathSegment(mStatus.filename);
          task.outputDir = path.join(this.downloadDir, task.name);
        }

        if (mStatus.statusCode === 4) {
          // Ready! Query files now
          const filesRetry = await this.client.getMagnetFiles(task.magnetId);
          const readyData = filesRetry?.magnets?.[0];
          if (readyData && readyData.files) {
            this.setupTaskFiles(task, readyData.files);
            return;
          }
        } else if (mStatus.statusCode >= 5) {
          task.status = 'error';
          task.error = `Cloud torrent error: ${mStatus.status || 'Failed'}`;
        } else {
          task.status = 'waiting_cloud';
        }
      }
    } catch (err) {
      if (task.status === 'initializing') {
        task.status = 'error';
        task.error = err.message || 'Failed to query AllDebrid for magnet';
      }
    }
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
   * Main Queue Processor: schedules file downloads based on concurrency limit
   */
  async processQueue() {
    let runningCount = this.activeFileStreams.size;
    if (runningCount >= this.maxConcurrent) return;

    // Find candidate files that are 'pending' from active or ready tasks
    for (const task of this.tasks.values()) {
      if (['paused', 'error', 'completed', 'waiting_cloud'].includes(task.status)) {
        continue;
      }

      let allFilesDone = true;
      let hasDownloading = false;

      for (const file of task.files) {
        // Verify on-disk status for non-downloading files
        if (file.status !== 'completed' && file.status !== 'downloading') {
          this.checkExistingFileSize(file);
        }

        if (file.status === 'completed') {
          continue;
        }

        if (file.status === 'downloading') {
          hasDownloading = true;
          allFilesDone = false;
        } else if (file.status === 'pending') {
          allFilesDone = false;

          if (runningCount < this.maxConcurrent) {
            runningCount++;
            task.status = 'downloading';
            this.downloadFileStream(task, file).catch((err) => {
              console.error(`Download error for file ${file.name}:`, err);
            });
          }
        } else if (file.status === 'error' || file.status === 'paused') {
          allFilesDone = false;
        }
      }

      this.updateTaskProgress(task);

      if (allFilesDone && task.files.length > 0) {
        task.status = 'completed';
        task.completedAt = new Date().toISOString();
        task.progress = 100;
        this.emit('taskCompleted', task);
      } else if (hasDownloading) {
        task.status = 'downloading';
      }
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
        file.status = 'error';
        file.error = err.message || 'Download failed';
        console.error(`Error downloading ${file.name}:`, err);
      }
    } finally {
      this.activeFileStreams.delete(file.id);
      this.updateTaskProgress(task);
      this.processQueue();
    }
  }

  /**
   * Pipe incoming HTTP stream to file on disk
   */
  async pipeResponseToDisk(task, file, response, startOffset, abortController) {
    const writeStream = fs.createWriteStream(file.fullLocalPath, {
      flags: startOffset > 0 ? 'a' : 'w',
      highWaterMark: 1024 * 1024, // 1MB buffer to prevent OS write cache flooding
    });

    const reader = response.body.getReader();
    this.activeFileStreams.set(file.id, { abortController, writeStream, reader });

    const abortHandler = () => {
      try { reader.cancel(); } catch {}
      try { writeStream.destroy(); } catch {}
    };

    abortController.signal.addEventListener('abort', abortHandler, { once: true });

    return new Promise((resolve, reject) => {
      const pump = async () => {
        try {
          while (true) {
            if (abortController.signal.aborted) {
              try { await reader.cancel(); } catch {}
              writeStream.destroy();
              return resolve();
            }

            const { done, value } = await reader.read();
            if (done) {
              writeStream.end();
              await new Promise((res) => writeStream.once('finish', res));
              break;
            }

            if (value) {
              const ok = writeStream.write(Buffer.from(value));
              file.downloaded += value.length;
              file.bytesSample += value.length;
              file.progress = file.size > 0 ? Math.min(100, Math.round((file.downloaded / file.size) * 100)) : 0;

              if (!ok) {
                await new Promise((res) => writeStream.once('drain', res));
              }
            }
          }

          file.status = 'completed';
          file.progress = 100;
          resolve();
        } catch (err) {
          try { await reader.cancel(); } catch {}
          writeStream.destroy();
          if (abortController.signal.aborted) {
            resolve();
          } else {
            reject(err);
          }
        } finally {
          abortController.signal.removeEventListener('abort', abortHandler);
        }
      };

      pump();
    });
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

    if (allDone && task.files.length > 0 && task.status !== 'completed') {
      task.status = 'completed';
      task.completedAt = new Date().toISOString();
      this.emit('taskCompleted', task);
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
          try { stream.reader?.cancel(); } catch {}
          try { stream.writeStream?.destroy(); } catch {}
          this.activeFileStreams.delete(file.id);
        }
      } else if (file.status === 'pending') {
        file.status = 'paused';
      }
    }

    this.emit('taskUpdated', task);
    return true;
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
        }
      }
    }

    this.updateTaskProgress(task);
    this.emit('taskUpdated', task);
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
      }
    }

    this.updateTaskProgress(task);
    this.emit('taskUpdated', task);
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
        try { stream.reader?.cancel(); } catch {}
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
      addedAt: task.addedAt,
      completedAt: task.completedAt,
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
