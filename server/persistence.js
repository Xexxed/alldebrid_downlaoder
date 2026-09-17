/**
 * JSON Persistence Store
 * Durable task queue + usage stats. Atomic writes (tmp + rename), debounced flushes.
 *
 * Schema v2 adds explicit migration with backup-on-upgrade. Corrupt or
 * unsupported state is preserved and reported, never overwritten with an
 * empty queue.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';

const DEFAULT_STATS = {
  totalBytes: 0,
  activeSeconds: 0,
  peakSpeed: 0,
  perDay: {}, // 'YYYY-MM-DD' -> bytes
};

const SUPPORTED_VERSIONS = [1, 2];

export const SCHEMA_VERSION = 2;

function emptyState(version = SCHEMA_VERSION) {
  return {
    version,
    tasks: [],
    stats: { ...DEFAULT_STATS, perDay: {} },
    ...(version >= 2 ? { migration: null } : {}),
  };
}

function validateState(state) {
  if (!state || typeof state !== 'object') return 'state is not an object';
  if (typeof state.version !== 'number' || !Number.isInteger(state.version)) return 'version is not an integer';
  if (!SUPPORTED_VERSIONS.includes(state.version)) return `unsupported schema version ${state.version}`;
  if (!Array.isArray(state.tasks)) return 'tasks is not an array';
  if (state.stats !== undefined && (typeof state.stats !== 'object' || state.stats === null)) return 'stats is not an object';
  return null;
}

function migrateV1toV2(v1) {
  const tasks = v1.tasks.map((t) => {
    const task = { ...t };
    if (task.ownership === undefined) task.ownership = 'unknown';
    for (const f of task.files || []) {
      if (f.ownership === undefined) f.ownership = 'unknown';
      if (f.verification === undefined) f.verification = 'unknown';
    }
    return task;
  });
  return {
    version: 2,
    tasks,
    stats: v1.stats,
    migration: {
      migratedAt: new Date().toISOString(),
      fromVersion: 1,
      toVersion: 2,
      legacyOwnershipUnknown: tasks.length,
    },
  };
}

export class Persistence {
  constructor(filePath, options = {}) {
    const absolutePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    this.filePath = path.join(fs.realpathSync(path.dirname(absolutePath)), path.basename(absolutePath));
    this.lockPath = `${this.filePath}.lock`;
    this._closed = false;
    this._lockToken = randomUUID();
    this._lockFd = null;
    this.flushDelayMs = options.flushDelayMs ?? 2000;
    this.backupOnUpgrade = options.backupOnUpgrade !== false;
    this._flushTimer = null;
    this._dirty = false;
    this.loadError = null;
    this.migrationReport = null;
    this.data = emptyState();
    try {
      this._lockFd = fs.openSync(this.lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw Object.assign(new Error('State store is locked. Close the other instance; after an unclean exit, verify no writer is running before removing the state lock.'), { code: 'STATE_LOCKED' });
      }
      throw error;
    }
    try {
      fs.writeFileSync(this._lockFd, JSON.stringify({ pid: process.pid, token: this._lockToken }));
      this.load();
      this._quarantined = !!this.loadError && fs.existsSync(this.filePath);
    } catch (error) {
      fs.closeSync(this._lockFd);
      this._lockFd = null;
      fs.unlinkSync(this.lockPath);
      throw error;
    }
  }

  assertOpen() {
    if (this._closed) throw Object.assign(new Error('State store is closed'), { code: 'STATE_CLOSED' });
  }

  load() {
    this.assertOpen();
    if (!fs.existsSync(this.filePath)) {
      this.data = emptyState();
      return this.data;
    }

    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      this.loadError = `Cannot read state file: ${err.message}`;
      console.error(`[Persistence] ${this.loadError} — preserving file, starting with empty session.`);
      this.data = emptyState();
      return this.data;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.loadError = `State file is not valid JSON: ${err.message}`;
      console.error(`[Persistence] ${this.loadError} Preserving original file; starting with empty session.`);
      this.data = emptyState();
      return this.data;
    }

    const validationError = validateState(parsed);
    if (validationError) {
      this.loadError = validationError;
      console.error(`[Persistence] Unsupported or invalid state (${validationError}). Original file preserved; starting with empty session.`);
      this.data = emptyState();
      return this.data;
    }

    if (parsed.version === 1) {
      try {
        this.backupRaw(raw, 'pre-migration');
      } catch (err) {
        this.loadError = `Migration backup failed: ${err.message}`;
        console.error(`[Persistence] ${this.loadError} Aborting migration; original file preserved.`);
        this.data = emptyState();
        return this.data;
      }
      this.data = migrateV1toV2(parsed);
      console.log(`[Persistence] Migrated state v1 -> v2 (${this.data.migration.legacyOwnershipUnknown} task(s) marked ownership=unknown). Backup written next to state file.`);
      this._dirty = true;
      return this.data;
    }

    this.data = {
      ...emptyState(2),
      ...parsed,
      stats: { ...DEFAULT_STATS, ...(parsed.stats || {}), perDay: (parsed.stats && parsed.stats.perDay) || {} },
    };
    return this.data;
  }

  backupRaw(raw, label) {
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(dir, `${base}.${label}.${stamp}.bak`);
    fs.writeFileSync(backupPath, raw, 'utf-8');
    return backupPath;
  }

  scheduleFlush() {
    this.assertOpen();
    this._dirty = true;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush().catch((err) => console.error('[Persistence] Flush failed:', err.message));
    }, this.flushDelayMs);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  async flush() {
    this.assertOpen();
    if (!this._dirty && !this._flushTimer) return;
    this.flushSync();
  }

  flushSync() {
    this.assertOpen();
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this._dirty = true;
    this.writeNow();
    this._dirty = false;
  }

  close() {
    if (this._closed) return;
    try {
      if (this._dirty && !this._quarantined) this.flushSync();
    } finally {
      if (this._flushTimer) clearTimeout(this._flushTimer);
      this._flushTimer = null;
      this._closed = true;
      if (this._lockFd !== null) fs.closeSync(this._lockFd);
      this._lockFd = null;
      const lock = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
      if (lock.token === this._lockToken) fs.unlinkSync(this.lockPath);
    }
  }

  writeNow() {
    this.assertOpen();
    if (this._quarantined) {
      // Original state file is unreadable or unsupported: never overwrite the
      // evidence with this empty session. New writes require an explicit
      // destination change or manual recovery.
      throw new Error(`Refusing to overwrite quarantined state file (${this.loadError}). Move or repair "${this.filePath}" first.`);
    }
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    let fd;
    let created = false;
    try {
      fd = fs.openSync(tmpPath, 'wx', 0o600);
      created = true;
      fs.writeFileSync(fd, JSON.stringify(this.data), 'utf-8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmpPath, this.filePath);
      created = false;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (created) fs.unlinkSync(tmpPath);
    }
  }
}
