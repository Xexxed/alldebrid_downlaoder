/**
 * Stage E bandwidth correctness: byte-exact token charging for oversized
 * chunks, no stranded waiters on cap changes, and scheduled-zero-means-
 * unlimited override semantics. Deterministic, offline.
 *
 * Run: node --test test/test_bandwidth_policy.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';

const { DownloadEngine } = await import('../server/downloader.js');
const { createApplication } = await import('../server/server.js');

const cleanupPaths = [];
const engines = [];
const applications = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

afterEach(async () => {
  while (applications.length) {
    const application = applications.pop();
    try { await application.close(); } catch {}
  }
  while (engines.length) {
    const engine = engines.pop();
    try { engine.speedLimiter.destroy(); } catch {}
  }
  while (cleanupPaths.length) {
    const dir = cleanupPaths.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('large chunks are fully charged instead of truncated to the cap', async () => {
  const root = makeTempDir('adc-bw-');
  const engine = new DownloadEngine({}, { downloadDir: path.join(root, 'dl'), autoStart: false });
  engines.push(engine);
  const limiter = engine.speedLimiter;
  limiter.setLimit(1000); // 1000 bytes/second
  limiter.start();
  limiter.tokens = 0;

  const started = performance.now();
  await limiter.consume(3000); // three cap-sized chunks worth of tokens
  const elapsedSeconds = (performance.now() - started) / 1000;

  assert.ok(elapsedSeconds >= 1.5, `3x cap must take ~3s of tokens, took ${elapsedSeconds.toFixed(2)}s`);
  assert.ok(elapsedSeconds < 5, `must not stall indefinitely, took ${elapsedSeconds.toFixed(2)}s`);
  assert.ok(limiter.tokens <= 500, `all bytes charged, residual tokens ${limiter.tokens}`);
});

test('lowering the cap to zero grants stranded waiters immediately', async () => {
  const root = makeTempDir('adc-bw-zero-');
  const engine = new DownloadEngine({}, { downloadDir: path.join(root, 'dl'), autoStart: false });
  engines.push(engine);
  const limiter = engine.speedLimiter;
  limiter.setLimit(1000);
  limiter.tokens = 0;

  const stranded = limiter.consume(50_000);
  const granted = await Promise.race([
    stranded.then(() => 'granted'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 250)),
  ]);
  assert.equal(granted, 'timeout', 'waiter waits while capped');

  limiter.setLimit(0); // unlimited transition must not strand the waiter
  await stranded;
});

test('scheduled zero inside the window means unlimited, not ignored', async (t) => {
  const root = makeTempDir('adc-bw-sched-');
  const application = createApplication({
    config: {
      configDir: root,
      downloadDir: path.join(root, 'dl'),
      host: '127.0.0.1',
      port: 0,
      maxRetries: 0,
      speedLimitKbps: 512,
      scheduleEnabled: true,
      scheduleStart: '00:00',
      scheduleEnd: '00:00', // equal endpoints = full-day window
      scheduleLimitKbps: 0,
    },
    client: { getUserInfo() { throw new Error('Unexpected provider call'); } },
    persistence: { data: { tasks: [], stats: {} }, scheduleFlush() {}, flushSync() {} },
  });
  applications.push(application);
  await application.start(0);
  assert.equal(application.engine.speedLimiter.limit, 0, 'schedule zero within window overrides manual 512 KB/s');
});
