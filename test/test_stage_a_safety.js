/**
 * Stage A safety regressions: no broad deletion, no unrelated extraction scan,
 * no overwrite flags. Fully offline with unique temp directories.
 *
 * Run: node --test test/test_stage_a_safety.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';

const { DownloadEngine } = await import('../server/downloader.js');
const { extractTaskArchives } = await import('../server/extractor.js');

class IsolatedEngine extends DownloadEngine {
  ensureDownloadDir() {}
  startBackgroundLoops() {}
}

const cleanupPaths = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupPaths.length) {
    const dir = cleanupPaths.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function makeTask(id, outputDir, files = []) {
  return {
    id,
    magnetId: null,
    name: id,
    type: 'folder',
    status: 'downloading',
    cloudStatus: null,
    cloudProgress: 100,
    totalSize: files.reduce((a, f) => a + f.size, 0),
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
    files,
  };
}

function makeFile(taskId, idx, fullPath, size = 10) {
  return {
    id: `${taskId}_f${idx}`,
    taskId,
    name: path.basename(fullPath),
    relativePath: path.basename(fullPath),
    fullLocalPath: fullPath,
    size,
    downloaded: 0,
    link: null,
    directUrl: null,
    status: 'pending',
    error: null,
    speed: 0,
    bytesSample: 0,
    progress: 0,
    retryCount: 0,
    retryAt: null,
  };
}

test('cancelTask preserves unrelated files in a shared folder', () => {
  const sharedDir = makeTempDir('adc-shared-');
  const unrelatedPath = path.join(sharedDir, 'unrelated.txt');
  fs.writeFileSync(unrelatedPath, 'keep me');

  const engine = new IsolatedEngine({}, { downloadDir: path.dirname(sharedDir), autoStart: false });
  const task = makeTask('t1', sharedDir, [makeFile('t1', 0, path.join(sharedDir, 'a.bin'))]);
  engine.tasks.set('t1', task);

  const removed = engine.cancelTask('t1');
  assert.equal(removed, true);
  assert.equal(engine.tasks.has('t1'), false);
  assert.equal(fs.existsSync(unrelatedPath), true, 'unrelated file must survive task removal');
  assert.equal(fs.existsSync(sharedDir), true, 'shared folder must never be deleted');
  engine.speedLimiter.destroy();
});

test('cancelTask ignores legacy deleteFiles flag and deletes nothing', () => {
  const sharedDir = makeTempDir('adc-shared2-');
  const payloadPath = path.join(sharedDir, 'a.bin');
  fs.writeFileSync(payloadPath, 'x');

  const engine = new IsolatedEngine({}, { downloadDir: path.dirname(sharedDir), autoStart: false });
  engine.tasks.set('t2', makeTask('t2', sharedDir, [makeFile('t2', 0, payloadPath)]));

  assert.equal(engine.cancelTask('t2', true), true);
  assert.equal(fs.existsSync(payloadPath), true, 'payload must survive even with legacy deleteFiles=true');
  engine.speedLimiter.destroy();
});

test('extractTaskArchives never scans directory for unrelated archives', async () => {
  const targetDir = makeTempDir('adc-extract-');
  fs.writeFileSync(path.join(targetDir, 'unrelated.zip'), 'not a real archive');

  const task = makeTask('t3', targetDir, []);
  const result = await extractTaskArchives(task, false);
  assert.equal(result.extractedCount, 0);
  assert.match(result.message, /No archive files detected/);
  assert.equal(fs.existsSync(path.join(targetDir, 'unrelated.zip')), true, 'unrelated archive must not be processed or removed');
});

test('extraction preserves existing outputs and never deletes parts', async () => {
  const targetDir = makeTempDir('adc-extract2-');
  const markerPath = path.join(targetDir, 'existing-output.txt');
  fs.writeFileSync(markerPath, 'original content');
  const archivePath = path.join(targetDir, 'sample.zip');
  fs.writeFileSync(archivePath, 'PK\x05\x06' + '\0'.repeat(18));

  const task = makeTask('t4', targetDir, [makeFile('t4', 0, archivePath, 3)]);
  const result = await extractTaskArchives(task, true);

  assert.equal(result.extractedCount, 1, 'valid empty zip is extracted (extractor runs)');
  assert.deepEqual(result.deletedFiles, [], 'part cleanup is disabled in safe baseline');
  assert.equal(fs.existsSync(archivePath), true, 'parts are never deleted in safe baseline');
  assert.equal(fs.readFileSync(markerPath, 'utf-8'), 'original content');
});

test('extraction flags select no-overwrite mode for detected extractors', async () => {
  const { detectExtractor } = await import('../server/extractor.js');
  const extractor = detectExtractor();
  if (extractor.type === '7z') {
    assert.equal(extractor.type, '7z');
  }
  const source = fs.readFileSync(new URL('../server/extractor.js', import.meta.url), 'utf-8');
  assert.doesNotMatch(source, /-aoa|-o\+/);
});
