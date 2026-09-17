/**
 * Stage C DownloadPlan: preview attaches expiring plan IDs; dispatch reloads
 * and revalidates the server-side plan instead of trusting client payloads.
 * Fully offline with injected dependencies and no provider calls.
 *
 * Run: node --test test/test_download_plans.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';

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

async function startApp(t, engineOverrides = {}) {
  const root = makeTempDir('adc-plan-');
  const createdEngines = [];
  const { DownloadEngine } = await import('../server/downloader.js');
  const application = createApplication({
    config: { configDir: root, downloadDir: path.join(root, 'downloads'), host: '127.0.0.1', port: 0, maxRetries: 0, apiKey: 'fixture-key' },
    client: {
      getUserInfo() { throw new Error('Unexpected provider call'); },
      async unlockLink(url) {
        return { filename: 'sample_video.mp4', filesize: 0, link: url };
      },
      async uploadMagnet() { throw new Error('Unexpected provider access'); },
      async uploadTorrentFile() { throw new Error('Unexpected provider access'); },
    },
    persistence: { data: { tasks: [], stats: {} }, scheduleFlush() {}, flushSync() {} },
    engineFactory: (client, options) => {
      class TrackingEngine extends DownloadEngine {
        async addFolderTask(name, files, customOutputDir, selected, opts = {}) {
          const task = await super.addFolderTask(name, files, customOutputDir, selected, { ...options, ...opts });
          createdEngines.push({ method: 'folder', task, args: { name, files, customOutputDir, selected } });
          return task;
        }
        async addDirectLinkTask(url, customName, customOutputDir, opts = {}) {
          const task = await super.addDirectLinkTask(url, customName, customOutputDir, { ...options, ...opts });
          createdEngines.push({ method: 'directLink', task, args: { url, customName, customOutputDir } });
          return task;
        }
      }
      return new TrackingEngine(client, { ...options, ...engineOverrides });
    },
  });
  applications.push(application);
  await application.start(0);
  return { application, base: `http://127.0.0.1:${application.port}`, root, createdEngines };
}

test('preview returns expiring plan IDs and dispatch consumes them single-use', async (t) => {
  const { base, root, application } = await startApp(t);
  const previewRes = await fetch(`${base}/api/downloads/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: 'https://hoster.example/file/sample_video.mp4' }),
  });
  assert.equal(previewRes.status, 200);
  const { previews, errors } = await previewRes.json();
  assert.equal(previews.length, 1);
  assert.match(previews[0].planId, /^plan_/);

  const dispatchBody = { items: [{ planId: previews[0].planId, type: 'directLink', url: 'https://hoster.example/file/sample_video.mp4', name: 'sample_video.mp4', customOutputDir: null, selectedFiles: null, autoExtract: false, deleteArchiveAfterExtract: false }] };
  const first = await fetch(`${base}/api/downloads/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dispatchBody),
  });
  assert.equal(first.status, 200);
  const firstData = await first.json();
  assert.equal(firstData.addedCount, 1);

  const second = await fetch(`${base}/api/downloads/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dispatchBody),
  });
  assert.equal(second.status, 200);
  const secondData = await second.json();
  assert.equal(secondData.addedCount, 0, 'replayed plan ID is rejected as single-use');
  assert.equal(secondData.errors.length, 1);

  assert.equal(application.engine.tasks.size, 1, 'exactly one task created across both dispatches');
  fs.rmSync(root, { recursive: true, force: true });
  cleanupPaths.pop();
});

test('unknown and malformed plan IDs fail dispatch without creating tasks', async () => {
  const { base, application } = await startApp();
  const response = await fetch(`${base}/api/downloads/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ planId: 'plan_missing', type: 'directLink', url: 'https://hoster.example/x.bin' }] }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.addedCount, 0);
  assert.equal(data.tasks.length, 0);
  assert.equal(application.engine.tasks.size, 0);
});

test('preview disk annotations treat only exact-length files as complete', async (t) => {
  const { base, root } = await startApp(t);
  const destination = path.join(root, 'dest');
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'exact.bin'), Buffer.alloc(4, 1));
  fs.writeFileSync(path.join(destination, 'oversized.bin'), Buffer.alloc(9, 1));

  const previewRes = await fetch(`${base}/api/downloads/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: 'https://hoster.example/file/sample_video.mp4' }),
  });
  const { previews } = await previewRes.json();
  assert.equal(previews.length, 1);
  assert.equal(previews[0].planId.startsWith('plan_'), true);
});
