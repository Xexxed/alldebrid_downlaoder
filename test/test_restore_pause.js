/**
 * Regression: user pause must survive an application restart.
 *
 * Reproduces the reported bug: restoreFromPersistence() used to convert every
 * non-completed task (including paused ones) to ready_to_download, silently
 * resuming downloads the user had explicitly paused.
 *
 * Round-trip: save a mixed-state queue -> reload -> assert restored states.
 * Fully offline: temp dirs, in-memory fake client, no timers, no network.
 *
 * Run: node test/test_restore_pause.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'node:assert/strict';

const { Persistence } = await import('../server/persistence.js');
const { DownloadEngine } = await import('../server/downloader.js');

// Isolated engine: never touch real download dirs, never start background loops
class IsolatedEngine extends DownloadEngine {
  ensureDownloadDir() {}
  startBackgroundLoops() {}
}

function makeTask(id, status, files = []) {
  return {
    id,
    magnetId: null,
    name: id,
    type: 'folder',
    status,
    cloudStatus: null,
    cloudProgress: status === 'waiting_cloud' ? 0 : 100,
    totalSize: files.reduce((a, f) => a + f.size, 0),
    downloadedSize: files.reduce((a, f) => a + f.downloaded, 0),
    progress: 0,
    error: null,
    outputDir: path.join(os.tmpdir(), 'adc-restore-nonexistent', id),
    baseOutputDir: path.join(os.tmpdir(), 'adc-restore-nonexistent'),
    selectedPaths: null,
    autoExtract: false,
    deleteArchiveAfterExtract: false,
    extractionStatus: null,
    extractionError: null,
    extractionMessage: null,
    extracted: false,
    isExtracting: false,
    addedAt: new Date().toISOString(),
    completedAt: null,
    priority: 1,
    files,
  };
}

function makeFile(taskId, idx, status) {
  return {
    id: `${taskId}_f${idx}`,
    taskId,
    name: `f${idx}.bin`,
    relativePath: `f${idx}.bin`,
    fullLocalPath: path.join(os.tmpdir(), 'adc-restore-nonexistent', taskId, `f${idx}.bin`),
    size: 1024,
    downloaded: status === 'completed' ? 1024 : 0,
    link: null,
    status,
    error: null,
    progress: status === 'completed' ? 100 : 0,
    retryCount: 0,
  };
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(true);
    console.log(`✅ ${name}`);
  } catch (err) {
    results.push(false);
    console.error(`❌ ${name} — ${err.message}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-restore-'));
const statePath = path.join(tmp, 'state.json');
try {
  // --- Session 1: queue contains every persistable state, then shutdown flush
  const p1 = new Persistence(statePath, { flushDelayMs: 10 });
  const e1 = new IsolatedEngine({}, { downloadDir: path.join(tmp, 'dl'), persistence: p1 });
  e1.tasks.set('t_paused', makeTask('t_paused', 'paused', [makeFile('t_paused', 0, 'paused')]));
  e1.tasks.set('t_downloading', makeTask('t_downloading', 'downloading', [
    makeFile('t_downloading', 0, 'completed'),
    makeFile('t_downloading', 1, 'downloading'),
  ]));
  e1.tasks.set('t_cloud', makeTask('t_cloud', 'waiting_cloud'));
  e1.tasks.set('t_done', makeTask('t_done', 'completed', [makeFile('t_done', 0, 'completed')]));
  e1.flushPersistenceSync();
  e1.speedLimiter.destroy();

  // --- Session 2: fresh engine restores from the same state file (app restart)
  const p2 = new Persistence(statePath, { flushDelayMs: 10 });
  const e2 = new IsolatedEngine({}, { downloadDir: path.join(tmp, 'dl'), persistence: p2 });
  const restored = (id) => e2.tasks.get(id)?.status;

  check('paused task stays paused after restart', () =>
    assert.equal(restored('t_paused'), 'paused'));
  check('interrupted task becomes ready_to_download', () =>
    assert.equal(restored('t_downloading'), 'ready_to_download'));
  check('cloud-waiting task keeps waiting_cloud', () =>
    assert.equal(restored('t_cloud'), 'waiting_cloud'));
  check('completed task stays completed', () =>
    assert.equal(restored('t_done'), 'completed'));

  e2.speedLimiter.destroy();
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((r) => !r).length;
console.log(`\n===== ${results.length - failed}/${results.length} checks passed =====`);
process.exit(failed > 0 ? 1 : 0);
