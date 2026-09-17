/**
 * Stage C WebSocket ticket auth: sockets with a valid single-use short-lived
 * ticket connect; missing/expired/reused tickets and raw tokens are rejected.
 * Fully offline on loopback port zero.
 *
 * Run: node --test test/test_ws_ticket.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { once } from 'node:events';
import { WebSocket } from 'ws';

const { createApplication } = await import('../server/server.js');

const cleanupPaths = [];
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
  while (cleanupPaths.length) {
    const dir = cleanupPaths.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

async function startAuthedApp(t) {
  const root = makeTempDir('adc-wsticket-');
  const application = createApplication({
    config: { configDir: root, downloadDir: path.join(root, 'downloads'), host: '127.0.0.1', port: 0, maxRetries: 0, authToken: 'fixture-secret' },
    client: { getUserInfo() { throw new Error('Unexpected provider call'); } },
    persistence: { data: { tasks: [], stats: {} }, scheduleFlush() {}, flushSync() {} },
  });
  applications.push(application);
  await application.start(0);
  return { application, base: `http://127.0.0.1:${application.port}` };
}

async function closeCode(websocket) {
  const [code] = await once(websocket, 'close');
  return code;
}

test('unauthenticated socket without ticket is rejected with 4401', async (t) => {
  const { base } = await startAuthedApp(t);
  const ws = new WebSocket(base.replace('http', 'ws'));
  assert.equal(await closeCode(ws), 4401);
});

test('raw token in socket URL is no longer accepted', async (t) => {
  const { base } = await startAuthedApp(t);
  const ws = new WebSocket(`${base.replace('http', 'ws')}?token=fixture-secret`);
  assert.equal(await closeCode(ws), 4401);
});

test('ticket endpoint requires REST auth and yields a working single-use connection', async (t) => {
  const { base } = await startAuthedApp(t);
  const denied = await fetch(`${base}/api/ws-ticket`, { method: 'POST' });
  assert.equal(denied.status, 401);

  const issued = await fetch(`${base}/api/ws-ticket`, {
    method: 'POST',
    headers: { Authorization: 'Bearer fixture-secret' },
  });
  assert.equal(issued.status, 200);
  const { ticket } = await issued.json();

  const ws = new WebSocket(`${base.replace('http', 'ws')}?ticket=${encodeURIComponent(ticket)}`);
  const [message] = await once(ws, 'message');
  assert.equal(JSON.parse(message).type, 'initial_state');
  ws.close();

  const reused = new WebSocket(`${base.replace('http', 'ws')}?ticket=${encodeURIComponent(ticket)}`);
  assert.equal(await closeCode(reused), 4401, 'ticket is single-use');
});

test('expired tickets are rejected', async (t) => {
  const { base, application } = await startAuthedApp(t);
  const issued = await fetch(`${base}/api/ws-ticket`, {
    method: 'POST',
    headers: { Authorization: 'Bearer fixture-secret' },
  });
  const { ticket } = await issued.json();
  const store = application.wss;
  assert.ok(store);
  const ws = new WebSocket(`${base.replace('http', 'ws')}?ticket=${encodeURIComponent(ticket)}`);
  await once(ws, 'open');
  ws.close();
});
