/**
 * Stage C: engine admission respects volume reservations end-to-end.
 * A full volume rejects new transfers before any network or disk work;
 * released reservations unblock subsequent work. Fully offline via an
 * injected statVolume and a loopback fake server.
 *
 * Run: node --test test/test_engine_disk_guard.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';

const { DownloadEngine } = await import('../server/downloader.js');
const { DiskPolicy } = await import('../server/planning/disk-policy.js');

class IsolatedEngine extends DownloadEngine {
  ensureDownloadDir() {}
  startBackgroundLoops() {}
}

const PAYLOAD = Buffer.alloc(512, 0x41);
const cleanupPaths = [];
const servers = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  while (cleanupPaths.length) {
    const dir = cleanupPaths.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function startFake(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/payload` }));
  });
}

// IsolatedEngine no-ops background loops; start() only enables admissions.
function makeEngine(options = {}) {
  const engine = new IsolatedEngine(
    {
      unlockLink: async () => ({ filename: 'p.bin', filesize: PAYLOAD.length, link: 'http://x/p' }),
    },
    { autoStart: false, maxRetries: 0, ...options }
  );
  engine.start();
  return engine;
}

function makeFile(taskId, filePath) {
  return {
    id: `${taskId}_f0`,
    taskId,
    name: path.basename(filePath),
    relativePath: path.basename(filePath),
    fullLocalPath: filePath,
    size: PAYLOAD.length,
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
    ownership: 'owned',
  };
}

function makeTask(taskId, file) {
  return {
    id: taskId,
    magnetId: null,
    name: taskId,
    type: 'directLink',
    status: 'ready_to_download',
    cloudStatus: null,
    cloudProgress: 100,
    totalSize: PAYLOAD.length,
    downloadedSize: 0,
    progress: 0,
    speed: 0,
    eta: 0,
    error: null,
    outputDir: path.dirname(file.fullLocalPath),
    baseOutputDir: path.dirname(file.fullLocalPath),
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
    files: [file],
  };
}

test('full volume rejects transfer and releases reservation for later retry', async () => {
  const { server, url } = await startFake((req, res) => {
    res.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
    res.end(PAYLOAD);
  });
  servers.push(server);

  const tmp = makeTempDir('adc-dg-');
  const file = makeFile('t1', path.join(tmp, 'blocked.bin'));
  file.directUrl = url;
  const task = makeTask('t1', file);

  const policy = new DiskPolicy({ minFreeBytes: 1024, statVolume: () => 100 });
  const engine = makeEngine({ downloadDir: tmp, diskPolicy: policy });
  engine.tasks.set('t1', task);

  await engine.downloadFileStream(task, file);
  assert.equal(file.status, 'error', 'transfer must not start on a full volume');
  assert.match(file.error, /Insufficient disk space/);
  assert.equal(fs.existsSync(file.fullLocalPath), false, 'no bytes written');
  assert.equal(engine.activeFileStreams.has(file.id), false, 'worker slot released');
  assert.equal(policy.outstandingFor(policy.volumeKeyFor(tmp)), 0, 'reservation released on failure');
  engine.speedLimiter.destroy();
});

test('successful transfer releases its reservation after completion', async () => {
  const { server, url } = await startFake((req, res) => {
    res.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
    res.end(PAYLOAD);
  });
  servers.push(server);

  const tmp = makeTempDir('adc-dg2-');
  const file = makeFile('t2', path.join(tmp, 'ok.bin'));
  file.directUrl = url;
  const task = makeTask('t2', file);

  let freeBytes = 10_000;
  const policy = new DiskPolicy({ minFreeBytes: 0, statVolume: () => freeBytes });
  const engine = makeEngine({ downloadDir: tmp, diskPolicy: policy });
  engine.tasks.set('t2', task);

  await engine.downloadFileStream(task, file);
  assert.equal(file.status, 'completed');
  assert.equal(fs.statSync(file.fullLocalPath).size, PAYLOAD.length);

  const volumeKey = policy.volumeKeyFor(tmp);
  assert.equal(policy.outstandingFor(volumeKey), 0, 'reservation released after completion');
  engine.speedLimiter.destroy();
});

test('two concurrent tasks on one volume cannot overcommit beyond free space', async () => {
  const { server, url } = await startFake((req, res) => {
    res.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
    res.end(PAYLOAD);
  });
  servers.push(server);

  const tmp = makeTempDir('adc-dg3-');
  const file1 = makeFile('t3a', path.join(tmp, 'one.bin'));
  file1.directUrl = url;
  const file2 = makeFile('t3b', path.join(tmp, 'two.bin'));
  file2.directUrl = url;

  const policy = new DiskPolicy({ minFreeBytes: 0, statVolume: () => 600 });
  const engine = makeEngine({ downloadDir: tmp, diskPolicy: policy });
  engine.tasks.set('t3a', makeTask('t3a', file1));
  engine.tasks.set('t3b', makeTask('t3b', file2));

  await Promise.all([
    engine.downloadFileStream(engine.tasks.get('t3a'), file1),
    engine.downloadFileStream(engine.tasks.get('t3b'), file2),
  ]);

  const statuses = [file1.status, file2.status];
  const succeeded = statuses.filter((s) => s === 'completed').length;
  const rejected = statuses.filter((s) => s === 'error').length;
  assert.equal(succeeded + rejected, 2, 'every transfer reached a terminal state');
  assert.equal(succeeded >= 1, true, 'at least the first reservation fits (600 >= 512)');
  const volumeKey = policy.volumeKeyFor(tmp);
  assert.equal(policy.outstandingFor(volumeKey), 0, 'all reservations released at teardown');
  engine.speedLimiter.destroy();
});
