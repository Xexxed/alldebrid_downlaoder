import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'node:assert/strict';
import { Persistence } from '../server/persistence.js';
import { DownloadEngine } from '../server/downloader.js';

function makeTask(root, id, status, files = []) {
  return {
    id,
    magnetId: null,
    name: id,
    type: 'folder',
    status,
    cloudStatus: null,
    cloudProgress: status === 'waiting_cloud' ? 0 : 100,
    totalSize: files.reduce((a, f) => a + f.size, 0),
    downloadedSize: files.reduce((a, f) => a + f.downloaded, 0),
    progress: 0,
    error: null,
    outputDir: path.join(root, id),
    baseOutputDir: root,
    selectedPaths: null,
    autoExtract: false,
    deleteArchiveAfterExtract: false,
    extractionStatus: null,
    extractionError: null,
    extractionMessage: null,
    extracted: false,
    isExtracting: false,
    addedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    priority: 1,
    files,
  };
}

function makeFile(root, taskId, idx, status) {
  const fullLocalPath = path.join(root, taskId, `f${idx}.bin`);
  if (status === 'completed') {
    fs.mkdirSync(path.dirname(fullLocalPath), { recursive: true });
    fs.writeFileSync(fullLocalPath, Buffer.alloc(1024));
  }
  return {
    id: `${taskId}_f${idx}`,
    taskId,
    name: `f${idx}.bin`,
    relativePath: `f${idx}.bin`,
    fullLocalPath,
    size: 1024,
    downloaded: status === 'completed' ? 1024 : 0,
    link: null,
    status,
    error: null,
    progress: status === 'completed' ? 100 : 0,
    retryCount: 0,
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-restore-'));
const root = path.join(tmp, 'dl');
const statePath = path.join(tmp, 'state.json');
const engines = [];
const client = {
  getMagnetFiles: async () => { throw new Error('Unexpected provider access'); },
  getMagnetStatus: async () => { throw new Error('Unexpected provider access'); },
  unlockLink: async () => { throw new Error('Unexpected provider access'); },
};
try {
  const p1 = new Persistence(statePath, { flushDelayMs: 10 });
  const e1 = new DownloadEngine(client, { downloadDir: root, persistence: p1, autoStart: false });
  engines.push(e1);
  e1.start();
  e1.tasks.set('t_paused', makeTask(root, 't_paused', 'paused', [makeFile(root, 't_paused', 0, 'paused')]));
  e1.tasks.set('t_downloading', makeTask(root, 't_downloading', 'downloading', [
    makeFile(root, 't_downloading', 0, 'completed'),
    makeFile(root, 't_downloading', 1, 'downloading'),
  ]));
  e1.tasks.set('t_cloud', makeTask(root, 't_cloud', 'waiting_cloud'));
  e1.tasks.set('t_done', makeTask(root, 't_done', 'completed', [makeFile(root, 't_done', 0, 'completed')]));
  await e1.stop();
  p1.close();

  const p2 = new Persistence(statePath, { flushDelayMs: 10 });
  const e2 = new DownloadEngine(client, { downloadDir: root, persistence: p2, autoStart: false });
  engines.push(e2);
  const restored = (id) => e2.tasks.get(id)?.status;
  assert.equal(restored('t_paused'), 'paused');
  assert.equal(restored('t_downloading'), 'ready_to_download');
  assert.equal(restored('t_cloud'), 'waiting_cloud');
  assert.equal(restored('t_done'), 'completed');
  e2.start();
  assert.equal(restored('t_paused'), 'paused');
  console.log('Pause restoration: 4 states passed');
} finally {
  await Promise.all(engines.map((engine) => engine.stop()));
  for (const engine of engines) engine.persistence.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
