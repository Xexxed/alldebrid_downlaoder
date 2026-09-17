import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import assert from 'node:assert/strict';
import { Persistence } from '../server/persistence.js';
import { DownloadEngine } from '../server/downloader.js';

let checks = 0;
function check(name, cond, extra = '') {
  assert.ok(cond, `${name}${extra ? `: ${extra}` : ''}`);
  checks++;
  console.log(`PASS ${name}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for fixture task');
    await sleep(25);
  }
}

function makeFakeClient(downloadBase, sizeBytes) {
  return {
    unlockLink: async (url) => {
      assert.equal(new URL(url).origin, downloadBase);
      return { filename: 'payload.bin', filesize: sizeBytes, link: url };
    },
    getMagnetFiles: async () => { throw new Error('Unexpected provider access'); },
    getMagnetStatus: async () => { throw new Error('Unexpected provider access'); },
  };
}

async function startPayloadServer(sizeBytes) {
  const payload = Buffer.alloc(sizeBytes, 0x41);
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/fail') {
      res.writeHead(503, { 'Content-Length': 0 });
      res.end();
      return;
    }
    const range = req.headers.range;
    if (range) {
      const start = Number(/^bytes=(\d+)-$/.exec(range)?.[1]);
      if (!Number.isSafeInteger(start) || start >= payload.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${payload.length}` });
        res.end();
        return;
      }
      const slice = payload.subarray(start);
      res.writeHead(206, { 'Content-Length': slice.length, 'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}` });
      res.end(slice);
    } else {
      res.writeHead(200, { 'Content-Length': payload.length });
      res.end(payload);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, requests, base: `http://127.0.0.1:${server.address().port}` };
}

async function withEngineFixture(sizeBytes, run) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-tier0-'));
  const engines = [];
  let payload;
  try {
    payload = await startPayloadServer(sizeBytes);
    const client = makeFakeClient(payload.base, sizeBytes);
    const createEngine = (options = {}) => {
      const engine = new DownloadEngine(client, {
        downloadDir: path.join(tmp, 'dl'),
        maxConcurrent: 1,
        maxRetries: 0,
        persistence: null,
        ...options,
        autoStart: false,
      });
      engines.push(engine);
      return engine;
    };
    await run({ tmp, ...payload, createEngine });
  } finally {
    await Promise.all(engines.map((engine) => engine.stop()));
    for (const engine of engines) engine.persistence?.close?.();
    if (payload) {
      await new Promise((resolve, reject) => payload.server.close((error) => error ? reject(error) : resolve()));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testPersistenceAndPriority() {
  const sizeBytes = 64 * 1024;
  await withEngineFixture(sizeBytes, async ({ tmp, base, createEngine }) => {
    const statePath = path.join(tmp, 'state.json');
    const engine = createEngine({ persistence: new Persistence(statePath, { flushDelayMs: 50 }), maxRetries: 1 });
    engine.start();
    const files = (n) => Array.from({ length: n }, (_, i) => ({
      name: `f${i}.bin`, relativePath: `f${i}.bin`, size: sizeBytes, link: `${base}/f${i}`,
    }));
    const t1 = await engine.addFolderTask('TaskLow', files(2), null, null, { priority: 2 });
    const t2 = await engine.addFolderTask('TaskHigh', files(1), null, null, { priority: 0 });
    engine.setTaskPriority(t1.id, 2);
    engine.setTaskPriority(t2.id, 0);
    await waitFor(() => t1.status === 'completed' && t2.status === 'completed');
    check('tasks complete after download', t1.status === 'completed' && t2.status === 'completed');
    check('downloaded files have exact fixture bytes', [...t1.files, ...t2.files].every((file) =>
      fs.readFileSync(file.fullLocalPath).equals(Buffer.alloc(sizeBytes, 0x41))));
    await engine.stop();
    check('state file written', fs.existsSync(statePath));
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    check('state contains 2 tasks', saved.tasks.length === 2);
    check('priorities persisted', saved.tasks.some((t) => t.priority === 0) && saved.tasks.some((t) => t.priority === 2));
    const stats = engine.getStats();
    check('stats bytes accumulated exactly', stats.totalBytes === sizeBytes * 3, `${stats.totalBytes} bytes`);
    check('stats todayBytes set', stats.todayBytes === sizeBytes * 3);
    engine.persistence.close();
    const engine2 = createEngine({ persistence: new Persistence(statePath, { flushDelayMs: 50 }) });
    engine2.start();
    check('tasks restored into new engine', engine2.tasks.size === 2);
    const restoredHigh = engine2.tasks.get(t2.id);
    check('restored task keeps priority', restoredHigh?.priority === 0);
    check('restored completed files detected', restoredHigh?.files.every((f) => f.status === 'completed'));
  });
}

async function testSpeedLimit() {
  const sizeBytes = 1024 * 1024;
  await withEngineFixture(sizeBytes, async ({ tmp, base, requests, createEngine }) => {
    const engine = createEngine();
    engine.start();
    engine.setSpeedLimit(256 * 1024);
    const start = performance.now();
    const task = await engine.addDirectLinkTask(`${base}/limited`, 'limited', path.join(tmp, 'limited'));
    await waitFor(() => task.status === 'completed', 20000);
    const elapsed = (performance.now() - start) / 1000;
    check('limited download completes', task.status === 'completed');
    check('speed limit enforced (>= ~3s)', elapsed >= 3, `elapsed ${elapsed.toFixed(1)}s`);
    check('limited download transferred exact bytes', task.downloadedSize === sizeBytes &&
      fs.readFileSync(task.files[0].fullLocalPath).equals(Buffer.alloc(sizeBytes, 0x41)));
    engine.setSpeedLimit(0);
    const start2 = performance.now();
    const task2 = await engine.addDirectLinkTask(`${base}/unlimited`, 'unlimited', path.join(tmp, 'unlimited'));
    await waitFor(() => task2.status === 'completed');
    const elapsed2 = (performance.now() - start2) / 1000;
    check('unlimited download fast', elapsed2 < 2, `elapsed ${elapsed2.toFixed(2)}s`);
    check('speed scenarios use distinct targets', task.files[0].fullLocalPath !== task2.files[0].fullLocalPath);
    check('unlimited download transferred exact bytes', task2.downloadedSize === sizeBytes &&
      fs.readFileSync(task2.files[0].fullLocalPath).equals(Buffer.alloc(sizeBytes, 0x41)));
    check('both speed scenarios fetched payloads', requests.includes('/limited') && requests.includes('/unlimited'));
    check('speed stats include both downloads', engine.getStats().totalBytes === sizeBytes * 2);
  });
}

async function testAutoRetry() {
  await withEngineFixture(512 * 1024, async ({ base, requests, createEngine }) => {
    const engine = createEngine({ maxRetries: 2, retryBackoffMs: [100, 150] });
    engine.start();
    let taskErrorEvents = 0;
    engine.on('taskError', () => taskErrorEvents++);
    const task = await engine.addDirectLinkTask(`${base}/fail`, 'doomed');
    check('task created', !!task);
    await waitFor(() => task.status === 'error');
    const file = task.files[0];
    check('file exhausted retries to error', file.status === 'error');
    check('retry count tracked', file.retryCount === 2);
    check('retry fixture received exactly three attempts', requests.filter((url) => url === '/fail').length === 3);
    check('taskError event emitted', taskErrorEvents >= 1);
    check('task status error', task.status === 'error');
    engine.retryTask(task.id);
    check('manual retry resets retryCount', task.files[0].retryCount === 0 && task.files[0].status !== 'error');
    check('manual retry clears task error state', task.status !== 'error');
  });
}

async function testServerAuthAndEndpoints() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-tier0-app-'));
  let instance;
  let providerCalls = 0;
  const unexpectedProviderCall = async () => {
    providerCalls++;
    throw new Error('Unexpected provider access');
  };
  const client = {
    apiKey: '',
    unlockLink: unexpectedProviderCall,
    getMagnetFiles: unexpectedProviderCall,
    getMagnetStatus: unexpectedProviderCall,
    uploadMagnet: unexpectedProviderCall,
    deleteMagnet: unexpectedProviderCall,
    setApiKey: () => {},
  };
  const persistence = {
    data: { tasks: [], stats: { totalBytes: 0, activeSeconds: 0, peakSpeed: 0, perDay: {} } },
    scheduleFlush() {},
    flushSync() {},
    async flush() {},
  };
  try {
    const { createApplication } = await import('../server/server.js');
    instance = createApplication({
      config: {
        configDir: tmp,
        downloadDir: path.join(tmp, 'dl'),
        port: 0,
        host: '127.0.0.1',
        apiKey: '',
        authToken: 'test-secret-token',
        maxConcurrent: 1,
        maxRetries: 0,
        speedLimitKbps: 0,
        minFreeGb: 0,
        jackettUrl: '',
        jackettApiKey: '',
        scheduleEnabled: false,
        scheduleStart: '00:00',
        scheduleEnd: '07:00',
        scheduleLimitKbps: 0,
      },
      client,
      persistence,
    });
    await instance.start(0);
    const base = `http://127.0.0.1:${instance.port}`;
    const request = async (route, options) => {
      const response = await fetch(`${base}${route}`, options);
      return { status: response.status, data: await response.json() };
    };
    const headers = { Authorization: 'Bearer test-secret-token', 'Content-Type': 'application/json' };
    const noTok = await request('/api/auth-check');
    check('auth-check public & reports lock', noTok.status === 200 && noTok.data.authRequired === true);
    const badTok = await request('/api/auth-check', { headers: { Authorization: 'Bearer wrong' } });
    check('auth-check rejects wrong token', badTok.data.tokenValid === false);
    const goodTok = await request('/api/auth-check', { headers });
    check('auth-check accepts valid token', goodTok.data.tokenValid === true);
    check('API returns 401 without token', (await request('/api/downloads')).status === 401);
    check('API returns 401 with wrong query token', (await request('/api/settings?token=wrong')).status === 401);
    const downloads = await request('/api/downloads', { headers });
    check('API accepts bearer token', downloads.status === 200);
    check('injected queue starts empty', instance.engine.tasks.size === 0);
    check('API rejects query-only authentication', (await request('/api/stats?token=test-secret-token')).status === 401);
    const stats = await request('/api/stats', { headers });
    check('stats endpoint shape', stats.status === 200 && typeof stats.data.totalBytes === 'number' && typeof stats.data.todayBytes === 'number');
    const setRes = await request('/api/settings', {
      method: 'POST', headers,
      body: JSON.stringify({ newSpeedLimitKbps: 512, newMaxRetries: 5, newMinFreeGb: 2, newAuthToken: 'test-secret-token' }),
    });
    check('settings save succeeds', setRes.status === 200 && setRes.data.success === true, setRes.data.error);
    check('speed limit persisted in response', setRes.data.settings.speedLimitKbps === 512);
    check('max retries persisted', setRes.data.settings.maxRetries === 5);
    check('min free gb persisted', setRes.data.settings.minFreeGb === 2);
    check('token masked not leaked', setRes.data.settings.authTokenMasked.includes('...') && !setRes.data.settings.authTokenMasked.includes('secret'));
    const badSched = await request('/api/settings', {
      method: 'POST', headers,
      body: JSON.stringify({ newScheduleEnabled: true, newScheduleStart: '99:99', newScheduleEnd: '07:00' }),
    });
    check('invalid schedule window rejected', badSched.status === 400);
    const bulkNoIds = await request('/api/cloud-magnets/delete-bulk', { method: 'POST', headers, body: '{}' });
    check('bulk delete requires ids', bulkNoIds.status === 400);
    const badPrio = await request('/api/downloads/nope/priority', { method: 'POST', headers, body: JSON.stringify({ priority: 1 }) });
    check('priority on missing task fails cleanly', badPrio.status === 400);
    check('application made no provider calls', providerCalls === 0);
  } finally {
    if (instance) await instance.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

await testPersistenceAndPriority();
await testSpeedLimit();
await testAutoRetry();
await testServerAuthAndEndpoints();
console.log(`Tier0: ${checks} checks passed`);
