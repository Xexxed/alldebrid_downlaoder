/**
 * Stage C/E cloud-poll non-overlap gate: a slow provider round must never
 * stack with the next poll tick, and a stopped engine abandons the round.
 *
 * Run: node --test test/test_cloud_poll_gate.js
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

function makeTask(id, magnetId) {
  return {
    id,
    magnetId,
    name: id,
    type: 'torrent',
    status: 'waiting_cloud',
    cloudStatus: null,
    cloudProgress: 0,
    totalSize: 0,
    downloadedSize: 0,
    progress: 0,
    error: null,
    outputDir: path.join(makeTempDir('adc-poll-out-'), id),
    baseOutputDir: null,
    selectedPaths: null,
    autoExtract: false,
    deleteArchiveAfterExtract: false,
    extracted: false,
    isExtracting: false,
    addedAt: new Date().toISOString(),
    completedAt: null,
    priority: 1,
    files: [],
  };
}

function makeSlowClient() {
  let inFlight = 0;
  const client = {
    async getMagnetFiles() {
      inFlight++;
      client.maxInFlight = Math.max(client.maxInFlight, inFlight);
      client.calls++;
      await new Promise((resolve) => setTimeout(resolve, 40));
      inFlight--;
      return { data: { magnets: [] } };
    },
    async getMagnetStatus() {
      inFlight++;
      client.maxInFlight = Math.max(client.maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return { data: { magnets: [] } };
    },
    calls: 0,
    maxInFlight: 0,
  };
  return client;
}

function makeStartedEngine(root, client) {
  const engine = new DownloadEngine(client, { downloadDir: path.join(root, 'dl'), autoStart: false });
  engines.push(engine);
  engine.tasks.set('t1', makeTask('t1', 'm1'));
  engine.start();
  return engine;
}

test('overlapping poll invocations do not stack provider rounds', async () => {
  const root = makeTempDir('adc-poll-');
  const client = makeSlowClient();
  const engine = makeStartedEngine(root, client);

  const first = engine.pollCloudMagnets();
  const second = engine.pollCloudMagnets();
  const third = engine.pollCloudMagnets();
  await Promise.all([first, second, third]);

  assert.ok(client.calls > 0, 'provider round must have run');
  assert.ok(client.maxInFlight >= 1, 'syncMagnetState calls both files and status concurrently');
  assert.ok(client.maxInFlight <= 2, `one syncMagnetState round touches at most files+status (max ${client.maxInFlight})`);
});

test('stopped engine skips polling entirely', async () => {
  const root = makeTempDir('adc-poll-stop-');
  const client = makeSlowClient();
  const engine = makeStartedEngine(root, client);
  await engine.stop();

  await engine.pollCloudMagnets();
  assert.equal(client.calls, 0, 'no provider calls after stop');
});
