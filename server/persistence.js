/**
 * JSON Persistence Store
 * Durable task queue + usage stats. Atomic writes (tmp + rename), debounced flushes.
 */

import fs from 'fs';
import path from 'path';

const DEFAULT_STATS = {
  totalBytes: 0,
  activeSeconds: 0,
  peakSpeed: 0,
  perDay: {}, // 'YYYY-MM-DD' -> bytes
};

export class Persistence {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.flushDelayMs = options.flushDelayMs ?? 2000;
    this._flushTimer = null;
    this._dirty = false;
    this.data = { version: 1, tasks: [], stats: { ...DEFAULT_STATS, perDay: {} } };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.data = {
            version: 1,
            tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
            stats: {
              ...DEFAULT_STATS,
              ...(parsed.stats || {}),
              perDay: (parsed.stats && parsed.stats.perDay) || {},
            },
          };
        }
      }
    } catch (err) {
      console.error('[Persistence] Failed to load state, starting fresh:', err.message);
      this.data = { version: 1, tasks: [], stats: { ...DEFAULT_STATS, perDay: {} } };
    }
    return this.data;
  }

  scheduleFlush() {
    this._dirty = true;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush().catch((err) => console.error('[Persistence] Flush failed:', err.message));
    }, this.flushDelayMs);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  async flush() {
    if (!this._dirty && !this._flushTimer) return;
    this._dirty = false;
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    await this.writeNow();
  }

  flushSync() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this._dirty = false;
    try {
      this.writeNow();
    } catch (err) {
      console.error('[Persistence] Sync flush failed:', err.message);
    }
  }

  writeNow() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.data), 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }
}
