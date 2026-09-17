/**
 * Stage C: engine dispatch honors destination containment end-to-end.
 * Malicious relative paths must fail the task without creating files or
 * escaping the destination. Fully offline with unique temp directories.
 *
 * Run: node --test test/test_dispatch_containment.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';

const { DownloadEngine } = await import('../server/downloader.js');

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

function makeEngine(downloadDir) {
  return new IsolatedEngine(
    {
      unlockLink: async (url) => ({ filename: 'payload.bin', filesize: 10, link: 'http://127.0.0.1:1/x' }),
      getMagnetFiles: async () => { throw new Error('not implemented'); },
      getMagnetStatus: async () => { throw new Error('not implemented'); },
    },
    { downloadDir, autoStart: false, maxRetries: 0 }
  );
}

test('addFolderTask rejects traversal file paths and writes nothing outside', async () => {
  const tmp = makeTempDir('adc-disp-');
  const outside = path.join(path.dirname(tmp), 'adc-disp-outside.bin');
  try {
    const engine = makeEngine(tmp);
    const files = [
      { name: 'ok.bin', relativePath: 'ok.bin', size: 5, link: 'http://x/ok' },
      { name: 'evil.bin', relativePath: '../evil.bin', size: 5, link: 'http://x/evil' },
    ];
    const task = await engine.addFolderTask('TraversalTask', files, tmp, null, {});

    assert.equal(task.status, 'error');
    assert.match(task.error, /Rejected file path/);
    assert.equal(fs.existsSync(outside), false, 'nothing may be written outside destination');
    engine.speedLimiter.destroy();
  } finally {
    try { fs.rmSync(outside, { force: true }); } catch {}
  }
});

test('addFolderTask rejects reserved device names', async () => {
  const tmp = makeTempDir('adc-disp2-');
  const engine = makeEngine(tmp);
  const files = [{ name: 'CON', relativePath: 'sub/CON', size: 5, link: 'http://x/con' }];
  const task = await engine.addFolderTask('ReservedTask', files, tmp, null, {});

  assert.equal(task.status, 'error');
  assert.match(task.error, /Reserved Windows device name/);
  engine.speedLimiter.destroy();
});

test('addFolderTask accepts valid nested paths and keeps them contained', async () => {
  const tmp = makeTempDir('adc-disp3-');
  const engine = makeEngine(tmp);
  const files = [
    { name: 'a.bin', relativePath: 'sub/dir/a.bin', size: 5, link: 'http://x/a' },
    { name: 'b.bin', relativePath: 'b.bin', size: 5, link: 'http://x/b' },
  ];
  const task = await engine.addFolderTask('ValidTask', files, tmp, null, {});

  assert.equal(task.status, 'ready_to_download');
  assert.equal(task.files.length, 2);
  for (const f of task.files) {
    assert.equal(path.resolve(f.fullLocalPath).startsWith(path.resolve(tmp)), true, 'contained in destination');
    assert.equal(f.ownership, 'owned');
  }
  engine.speedLimiter.destroy();
});

test('addDirectLinkTask rejects hostile unlocked filenames', async () => {
  const tmp = makeTempDir('adc-disp4-');
  const engine = new IsolatedEngine(
    {
      unlockLink: async () => ({ filename: '..\\evil.bin', filesize: 10, link: 'http://127.0.0.1:1/x' }),
    },
    { downloadDir: tmp, autoStart: false, maxRetries: 0 }
  );
  const task = await engine.addDirectLinkTask('http://source/file', '', tmp, {});

  assert.equal(task.status, 'error');
  assert.match(task.error, /Rejected destination filename/);
  assert.equal(fs.existsSync(path.join(path.dirname(tmp), 'evil.bin')), false);
  engine.speedLimiter.destroy();
});

test('setupTaskFiles neutralizes hostile names and never escapes destination', () => {
  const tmp = makeTempDir('adc-disp5-');
  const engine = makeEngine(tmp);
  const task = {
    id: 't_torrent',
    magnetId: 1,
    name: 'TorrentTest',
    type: 'torrent',
    status: 'initializing',
    baseOutputDir: tmp,
    outputDir: path.join(tmp, 'TorrentTest'),
    selectedPaths: null,
    files: [],
    totalSize: 0,
    priority: 1,
    addedAt: new Date().toISOString(),
  };
  engine.tasks.set(task.id, task);

  // flattenFileTree derives paths from n + e structure and sanitizes names;
  // the planner in setupTaskFiles is the second containment layer.
  engine.setupTaskFiles(task, [
    { n: 'ok.bin', s: 5, l: 'http://x/ok' },
    { n: '../evil.bin', s: 5, l: 'http://x/evil' },
    { n: 'dir', e: [{ n: 'inner.bin', s: 5, l: 'http://x/inner' }] },
  ]);

  assert.equal(task.status, 'ready_to_download', `status=${task.status} error=${task.error}`);
  assert.equal(task.files.length, 3);
  for (const f of task.files) {
    assert.equal(
      path.resolve(f.fullLocalPath).startsWith(path.resolve(task.outputDir)),
      true,
      `contained: ${f.fullLocalPath}`
    );
  }
  assert.equal(fs.existsSync(path.join(path.dirname(tmp), 'evil.bin')), false);
  engine.speedLimiter.destroy();
});
