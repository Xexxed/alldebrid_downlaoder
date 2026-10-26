/**
 * Stage B transfer integrity: strict Range/206 semantics and exact-length
 * EOF validation against a local fake HTTP server. Fully offline.
 *
 * Run: node --test test/test_transfer_integrity.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';

const { DownloadEngine } = await import('../server/downloader.js');

class IsolatedEngine extends DownloadEngine {
  ensureDownloadDir() {}
  startBackgroundLoops() {}
}

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

const PAYLOAD = Buffer.alloc(1024, 0x42);

function startFakeServer(behavior) {
  const server = http.createServer((req, res) => {
    behavior(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/payload` }));
  });
}

function makeEngine(downloadDir) {
  const engine = new IsolatedEngine(
    {
      unlockLink: async (link) => ({ filename: path.basename(new URL(link).pathname), filesize: PAYLOAD.length, link: link.startsWith('http') ? link : '' }),
    },
    { downloadDir, autoStart: false, maxRetries: 0 }
  );
  engine.stopped = false;
  return engine;
}

function makeTaskFile(taskName, filePath) {
  return {
    id: `${taskName}_f0`,
    taskId: taskName,
    name: path.basename(filePath),
    relativePath: path.basename(filePath),
    fullLocalPath: filePath,
    size: PAYLOAD.length,
    downloaded: 0,
    link: 'http://fake-unlock',
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

async function runDownload(engine, task, file) {
  engine.tasks.set(task.id, task);
  await engine.downloadFileStream(task, file);
}

test('full 200 download publishes size_verified completion', async () => {
  const { server, url } = await startFake((req, res) => {
    res.writeHead(200, { 'Content-Length': PAYLOAD.length });
    res.end(PAYLOAD);
  });
  servers.push(server);

  const tmp = makeTempDir('adc-int-');
  const engine = makeEngine(tmp);
  const filePath = path.join(tmp, 'full.bin');
  const file = makeTaskFile('t1', filePath);
  file.link = url;
  file.directUrl = url;
  const task = { id: 't1', status: 'ready_to_download', priority: 1, addedAt: '' };
  task.files = [file];

  await runDownload(engine, task, file);
  assert.equal(file.status, 'completed');
  assert.equal(file.verification, 'size_verified');
  assert.equal(fs.statSync(file.fullLocalPath).size, PAYLOAD.length);
  engine.speedLimiter.destroy();
});

test('truncated body fails instead of publishing completion', async () => {
  // No Content-Length: undici cannot detect the short body, so the engine's
  // exact-length EOF check must catch it against the unlock-reported size.
  const { server, url } = await startFake((req, res) => {
    res.writeHead(200);
    res.end(PAYLOAD.subarray(0, 100));
  });
  servers.push(server);

  const tmp = makeTempDir('adc-int2-');
  const engine = makeEngine(tmp);
  const file = makeTaskFile('t2', path.join(tmp, 'short.bin'));
  file.link = url;
  file.directUrl = url;
  const task = { id: 't2', status: 'ready_to_download', priority: 1, addedAt: '' };
  task.files = [file];

  await runDownload(engine, task, file);
  assert.equal(file.status, 'error');
  assert.match(file.error, /Truncated/);
  engine.speedLimiter.destroy();
});

test('oversized body within drift tolerance publishes completion', async () => {
  const body = Buffer.concat([PAYLOAD, Buffer.alloc(32, 0x43)]);
  const { server, url } = await startFake((req, res) => {
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  });
  servers.push(server);

  const tmp = makeTempDir('adc-int-drift-');
  const engine = makeEngine(tmp);
  const filePath = path.join(tmp, 'near-oversized.bin');
  const file = makeTaskFile('td1', filePath);
  file.link = url;
  file.directUrl = url;
  const task = { id: 'td1', status: 'ready_to_download', priority: 1, addedAt: '' };
  task.files = [file];

  await runDownload(engine, task, file);
  assert.equal(file.status, 'completed');
  assert.equal(file.verification, 'size_verified');
  assert.equal(fs.statSync(filePath).size, body.length);
  engine.speedLimiter.destroy();
});

test('undersized body within drift tolerance publishes completion', async () => {
  const body = PAYLOAD.subarray(0, PAYLOAD.length - 32);
  const { server, url } = await startFake((req, res) => {
    res.writeHead(200);
    res.end(body);
  });
  servers.push(server);

  const tmp = makeTempDir('adc-int-drift2-');
  const engine = makeEngine(tmp);
  const filePath = path.join(tmp, 'near-truncated.bin');
  const file = makeTaskFile('td2', filePath);
  file.link = url;
  file.directUrl = url;
  const task = { id: 'td2', status: 'ready_to_download', priority: 1, addedAt: '' };
  task.files = [file];

  await runDownload(engine, task, file);
  assert.equal(file.status, 'completed');
  assert.equal(file.verification, 'size_verified');
  assert.equal(fs.statSync(filePath).size, body.length);
  engine.speedLimiter.destroy();
});

test('oversized body beyond drift tolerance fails', async () => {
  const body = Buffer.concat([PAYLOAD, Buffer.alloc(4096, 0x43)]);
  const { server, url } = await startFake((req, res) => {
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  });
  servers.push(server);

  const tmp = makeTempDir('adc-int-drift3-');
  const engine = makeEngine(tmp);
  const filePath = path.join(tmp, 'too-oversized.bin');
  const file = makeTaskFile('td3', filePath);
  file.link = url;
  file.directUrl = url;
  const task = { id: 'td3', status: 'ready_to_download', priority: 1, addedAt: '' };
  task.files = [file];

  await runDownload(engine, task, file);
  assert.equal(file.status, 'error');
  assert.match(file.error, /Oversized/);
  engine.speedLimiter.destroy();
});

test('on-disk file within drift tolerance completes without transfer', async () => {
  const tmp = makeTempDir('adc-int-drift4-');
  const engine = makeEngine(tmp);
  const filePath = path.join(tmp, 'near-complete.bin');
  fs.writeFileSync(filePath, Buffer.concat([PAYLOAD, Buffer.alloc(64, 0x43)]));
  const file = makeTaskFile('td4', filePath);
  file.verification = 'unknown';
  file.link = 'http://127.0.0.1:9/dead';
  file.directUrl = 'http://127.0.0.1:9/dead';
  const task = { id: 'td4', status: 'ready_to_download', priority: 1, addedAt: '' };
  task.files = [file];

  await runDownload(engine, task, file);
  assert.equal(file.status, 'completed');
  assert.equal(file.verification, 'size_verified');
  engine.speedLimiter.destroy();
});

test('empty body never verifies against a small expected size', async () => {
  const { server, url } = await startFake((req, res) => {
    res.writeHead(200);
    res.end(Buffer.alloc(0));
  });
  servers.push(server);

  const tmp = makeTempDir('adc-int-tiny1-');
  const engine = makeEngine(tmp);
  const filePath = path.join(tmp, 'tiny.bin');
  const file = makeTaskFile('td5', filePath);
  file.size = 96;
  file.link = url;
  file.directUrl = url;
  const task = { id: 'td5', status: 'ready_to_download', priority: 1, addedAt: '' };
  task.files = [file];

  await runDownload(engine, task, file);
  assert.equal(file.status, 'error');
  assert.match(file.error, /Truncated/);
  engine.speedLimiter.destroy();
});

test('empty on-disk file is never adopted for a small expected size', async () => {
  const tmp = makeTempDir('adc-int-tiny2-');
  const engine = makeEngine(tmp);
  const filePath = path.join(tmp, 'empty-on-disk.bin');
  fs.writeFileSync(filePath, Buffer.alloc(0));
  const file = makeTaskFile('td6', filePath);
  file.size = 96;
  file.verification = 'unknown';
  file.link = 'http://127.0.0.1:9/dead';
  file.directUrl = 'http://127.0.0.1:9/dead';
  const task = { id: 'td6', status: 'ready_to_download', priority: 1, addedAt: '' };
  task.files = [file];

  await runDownload(engine, task, file);
  assert.equal(file.status, 'error');
  engine.speedLimiter.destroy();
});

test('200 response to a Range request restarts owned partial from zero', async () => {
  const { server, url } = await startFake((req, res) => {
    if (req.headers.range) {
      res.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
    } else {
      res.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
    }
  });
  servers.push(server);

  const tmp = makeTempDir('adc-int3-');
  const engine = makeEngine(tmp);
  const filePath = path.join(tmp, 'resume.bin');
  fs.writeFileSync(filePath, 'stale-prefix-bytes');
  const file = makeTaskFile('t3', filePath);
  file.link = url;
  file.directUrl = url;
  const task = { id: 't3', status: 'ready_to_download', priority: 1, addedAt: '' };
  task.files = [file];

  await runDownload(engine, task, file);
  assert.equal(file.status, 'completed');
  assert.equal(fs.readFileSync(filePath).equals(PAYLOAD), true, 'final bytes must be the fresh payload, not appended');
  engine.speedLimiter.destroy();
});

test('malformed Content-Range on 206 aborts the resume', async () => {
  const { server, url } = await startFake((req, res) => {
    const range = req.headers.range;
    if (range) {
      res.writeHead(206, { 'Content-Length': String(PAYLOAD.length - 10), 'Content-Range': 'garbage' });
      res.end(PAYLOAD.subarray(10));
    } else {
      res.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
    }
  });
  servers.push(server);

  const tmp = makeTempDir('adc-int4-');
  const engine = makeEngine(tmp);
  const filePath = path.join(tmp, 'badrange.bin');
  fs.writeFileSync(filePath, PAYLOAD.subarray(0, 10));
  const file = makeTaskFile('t4', filePath);
  file.link = url;
  file.directUrl = url;
  const task = { id: 't4', status: 'ready_to_download', priority: 1, addedAt: '' };
  task.files = [file];

  await runDownload(engine, task, file);
  assert.equal(file.status, 'error');
  assert.match(file.error, /Invalid Content-Range/);
  assert.equal(fs.statSync(filePath).size, 10, 'local partial must not be corrupted by mismatched append');
  engine.speedLimiter.destroy();
});

function startFake(handler) {
  return startPayloadServerLike(handler);
}

function startPayloadServerLike(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/payload` }));
  });
}
