/**
 * Stage B persistence migration: v1 -> v2 with backup, validation of corrupt
 * and future versions, and paused-intent preservation across the migration.
 * Fully offline with unique temp state files.
 *
 * Run: node --test test/test_persistence_migration.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';


const { Persistence } = await import('../server/persistence.js');
const { DownloadEngine } = await import('../server/downloader.js');

class IsolatedEngine extends DownloadEngine {
  ensureDownloadDir() {}
  startBackgroundLoops() {}
}

const cleanupPaths = [];
const stores = [];
function createPersistence(...args) {
  const store = new Persistence(...args);
  stores.push(store);
  return store;
}
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

afterEach(() => {
  while (stores.length) stores.pop().close();
  while (cleanupPaths.length) {
    const dir = cleanupPaths.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function writeState(statePath, content) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, typeof content === 'string' ? content : JSON.stringify(content), 'utf-8');
}

function v1State() {
  return JSON.stringify({
    version: 1,
    tasks: [
      {
        id: 't_paused', magnetId: null, name: 't_paused', type: 'folder', status: 'paused',
        cloudStatus: null, cloudProgress: 0, totalSize: 10, downloadedSize: 0, progress: 0,
        error: null, outputDir: 'X:\\nope', baseOutputDir: 'X:\\no', selectedPaths: null,
        autoExtract: false, deleteArchiveAfterExtract: false, extractionStatus: null,
        extractionError: null, extractionMessage: null, extracted: false, addedAt: '2026-01-01T00:00:00.000Z',
        completedAt: null, priority: 1,
        files: [{ id: 't_paused_f0', taskId: 't_paused', name: 'f0.bin', relativePath: 'f0.bin',
          fullLocalPath: 'X:\\no\\t_paused\\f0.bin', size: 10, downloaded: 4, link: null,
          status: 'paused', error: null, progress: 40, retryCount: 0 }],
      },
      {
        id: 't_done', magnetId: null, name: 't_done', type: 'folder', status: 'completed',
        cloudStatus: null, cloudProgress: 100, totalSize: 10, downloadedSize: 10, progress: 100,
        error: null, outputDir: 'X:\\no\\t_done', baseOutputDir: 'X:\\no', selectedPaths: null,
        autoExtract: false, deleteArchiveAfterExtract: false, extractionStatus: null,
        extractionError: null, extractionMessage: null, extracted: true, addedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-02T00:00:00.000Z', priority: 1,
        files: [{ id: 't_done_f0', taskId: 't_done', name: 'f0.bin', relativePath: 'f0.bin',
          fullLocalPath: 'X:\\no\\t_done\\f0.bin', size: 10, downloaded: 10, link: null,
          status: 'completed', error: null, progress: 100, retryCount: 0 }],
      },
    ],
    stats: { totalBytes: 123, activeSeconds: 4, peakSpeed: 9, perDay: { '2026-01-01': 123 } },
  });
}

test('v1 state migrates to v2 with backup and unknown ownership', () => {
  const tmp = makeTempDir('adc-mig-');
  const statePath = path.join(tmp, 'state.json');
  writeState(statePath, v1State());

  const persistence = createPersistence(statePath, { flushDelayMs: 10 });
  assert.equal(persistence.loadError, null);
  assert.equal(persistence.data.version, 2);
  assert.equal(persistence.data.tasks.length, 2);
  assert.equal(persistence.data.tasks.every((t) => t.ownership === 'unknown'), true);
  assert.equal(persistence.data.tasks[0].files[0].ownership, 'unknown');
  assert.equal(persistence.data.migration.fromVersion, 1);
  assert.equal(persistence.data.migration.legacyOwnershipUnknown, 2);

  const backups = fs.readdirSync(tmp).filter((f) => f.includes('pre-migration'));
  assert.equal(backups.length, 1, 'exactly one pre-migration backup written');
  const backup = JSON.parse(fs.readFileSync(path.join(tmp, backups[0]), 'utf-8'));
  assert.equal(backup.version, 1, 'backup retains original v1 content');

  persistence.flushSync();
  const rewritten = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  assert.equal(rewritten.version, 2);
});

test('paused intent survives v1 -> v2 migration and restart round-trip', () => {
  const tmp = makeTempDir('adc-mig2-');
  const statePath = path.join(tmp, 'state.json');
  writeState(statePath, v1State());

  const persistence = createPersistence(statePath, { flushDelayMs: 10 });
  persistence.flushSync();

  const engine = new IsolatedEngine({}, { downloadDir: path.join(tmp, 'dl'), persistence, autoStart: false });
  const paused = engine.tasks.get('t_paused');
  assert.equal(paused?.status, 'paused', 'paused task must stay paused through migration and restore');
  assert.equal(paused?.files[0].downloaded, 4, 'partial bytes preserved');
  assert.equal(engine.tasks.get('t_done')?.status, 'completed');
  engine.speedLimiter.destroy();
});

test('corrupt JSON is preserved and reported, not overwritten', () => {
  const tmp = makeTempDir('adc-mig3-');
  const statePath = path.join(tmp, 'state.json');
  const corrupt = '{ not valid json !!!';
  writeState(statePath, corrupt);

  const persistence = createPersistence(statePath, { flushDelayMs: 10 });
  assert.match(persistence.loadError || '', /not valid JSON/);
  assert.equal(persistence.data.tasks.length, 0, 'session starts empty');
  assert.equal(fs.readFileSync(statePath, 'utf-8'), corrupt, 'original evidence untouched before any flush');
});

test('future schema version is preserved and reported, never downgraded', () => {
  const tmp = makeTempDir('adc-mig4-');
  const statePath = path.join(tmp, 'state.json');
  writeState(statePath, JSON.stringify({ version: 99, tasks: [{ id: 'x' }] }));

  const persistence = createPersistence(statePath, { flushDelayMs: 10 });
  assert.match(persistence.loadError || '', /unsupported schema version 99/);
  assert.equal(persistence.data.tasks.length, 0);
  assert.throws(() => persistence.flushSync(), /quarantined/);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf-8')).version, 99, 'future-version file untouched');
});

test('state lock rejects a second writer before reading or migrating and releases on close', () => {
  const tmp = makeTempDir('adc-lock-');
  const statePath = path.join(tmp, 'state.json');
  writeState(statePath, v1State());
  const first = createPersistence(statePath);
  const entries = fs.readdirSync(tmp);
  assert.throws(() => new Persistence(statePath), { code: 'STATE_LOCKED' });
  assert.deepEqual(fs.readdirSync(tmp), entries);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).version, 1);
  first.close();
  first.close();
  const second = createPersistence(statePath);
  assert.equal(second.data.version, 2);
  assert.throws(() => first.writeNow(), { code: 'STATE_CLOSED' });
});

test('failed flush retains dirty state and old snapshot until retry succeeds', async (t) => {
  const tmp = makeTempDir('adc-flush-');
  const statePath = path.join(tmp, 'state.json');
  const store = createPersistence(statePath);
  store.flushSync();
  const original = fs.readFileSync(statePath, 'utf8');
  store.data.stats.totalBytes = 123;
  store.scheduleFlush();
  t.mock.method(fs, 'renameSync', () => { throw new Error('Injected publication failure'); });
  await assert.rejects(store.flush(), /Injected publication failure/);
  assert.equal(store._dirty, true);
  assert.equal(fs.readFileSync(statePath, 'utf8'), original);
  assert.equal(fs.readdirSync(tmp).some(name => name.endsWith('.tmp')), false);
  t.mock.restoreAll();
  await store.flush();
  assert.equal(store._dirty, false);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).stats.totalBytes, 123);
});

test('failed close reports write failure, cancels timers and releases the lock', (t) => {
  const tmp = makeTempDir('adc-close-');
  const statePath = path.join(tmp, 'state.json');
  const store = createPersistence(statePath);
  store.scheduleFlush();
  t.mock.method(fs, 'renameSync', () => { throw new Error('Injected close failure'); });
  assert.throws(() => store.close(), /Injected close failure/);
  assert.equal(store._flushTimer, null);
  t.mock.restoreAll();
  const next = createPersistence(statePath);
  assert.equal(next.data.tasks.length, 0);
});
