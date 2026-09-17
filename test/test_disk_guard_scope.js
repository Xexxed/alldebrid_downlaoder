/**
 * Stage E disk-guard per-volume semantics: a volume under the configured
 * free-space floor pauses only tasks on that volume; unrelated volumes keep
 * transferring. Offline, deterministic, no real disk thresholds.
 *
 * Run: node --test test/test_disk_guard_scope.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';

const { DownloadEngine } = await import('../server/downloader.js');

const cleanupPaths = [];
const engines = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

afterEach(async () => {
  while (engines.length) {
    const engine = engines.pop();
    try { await engine.stop(); } catch {}
  }
  while (cleanupPaths.length) {
    const dir = cleanupPaths.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function makeTask(id, outputDir, status = 'downloading') {
  return {
    id,
    magnetId: null,
    name: id,
    type: 'folder',
    status,
    cloudStatus: null,
    cloudProgress: 0,
    totalSize: 10,
    downloadedSize: 0,
    progress: 0,
    speed: 0,
    eta: 0,
    error: null,
    outputDir,
    baseOutputDir: path.dirname(outputDir),
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
    files: [],
  };
}

test('pauseVolumeTasks pauses only the affected volume and records the reason', async () => {
  const root = makeTempDir('adc-guard-');
  const engine = new DownloadEngine({}, { downloadDir: path.join(root, 'dl'), autoStart: false });
  engines.push(engine);
  engine.tasks.set('t_c', makeTask('t_c', path.join(root, 'c-volume', 'task-c')));
  engine.tasks.set('t_d', makeTask('t_d', path.join(root, 'd-volume', 'task-d')));
  engine.tasks.set('t_done', makeTask('t_done', path.join(root, 'd-volume', 'task-done'), 'completed'));

  const cVolume = engine.diskPolicy.volumeKeyFor(path.join(root, 'c-volume'));
  assert.equal(engine.diskPolicy.volumeKeyFor(path.join(root, 'd-volume')), cVolume, 'same temp root means same volume');

  const pausedCount = engine.pauseVolumeTasks(cVolume, 'system:disk_pressure');
  assert.equal(pausedCount, 2, 'both active tasks on the affected volume pause');
  assert.equal(engine.tasks.get('t_done').status, 'completed', 'completed tasks untouched');
  assert.equal(engine.tasks.get('t_c').pauseReason, 'system:disk_pressure');
  assert.equal(engine.tasks.get('t_d').pauseReason, 'system:disk_pressure');
  assert.equal(typeof engine.pauseAll, 'function', 'pauseAll remains available for manual panic');
});

test('pauseVolumeTasks with non-matching volume pauses nothing', async () => {
  const root = makeTempDir('adc-guard2-');
  const engine = new DownloadEngine({}, { downloadDir: path.join(root, 'dl'), autoStart: false });
  engines.push(engine);
  engine.tasks.set('t_c', makeTask('t_c', path.join(root, 'task-c')));

  assert.equal(engine.pauseVolumeTasks('Q:', 'system:disk_pressure'), 0);
  assert.equal(engine.tasks.get('t_c').status, 'downloading');
});
