/**
 * Tier 0 + QoL Feature Tests
 * Covers: persistence round-trip, speed limiting, auto-retry with backoff,
 * task priorities, auth token middleware, new settings/stats endpoints.
 *
 * Run: node test/test_tier0_features.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adc-test-'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake AllDebrid client: unlock succeeds, downloads come from local HTTP server
function makeFakeClient(downloadBase) {
  return {
    unlockLink: async (url) => ({
      filename: url.includes('fail') ? 'fail.bin' : 'payload.bin',
      filesize: 512 * 1024,
      link: url.startsWith('http') ? url : `${downloadBase}/payload`,
    }),
    getMagnetFiles: async () => { throw new Error('not implemented'); },
    getMagnetStatus: async () => { throw new Error('not implemented'); },
  };
}

function startPayloadServer(sizeBytes = 512 * 1024) {
  const payload = Buffer.alloc(sizeBytes, 0x41);
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    if (range) {
      const start = parseInt(range.replace(/bytes=/, '').split('-')[0], 10) || 0;
      const slice = payload.subarray(start);
      res.writeHead(206, { 'Content-Length': slice.length, 'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}` });
      res.end(slice);
    } else {
      res.writeHead(200, { 'Content-Length': payload.length });
      res.end(payload);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function testPersistenceAndPriority() {
  console.log('\n--- Persistence & Priority ---');
  const tmp = makeTempDir();
  const statePath = path.join(tmp, 'state.json');

  const { Persistence } = await import('../server/persistence.js');
  const { DownloadEngine } = await import('../server/downloader.js');

  const { server: payloadServer, port } = await startPayloadServer();
  const fakeClient = makeFakeClient(`http://127.0.0.1:${port}`);

  const persistence = new Persistence(statePath, { flushDelayMs: 50 });
  const engine = new DownloadEngine(fakeClient, {
    downloadDir: path.join(tmp, 'dl'),
    maxConcurrent: 2,
    persistence,
    maxRetries: 1,
  });

  // Two folder tasks with different priorities
  const files = (n) => Array.from({ length: n }, (_, i) => ({ name: `f${i}.bin`, relativePath: `f${i}.bin`, size: 64 * 1024, link: `http://127.0.0.1:${port}/f${i}` }));
  const t1 = await engine.addFolderTask('TaskLow', files(2), null, null, { priority: 2 });
  const t2 = await engine.addFolderTask('TaskHigh', files(1), null, null, { priority: 0 });
  engine.setTaskPriority(t1.id, 2);
  engine.setTaskPriority(t2.id, 0);

  // Wait for downloads to complete (small payloads, fast)
  let waited = 0;
  while (waited < 10000 && !(t1.status === 'completed' && t2.status === 'completed')) {
    await sleep(100);
    waited += 100;
  }
  check('tasks complete after download', t1.status === 'completed' && t2.status === 'completed', `t1=${t1.status} t2=${t2.status}`);

  // Force flush and verify file on disk
  engine.flushPersistenceSync();
  check('state file written', fs.existsSync(statePath));
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  check('state contains 2 tasks', saved.tasks.length === 2, `got ${saved.tasks.length}`);
  check('priorities persisted', saved.tasks.some((t) => t.priority === 0) && saved.tasks.some((t) => t.priority === 2));

  // Stats accumulated
  const stats = engine.getStats();
  check('stats bytes accumulated', stats.totalBytes > 0, `${stats.totalBytes} bytes`);
  check('stats todayBytes set', stats.todayBytes > 0);

  // New engine instance restores from same state file
  const persistence2 = new Persistence(statePath, { flushDelayMs: 50 });
  const engine2 = new DownloadEngine(fakeClient, {
    downloadDir: path.join(tmp, 'dl'),
    maxConcurrent: 2,
    persistence: persistence2,
  });
  check('tasks restored into new engine', engine2.tasks.size === 2, `got ${engine2.tasks.size}`);
  const restoredHigh = engine2.tasks.get(t2.id);
  check('restored task keeps priority', restoredHigh?.priority === 0);
  check('restored completed files detected', restoredHigh?.files.every((f) => f.status === 'completed'), restoredHigh?.files.map((f) => f.status).join(','));

  payloadServer.close();
  engine.speedLimiter.destroy();
  clearInterval(engine.speedTrackerInterval);
  clearInterval(engine.pollInterval);
  clearInterval(engine.persistSweepInterval);
  clearInterval(engine2.speedTrackerInterval);
  clearInterval(engine2.pollInterval);
  clearInterval(engine2.persistSweepInterval);
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function testSpeedLimit() {
  console.log('\n--- Global Speed Limit ---');
  const tmp = makeTempDir();
  const { DownloadEngine } = await import('../server/downloader.js');

  const { server: payloadServer, port } = await startPayloadServer(1024 * 1024); // 1 MB
  const fakeClient = makeFakeClient(`http://127.0.0.1:${port}`);
  const engine = new DownloadEngine(fakeClient, { downloadDir: path.join(tmp, 'dl'), maxConcurrent: 1, maxRetries: 0 });

  engine.setSpeedLimit(256 * 1024); // 256 KB/s → ~4s expected
  const start = Date.now();
  const task = await engine.addDirectLinkTask(`http://127.0.0.1:${port}/payload`, 'limited');
  let waited = 0;
  while (waited < 20000 && task.status !== 'completed') {
    await sleep(100);
    waited += 100;
  }
  const elapsed = (Date.now() - start) / 1000;
  check('limited download completes', task.status === 'completed', task.status);
  check('speed limit enforced (>= ~3s)', elapsed >= 3, `elapsed ${elapsed.toFixed(1)}s`);

  // Unlimited is instant again
  engine.setSpeedLimit(0);
  const start2 = Date.now();
  const task2 = await engine.addDirectLinkTask(`http://127.0.0.1:${port}/payload`, 'unlimited');
  waited = 0;
  while (waited < 10000 && task2.status !== 'completed') {
    await sleep(50);
    waited += 50;
  }
  const elapsed2 = (Date.now() - start2) / 1000;
  check('unlimited download fast', task2.status === 'completed' && elapsed2 < 2, `elapsed ${elapsed2.toFixed(2)}s`);

  payloadServer.close();
  engine.speedLimiter.destroy();
  clearInterval(engine.speedTrackerInterval);
  clearInterval(engine.pollInterval);
  clearInterval(engine.persistSweepInterval);
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function testAutoRetry() {
  console.log('\n--- Auto-Retry with Backoff ---');
  const tmp = makeTempDir();
  const { DownloadEngine } = await import('../server/downloader.js');

  const { server: payloadServer, port } = await startPayloadServer();
  const fakeClient = makeFakeClient(`http://127.0.0.1:${port}`);
  const engine = new DownloadEngine(fakeClient, {
    downloadDir: path.join(tmp, 'dl'),
    maxConcurrent: 1,
    maxRetries: 2,
    retryBackoffMs: [100, 150],
  });

  let taskErrorEvents = 0;
  engine.on('taskError', () => taskErrorEvents++);

  // Port 9 (discard) refuses connections → fetch always fails
  const task = await engine.addDirectLinkTask('http://127.0.0.1:9/fail', 'doomed');
  check('task created', !!task);

  // Wait through both backoff windows (100 + 150ms) + margin
  await sleep(1200);
  const file = task.files[0];
  check('file exhausted retries → error', file.status === 'error', `status=${file.status}`);
  check('retry count tracked', (file.retryCount || 0) >= 2, `retryCount=${file.retryCount}`);
  check('taskError event emitted', taskErrorEvents >= 1, `events=${taskErrorEvents}`);
  check('task status error', task.status === 'error');

  // Manual retry resets counters (status may flip to 'downloading' synchronously, so check counter only)
  engine.retryTask(task.id);
  check('manual retry resets retryCount', task.files[0].retryCount === 0 && task.files[0].status !== 'error');
  check('manual retry clears task error state', task.status !== 'error');

  payloadServer.close();
  engine.speedLimiter.destroy();
  clearInterval(engine.speedTrackerInterval);
  clearInterval(engine.pollInterval);
  clearInterval(engine.persistSweepInterval);
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function testServerAuthAndEndpoints() {
  console.log('\n--- Auth Middleware + New Endpoints ---');
  const tmp = makeTempDir();
  // APP_DATA_DIR isolates CONFIG_DIR so settings POSTs write .env into the sandbox, not the project root
  process.env.APP_DATA_DIR = tmp;
  process.env.AUTH_TOKEN = 'test-secret-token';
  process.env.STATE_PATH = path.join(tmp, 'state.json');
  process.env.PORT = '3123';
  process.env.DOWNLOAD_DIR = path.join(tmp, 'dl');

  const { startServer } = await import('../server/server.js');
  const instance = await startServer(3123);
  const base = 'http://127.0.0.1:3123';

  // auth-check is public
  const noTok = await fetch(`${base}/api/auth-check`);
  const noTokData = await noTok.json();
  check('auth-check public & reports lock', noTok.status === 200 && noTokData.authRequired === true);

  const badTok = await fetch(`${base}/api/auth-check`, { headers: { Authorization: 'Bearer wrong' } });
  const badTokData = await badTok.json();
  check('auth-check rejects wrong token', badTokData.tokenValid === false);

  const goodTok = await fetch(`${base}/api/auth-check`, { headers: { Authorization: 'Bearer test-secret-token' } });
  check('auth-check accepts valid token', (await goodTok.json()).tokenValid === true);

  // Protected endpoints reject missing token
  const blocked = await fetch(`${base}/api/downloads`);
  check('API returns 401 without token', blocked.status === 401);

  const blockedQuery = await fetch(`${base}/api/settings?token=wrong`);
  check('API returns 401 with wrong query token', blockedQuery.status === 401);

  // Accepts bearer token
  const ok = await fetch(`${base}/api/downloads`, { headers: { Authorization: 'Bearer test-secret-token' } });
  check('API accepts bearer token', ok.status === 200);

  // Accepts query token (WebSocket clients use this)
  const okQuery = await fetch(`${base}/api/stats?token=test-secret-token`);
  check('API accepts query token', okQuery.status === 200);
  const stats = await okQuery.json();
  check('stats endpoint shape', typeof stats.totalBytes === 'number' && typeof stats.todayBytes === 'number');

  // Settings round-trip with new keys
  const setRes = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret-token' },
    body: JSON.stringify({ newSpeedLimitKbps: 512, newMaxRetries: 5, newMinFreeGb: 2, newAuthToken: 'test-secret-token' }),
  });
  const setData = await setRes.json();
  check('settings save succeeds', setData.success === true, JSON.stringify(data_err(setData)));
  check('speed limit persisted in response', setData.settings.speedLimitKbps === 512);
  check('max retries persisted', setData.settings.maxRetries === 5);
  check('min free gb persisted', setData.settings.minFreeGb === 2);
  check('token masked not leaked', setData.settings.authTokenMasked.includes('...') && !setData.settings.authTokenMasked.includes('secret'));

  // Invalid schedule rejected
  const badSched = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret-token' },
    body: JSON.stringify({ newScheduleEnabled: true, newScheduleStart: '99:99', newScheduleEnd: '07:00' }),
  });
  check('invalid schedule window rejected', badSched.status === 400);

  // Bulk delete validation
  const bulkNoIds = await fetch(`${base}/api/cloud-magnets/delete-bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret-token' },
    body: JSON.stringify({}),
  });
  check('bulk delete requires ids', bulkNoIds.status === 400);

  // Priority endpoint validation
  const badPrio = await fetch(`${base}/api/downloads/nope/priority`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret-token' },
    body: JSON.stringify({ priority: 1 }),
  });
  check('priority on missing task fails cleanly', badPrio.status === 400);

  await new Promise((resolve) => instance.server.close(resolve));
  delete process.env.AUTH_TOKEN;
  delete process.env.STATE_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
}

function data_err(obj) {
  return obj.error || '';
}

(async () => {
  try {
    await testPersistenceAndPriority();
    await testSpeedLimit();
    await testAutoRetry();
    await testServerAuthAndEndpoints();

    const failed = results.filter((r) => !r.pass);
    console.log(`\n========== ${results.length - failed.length}/${results.length} checks passed ==========`);
    if (failed.length > 0) {
      console.error('FAILED CHECKS:', failed.map((f) => f.name).join(' | '));
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error('❌ Test suite crashed:', err);
    process.exit(1);
  }
})();
