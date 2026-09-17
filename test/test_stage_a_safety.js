import fs from 'fs';
import os from 'os';
import path from 'path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DownloadEngine } from '../server/downloader.js';
import { extractTaskArchives, detectArchiveGroups, isArchiveFile } from '../server/extractor.js';

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

function makeVerifiedFile(name, fullLocalPath, size, overrides = {}) {
  return {
    id: `${name}-id`,
    name,
    fullLocalPath,
    size,
    downloaded: size,
    status: 'completed',
    ownership: 'owned',
    verification: 'size_verified',
    ...overrides,
  };
}

// Minimal valid empty-zip fixture (EOCD only): bsdtar can open it and find no entries.
const emptyZip = Buffer.from('PK\x05\x06' + '\0'.repeat(18));

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

test('extraction with unprovenanced archives is a pure no-op', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-extract-safe-'));
  try {
    const archivePath = path.join(dir, 'sample.zip');
    const markerPath = path.join(dir, 'existing-output.txt');
    const unrelatedPath = path.join(dir, 'unrelated.zip');
    const archive = emptyZip;
    fs.writeFileSync(archivePath, archive);
    fs.writeFileSync(markerPath, 'original content');
    fs.writeFileSync(unrelatedPath, 'unrelated archive');
    // File lacks ownership/verification provenance: must never be extracted or deleted.
    const task = makeTask('blocked', dir, [{ name: 'sample.zip', fullLocalPath: archivePath, status: 'completed' }]);
    const originalTask = structuredClone(task);

    for (const deleteParts of [false, true]) {
      const result = await extractTaskArchives(task, deleteParts);
      assert.deepEqual(result.extracted, []);
      assert.deepEqual(result.deleted, []);
      assert.deepEqual(task, originalTask);
    }
    assert.deepEqual(fs.readFileSync(archivePath), archive);
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'original content');
    assert.equal(fs.readFileSync(unrelatedPath, 'utf8'), 'unrelated archive');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['existing-output.txt', 'sample.zip', 'unrelated.zip']);

    // Tasks with no eligible files are pure no-ops; invalid tasks reject without creating directories.
    const emptyResult = await extractTaskArchives(makeTask('empty', dir));
    assert.deepEqual(emptyResult, { message: 'No archives to extract', extracted: [], deleted: [] });
    await assert.rejects(extractTaskArchives(null), /Task/);
    await assert.rejects(extractTaskArchives(), /Task/);
    const missingDir = path.join(dir, 'not-created');
    await extractTaskArchives(makeTask('missing', missingDir));
    assert.equal(fs.existsSync(missingDir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
