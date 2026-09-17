import fs from 'fs';
import os from 'os';
import path from 'path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DownloadEngine } from '../server/downloader.js';
import { extractTaskArchives, detectArchiveGroups, isArchiveFile } from '../server/extractor.js';

const unavailable = {
  code: 'EXTRACTION_UNAVAILABLE',
  message: 'Archive extraction is unavailable until a staged, owned, no-clobber extraction pipeline is implemented.',
};

function makeTask(id, outputDir, files = []) {
  return {
    id,
    name: id,
    status: 'downloading',
    outputDir,
    autoExtract: false,
    deleteArchiveAfterExtract: false,
    extracted: false,
    isExtracting: false,
    files,
  };
}

for (const deleteFiles of [false, true]) {
  test(`cancelTask is metadata-only with legacy deleteFiles=${deleteFiles}`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-cancel-safe-'));
    let engine;
    try {
      const payloadPath = path.join(dir, 'payload.bin');
      const unrelatedPath = path.join(dir, 'unrelated.txt');
      fs.writeFileSync(payloadPath, 'payload');
      fs.writeFileSync(unrelatedPath, 'keep me');
      engine = new DownloadEngine({}, { downloadDir: dir, autoStart: false });
      const task = makeTask('cancel', dir, [{ id: 'cancel-file', fullLocalPath: payloadPath }]);
      engine.tasks.set(task.id, task);

      assert.equal(engine.cancelTask(task.id, deleteFiles), true);
      assert.equal(engine.tasks.has(task.id), false);
      assert.equal(fs.readFileSync(payloadPath, 'utf8'), 'payload');
      assert.equal(fs.readFileSync(unrelatedPath, 'utf8'), 'keep me');
      assert.deepEqual(fs.readdirSync(dir).sort(), ['payload.bin', 'unrelated.txt']);
    } finally {
      await engine?.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('extraction rejects task archives without mutating payloads, unrelated data or metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-extract-safe-'));
  try {
    const archivePath = path.join(dir, 'sample.zip');
    const markerPath = path.join(dir, 'existing-output.txt');
    const unrelatedPath = path.join(dir, 'unrelated.zip');
    const archive = Buffer.from('PK\x05\x06' + '\0'.repeat(18));
    fs.writeFileSync(archivePath, archive);
    fs.writeFileSync(markerPath, 'original content');
    fs.writeFileSync(unrelatedPath, 'unrelated archive');
    const task = makeTask('blocked', dir, [{ name: 'sample.zip', fullLocalPath: archivePath }]);
    const originalTask = structuredClone(task);

    for (const deleteParts of [false, true]) {
      await assert.rejects(extractTaskArchives(task, deleteParts), unavailable);
      assert.deepEqual(task, originalTask);
      assert.deepEqual(fs.readFileSync(archivePath), archive);
      assert.equal(fs.readFileSync(markerPath, 'utf8'), 'original content');
      assert.equal(fs.readFileSync(unrelatedPath, 'utf8'), 'unrelated archive');
      assert.deepEqual(fs.readdirSync(dir).sort(), ['existing-output.txt', 'sample.zip', 'unrelated.zip']);
    }
    await assert.rejects(extractTaskArchives(makeTask('empty', dir)), unavailable);
    const missingDir = path.join(dir, 'not-created');
    await assert.rejects(extractTaskArchives(makeTask('missing', missingDir)), unavailable);
    assert.equal(fs.existsSync(missingDir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extraction rejects without accessing task properties, filesystem or child processes', async (t) => {
  const calls = [];
  const denied = (name) => () => {
    calls.push(name);
    throw new Error(`Unexpected access: ${name}`);
  };
  try {
    for (const name of ['existsSync', 'statSync', 'readdirSync', 'readFileSync', 'mkdirSync', 'writeFileSync', 'unlinkSync', 'rmSync', 'createReadStream', 'createWriteStream']) {
      t.mock.method(fs, name, denied(`fs.${name}`));
    }
    for (const name of ['stat', 'readdir', 'readFile', 'mkdir', 'writeFile', 'unlink', 'rm', 'open']) {
      t.mock.method(fs.promises, name, denied(`fs.promises.${name}`));
    }
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
      t.mock.method(childProcess, name, denied(`childProcess.${name}`));
    }
    syncBuiltinESMExports();
    const task = new Proxy({}, { get: denied('task property') });
    await assert.rejects(extractTaskArchives(task, true), unavailable);
    await assert.rejects(extractTaskArchives(null), unavailable);
    await assert.rejects(extractTaskArchives(), unavailable);
    assert.deepEqual(calls, []);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('pure archive detection retains supported names and multipart grouping', () => {
  for (const name of ['sample.ZIP', 'sample.rar', 'sample.part01.rar', 'sample.r00', 'sample.7z.001', 'sample.zip.002', 'sample.z01', 'sample.tar.gz', 'sample.iso']) {
    assert.equal(isArchiveFile(name), true, name);
  }
  for (const name of [undefined, null, 12, '', 'readme.txt']) {
    assert.equal(isArchiveFile(name), false);
  }
  const baseDir = path.resolve('metadata-only');
  const groups = detectArchiveGroups(['movie.part02.rar', 'movie.part01.rar', 'bundle.7z.002', 'bundle.7z.001', 'single.zip', 'readme.txt'], baseDir);
  assert.deepEqual(groups.map((group) => group.type), ['multipart_rar', 'split_archive', 'single_archive']);
  assert.equal(groups[0].entryFile, path.join(baseDir, 'movie.part01.rar'));
  assert.equal(groups[0].partFiles.length, 2);
  assert.equal(groups[1].entryFile, path.join(baseDir, 'bundle.7z.001'));
  assert.equal(groups[2].entryFile, path.join(baseDir, 'single.zip'));
  const objects = detectArchiveGroups([{ name: 'archive.zip', fullLocalPath: path.join(baseDir, 'archive.zip') }]);
  assert.equal(objects[0].entryFile, path.join(baseDir, 'archive.zip'));
});
