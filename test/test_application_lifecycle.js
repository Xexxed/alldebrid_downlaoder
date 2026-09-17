import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alldebrid-lifecycle-'));
  const applications = [];
  t.after(async () => {
    try { await Promise.all(applications.map(application => application.close())); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  const options = {
    config: { configDir: root, downloadDir: path.join(root, 'downloads'), host: '127.0.0.1', port: 0, maxRetries: 0 },
    client: { getUserInfo() { throw new Error('Unexpected provider call'); } },
    persistence: { data: { tasks: [], stats: {} }, scheduleFlush() {}, flushSync() {} },
    engineFactory: (client, options) => new FakeEngine(client, options),
    ...overrides,
  };
  return { root, options, applications };
}

class FakeEngine extends EventEmitter {
  constructor(client, options) {
    super();
    this.client = client;
    this.options = options;
    this.maxRetries = options.maxRetries;
    this.starts = 0;
    this.stops = 0;
  }
  setSpeedLimit() {}
  getAllTasks() { return []; }
  start() { this.starts++; }
  async stop() { this.stops++; }
}

test('server import performs no configuration, persistence, directory, timer, socket or process-hook work', () => {
  const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import net from 'node:net';
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    require('express'); require('multer'); require('ws');
    const events = ['SIGINT', 'SIGTERM', 'exit'];
    const before = events.map(event => process.listenerCount(event));
    const environment = { ...process.env };
    const blocked = () => { throw new Error('Import side effect'); };
    for (const key of ['mkdirSync', 'writeFileSync', 'renameSync', 'existsSync', 'statSync', 'readdirSync']) fs[key] = blocked;
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (String(file).endsWith('.env') || String(file).endsWith('state.json')) blocked();
      return read.call(this, file, ...args);
    };
    globalThis.setInterval = blocked;
    globalThis.setTimeout = blocked;
    globalThis.fetch = blocked;
    net.Server.prototype.listen = blocked;
    net.Socket.prototype.connect = blocked;
    const server = await import('./server/server.js');
    assert.equal(typeof server.createApplication, 'function');
    assert.equal(Object.hasOwn(server, 'engine'), false);
    assert.equal(Object.keys(require.cache).some(file => file.includes('node_modules/dotenv') || file.includes('node_modules\\\\dotenv')), false);
    assert.ok(Object.keys(process.env).length === Object.keys(environment).length && Object.keys(environment).every(key => process.env[key] === environment[key]), 'Environment changed');
    assert.deepEqual(events.map(event => process.listenerCount(event)), before);
  `;
  execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    timeout: 10_000,
    stdio: 'pipe',
  });
});

test('injected application starts on loopback port zero and closes idempotently', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alldebrid-lifecycle-'));
  let application;
  try {
    const { createApplication } = await import('../server/server.js');
    const client = { getUserInfo() { throw new Error('Unexpected provider call'); } };
    const persistence = { data: { tasks: [], stats: {} }, scheduleFlush() {}, flushSync() {} };
    application = createApplication({
      config: { configDir: root, downloadDir: path.join(root, 'downloads'), host: '127.0.0.1', port: 0, maxRetries: 0 },
      client,
      persistence,
      engineFactory: (client, options) => new FakeEngine(client, options),
    });
    assert.equal(application.engine.options.autoStart, false);
    assert.equal(application.engine.starts, 0);
    assert.equal(application.server.listening, false);
    assert.equal(await application.start(0), application);
    assert.ok(application.port > 0);
    assert.equal(application.engine.starts, 1);
    const response = await fetch(`http://127.0.0.1:${application.port}/api/settings`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).maxRetries, 0);
    assert.equal(await application.start(0), application);
    const websocket = new WebSocket(`ws://127.0.0.1:${application.port}`);
    const snapshotPromise = once(websocket, 'message');
    await once(websocket, 'open');
    assert.equal(JSON.parse((await snapshotPromise)[0]).type, 'initial_state');
    const websocketClosed = once(websocket, 'close');
    await Promise.all([application.close(), application.close()]);
    await websocketClosed;
    assert.equal(application.engine.eventNames().length, 0);
    await assert.rejects(application.start(0), /closed/);
    assert.equal(application.engine.stops, 1);
    assert.equal(application.server.listening, false);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    await application?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bind failure stops the engine without starting or attaching to the occupied server', async (t) => {
  const { createApplication } = await import('../server/server.js');
  const { options, applications } = fixture(t);
  let requests = 0;
  const occupied = http.createServer((_req, res) => { requests++; res.end(); });
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const application = createApplication(options);
  applications.push(application);
  await assert.rejects(application.start(occupied.address().port), { code: 'EADDRINUSE' });
  assert.equal(application.engine.starts, 0);
  assert.equal(application.engine.stops, 1);
  assert.equal(application.server.listening, false);
  assert.equal(application.engine.eventNames().length, 0);
  assert.equal(requests, 0);
});

test('close before start and close during startup both release resources', async (t) => {
  const { createApplication } = await import('../server/server.js');
  const { options, applications } = fixture(t);
  const unstarted = createApplication(options);
  applications.push(unstarted);
  await unstarted.close();
  assert.equal(unstarted.engine.starts, 0);
  assert.equal(unstarted.engine.stops, 1);
  const racing = createApplication(options);
  applications.push(racing);
  const started = racing.start(0);
  const rejected = assert.rejects(started, /closed during startup/);
  await racing.close();
  await rejected;
  assert.equal(racing.server.listening, false);
  assert.equal(racing.engine.stops, 1);
});

test('engine start failure clears server and tracked application timers', async (t) => {
  const { createApplication } = await import('../server/server.js');
  const timers = new Set();
  const clock = {
    setInterval() { const timer = {}; timers.add(timer); return timer; },
    clearInterval(timer) { timers.delete(timer); },
  };
  const { options, applications } = fixture(t, { clock });
  const application = createApplication(options);
  applications.push(application);
  application.engine.start = () => { throw new Error('Engine start failed'); };
  await assert.rejects(application.start(0), /Engine start failed/);
  assert.equal(application.server.listening, false);
  assert.equal(application.engine.stops, 1);
  assert.equal(timers.size, 0);
  const healthy = createApplication(options);
  applications.push(healthy);
  await healthy.start(0);
  assert.equal(timers.size, 2);
  await healthy.close();
  assert.equal(timers.size, 0);
});

test('close awaits engine drainage and still releases sockets when stop fails', async (t) => {
  const { createApplication } = await import('../server/server.js');
  const { options, applications } = fixture(t);
  const application = createApplication(options);
  applications.push(application);
  let release;
  const drained = new Promise(resolve => { release = resolve; });
  application.engine.stop = () => drained;
  await application.start(0);
  let completed = false;
  const closed = application.close().then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  release();
  await closed;
  assert.equal(completed, true);
  const failing = createApplication(options);
  await failing.start(0);
  failing.engine.stop = async () => { throw new Error('Drain failure'); };
  await assert.rejects(failing.close(), /Drain failure/);
  assert.equal(failing.server.listening, false);
  assert.equal(failing.engine.eventNames().length, 0);
});

test('configuration reads only explicit APP_DATA_DIR and never mutates environment', async (t) => {
  const { loadConfiguration } = await import('../server/server.js');
  const { root } = fixture(t);
  const environment = { APP_DATA_DIR: root, MAX_RETRIES: '0', PORT: '0' };
  const before = { ...process.env };
  const probes = [];
  const missing = await loadConfiguration({
    environment,
    filesystem: {
      existsSync(file) { probes.push(file); return false; },
      readFileSync() { throw new Error('Unexpected configuration read'); },
    },
  });
  assert.deepEqual(probes, [path.join(root, '.env')]);
  assert.equal(missing.apiKey, '');
  assert.equal(missing.maxRetries, 0);
  assert.equal(missing.port, 0);
  fs.writeFileSync(path.join(root, '.env'), 'ALLDEBRID_API_KEY=fixture-only\nMAX_RETRIES=4\n');
  const loaded = await loadConfiguration({ environment });
  assert.equal(loaded.apiKey, 'fixture-only');
  assert.equal(loaded.maxRetries, 0);
  assert.deepEqual(environment, { APP_DATA_DIR: root, MAX_RETRIES: '0', PORT: '0' });
  assert.ok(Object.keys(process.env).length === Object.keys(before).length && Object.keys(before).every(key => process.env[key] === before[key]), 'Environment changed');
});

test('bootstrap with explicit config bypasses environment and real persistence', async (t) => {
  const { startServer } = await import('../server/server.js');
  const { options, applications, root } = fixture(t, {
    environment: new Proxy({}, { ownKeys() { throw new Error('Unexpected environment access'); } }),
  });
  const application = await startServer(0, options);
  applications.push(application);
  assert.equal(application.client, options.client);
  assert.equal(application.persistence, options.persistence);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('real engine lifecycle uses only injected empty persistence and temporary downloads', async (t) => {
  const { createApplication } = await import('../server/server.js');
  let flushes = 0;
  let schedules = 0;
  const { options, applications, root } = fixture(t, {
    engineFactory: undefined,
    persistence: {
      data: { tasks: [], stats: {} },
      scheduleFlush() { schedules++; },
      flushSync() { flushes++; },
    },
  });
  const application = createApplication(options);
  applications.push(application);
  assert.equal(application.engine.stopped, true);
  assert.equal(application.engine.pollInterval, null);
  await application.start(0);
  assert.equal(application.engine.stopped, false);
  await application.close();
  assert.equal(application.engine.stopped, true);
  assert.equal(application.engine.speedLimiter._timer, null);
  assert.ok(flushes > 0);
  assert.ok(schedules > 0);
  assert.deepEqual(fs.readdirSync(root), ['downloads']);
});
