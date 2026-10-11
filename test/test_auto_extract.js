/**
 * End-to-end extraction tests: real zip archives extracted via the platform
 * extractor (bsdtar on Windows), staged publishing, no-clobber guarantees,
 * and provenance-gated cleanup. All state is isolated in temp directories.
 *
 * Run: node --test test/test_auto_extract.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { extractTaskArchives, isArchiveFile, discoverAvailableTools } from '../server/extractor.js';

const emptyZip = Buffer.from('PK\x05\x06' + '\0'.repeat(18));

function makeTask(id, outputDir, files = []) {
  return {
    id,
    name: id,
    status: 'completed',
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

/**
 * Build a real zip fixture via the platform bsdtar: write payload files, then
 * compress them. Returns the zip bytes.
 */
function makeZip(dir, relativeFiles) {
  const staging = fs.mkdtempSync(path.join(dir, 'zipbuild-'));
  try {
    for (const [relative, content] of Object.entries(relativeFiles)) {
      const target = path.join(staging, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    const zipPath = path.join(staging, 'fixture.zip');
    execFileSync(process.platform === 'win32' ? 'tar' : 'bsdtar', ['-a', '-cf', zipPath, ...Object.keys(relativeFiles)], { cwd: staging });
    return fs.readFileSync(zipPath);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

test('owned verified zip is extracted through staging and published no-clobber', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-extract-e2e-'));
  try {
    const outputDir = path.join(root, 'task-output');
    fs.mkdirSync(outputDir);
    const zipPath = path.join(outputDir, 'sample.zip');
    fs.writeFileSync(zipPath, makeZip(root, {
      'content.txt': 'extracted payload',
      'nested/deep/file.bin': 'nested bytes',
    }));
    const task = makeTask('e2e', outputDir, [makeVerifiedFile('sample.zip', zipPath, fs.statSync(zipPath).size)]);

    const result = await extractTaskArchives(task, false);
    assert.equal(fs.readFileSync(path.join(outputDir, 'content.txt'), 'utf8'), 'extracted payload');
    assert.equal(fs.readFileSync(path.join(outputDir, 'nested', 'deep', 'file.bin'), 'utf8'), 'nested bytes');
    assert.deepEqual(result.extracted.map((p) => path.relative(outputDir, p).split(path.sep).join('/')).sort(), ['content.txt', 'nested/deep/file.bin']);
    assert.deepEqual(result.deleted, []);
    assert.equal(fs.existsSync(zipPath), true, 'archive kept without deleteParts');
    assert.equal(fs.existsSync(path.join(outputDir, '.extraction-staging')), false, 'staging removed');
    assert.equal(fs.readdirSync(outputDir).includes('sample.zip'), true);

    // No-clobber: re-extraction must not overwrite the published file.
    const before = fs.readFileSync(path.join(outputDir, 'content.txt'), 'utf8');
    fs.writeFileSync(path.join(outputDir, 'content.txt'), 'user edited this');
    const second = await extractTaskArchives(task, false);
    assert.equal(second.extracted.length, 0, 'no-clobber: existing file wins');
    assert.equal(fs.readFileSync(path.join(outputDir, 'content.txt'), 'utf8'), 'user edited this');
    assert.notEqual(before, 'user edited this');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('extraction preserves a pre-existing staging directory and its contents', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-extract-staging-'));
  try {
    const outputDir = path.join(root, 'task-output');
    const existingStaging = path.join(outputDir, '.extraction-staging');
    fs.mkdirSync(existingStaging, { recursive: true });
    const markerPath = path.join(existingStaging, 'keep.txt');
    fs.writeFileSync(markerPath, 'pre-existing user data');
    const zipPath = path.join(outputDir, 'sample.zip');
    fs.writeFileSync(zipPath, makeZip(root, { 'content.txt': 'extracted payload' }));
    const task = makeTask('staging', outputDir, [makeVerifiedFile('sample.zip', zipPath, fs.statSync(zipPath).size)]);

    const result = await extractTaskArchives(task, false);

    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'pre-existing user data');
    assert.equal(fs.readFileSync(path.join(outputDir, 'content.txt'), 'utf8'), 'extracted payload');
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(fs.readdirSync(outputDir).sort(), ['.extraction-staging', 'content.txt', 'sample.zip']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('colliding destination retains its archive instead of losing the payload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-extract-collide-'));
  try {
    const outputDir = path.join(root, 'task-output');
    fs.mkdirSync(outputDir);
    const zipPath = path.join(outputDir, 'sample.zip');
    fs.writeFileSync(zipPath, makeZip(root, { 'content.txt': 'NEW payload from archive' }));
    // Pre-existing colliding destination with different content.
    fs.writeFileSync(path.join(outputDir, 'content.txt'), 'OLD existing content');
    const task = makeTask('collide', outputDir, [makeVerifiedFile('sample.zip', zipPath, fs.statSync(zipPath).size)]);

    const result = await extractTaskArchives(task, true);

    assert.equal(fs.readFileSync(path.join(outputDir, 'content.txt'), 'utf8').includes('NEW'), false, 'existing destination not overwritten');
    assert.equal(fs.readFileSync(path.join(outputDir, 'content.txt'), 'utf8').includes('NEW'), false, 'existing destination not overwritten');
    assert.deepEqual(result.deleted, [], 'colliding group archives retained');
    assert.equal(fs.existsSync(zipPath), true, 'archive kept because its member collided');
    assert.equal(task.files[0].status, 'completed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('same-named archives in different subfolders extract independently', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-extract-dupname-'));
  try {
    const outputDir = path.join(root, 'task-output');
    const dirA = path.join(outputDir, 'a');
    const dirB = path.join(outputDir, 'b');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const zipA = path.join(dirA, 'data.zip');
    const zipB = path.join(dirB, 'data.zip');
    fs.writeFileSync(zipA, makeZip(root, { 'a.txt': 'from A' }));
    fs.writeFileSync(zipB, makeZip(root, { 'b.txt': 'from B' }));
    const task = makeTask('dup', outputDir, [
      makeVerifiedFile('data.zip', zipA, fs.statSync(zipA).size),
      makeVerifiedFile('data.zip', zipB, fs.statSync(zipB).size),
    ]);

    const result = await extractTaskArchives(task, true);

    assert.equal(fs.readFileSync(path.join(outputDir, 'a.txt'), 'utf8'), 'from A');
    assert.equal(fs.readFileSync(path.join(outputDir, 'b.txt'), 'utf8'), 'from B');
    assert.equal(result.extracted.length, 2, 'both archives extracted');
    assert.equal(fs.existsSync(zipA), false, 'archive A deleted after clean extraction');
    assert.equal(fs.existsSync(zipB), false, 'archive B deleted after clean extraction');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deleteParts removes only owned verified archives, never unprovenanced or unrelated files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-extract-clean-'));
  try {
    const outputDir = path.join(root, 'task-output');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(path.join(outputDir, 'sample.zip'), makeZip(root, { 'content.txt': 'payload' }));
    const unverifiedPath = path.join(outputDir, 'unverified.zip');
    fs.writeFileSync(unverifiedPath, emptyZip);
    const keepPath = path.join(outputDir, 'keepme.txt');
    fs.writeFileSync(keepPath, 'keep');

    const task = makeTask('clean', outputDir, [
      makeVerifiedFile('sample.zip', path.join(outputDir, 'sample.zip'), fs.statSync(path.join(outputDir, 'sample.zip')).size),
      makeVerifiedFile('unverified.zip', unverifiedPath, fs.statSync(unverifiedPath).size, { verification: 'unknown' }),
    ]);

    const result = await extractTaskArchives(task, true);
    assert.equal(result.extracted.length, 1);
    assert.deepEqual(result.deleted, [path.join(outputDir, 'sample.zip')]);
    assert.equal(fs.existsSync(path.join(outputDir, 'sample.zip')), false, 'owned verified archive deleted');
    assert.equal(fs.existsSync(unverifiedPath), true, 'unverified archive retained');
    assert.equal(fs.readFileSync(keepPath, 'utf8'), 'keep', 'unrelated file retained');
    assert.equal(fs.readFileSync(path.join(outputDir, 'content.txt'), 'utf8'), 'payload', 'extracted output intact');
    assert.equal(task.files.find((f) => f.name === 'sample.zip').status, 'deleted_after_extract');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt archive fails without publishing or deleting anything', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-extract-bad-'));
  try {
    const outputDir = path.join(root, 'task-output');
    fs.mkdirSync(outputDir);
    const zipPath = path.join(outputDir, 'broken.zip');
    fs.writeFileSync(zipPath, Buffer.from('definitely not a zip archive'));
    const keepPath = path.join(outputDir, 'keepme.txt');
    fs.writeFileSync(keepPath, 'keep');
    const task = makeTask('bad', outputDir, [makeVerifiedFile('broken.zip', zipPath, fs.statSync(zipPath).size)]);

    await assert.rejects(extractTaskArchives(task, true), /failed|Extractor/);
    const brokenBytes = fs.readFileSync(zipPath);
    assert.equal(brokenBytes.equals(Buffer.from('definitely not a zip archive')), true, 'archive bytes unchanged');
    assert.equal(fs.readFileSync(keepPath, 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(outputDir, '.extraction-staging')), false, 'staging cleaned after failure');
    assert.deepEqual(fs.readdirSync(outputDir).sort(), ['broken.zip', 'keepme.txt']);
    assert.equal(task.files[0].status, 'completed', 'no deletion on failure');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('extraction timeout produces a controlled failure, not a crash', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-extract-timeout-'));
  try {
    const outputDir = path.join(root, 'task-output');
    fs.mkdirSync(outputDir);
    const zipPath = path.join(outputDir, 'sample.zip');
    fs.writeFileSync(zipPath, makeZip(root, { 'content.txt': 'payload' }));
    const task = makeTask('timeout', outputDir, [makeVerifiedFile('sample.zip', zipPath, fs.statSync(zipPath).size)]);

    await assert.rejects(
      extractTaskArchives(task, false, { timeoutMs: 1 }),
      (error) => {
        assert.match(error.message, /timed out|failed/);
        return true;
      },
    );
    assert.equal(fs.existsSync(zipPath), true, 'archive retained on timeout');
    assert.equal(fs.readdirSync(outputDir).some((name) => name.includes('.extraction-staging')), false, 'staging cleaned after timeout');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('archive escaping the output directory is refused before any process runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-extract-escape-'));
  try {
    const outputDir = path.join(root, 'task-output');
    fs.mkdirSync(outputDir);
    const outsidePath = path.join(root, 'outside.zip');
    fs.writeFileSync(outsidePath, emptyZip);
    const task = makeTask('escape', outputDir, [makeVerifiedFile('outside.zip', outsidePath, fs.statSync(outsidePath).size)]);
    // resolveCleanupTargets cannot see outside files: extraction proceeds but
    // must still refuse them? No: provenance gate keeps them ineligible.
    const result = await extractTaskArchives(task, true);
    assert.deepEqual(result, { message: 'No archives to extract', extracted: [], deleted: [] });
    assert.equal(fs.existsSync(outsidePath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discoverAvailableTools identifies available platform extractors', () => {
  const tools = discoverAvailableTools();
  assert.ok(tools.tar, 'tar fallback must be identified');
  if (process.platform === 'win32') {
    // WinRAR is installed in standard path on this environment
    if (fs.existsSync('C:\\Program Files\\WinRAR\\UnRAR.exe')) {
      assert.ok(tools.unrar, 'unrar should be detected in standard WinRAR path');
    }
  }
});

test('incomplete multi-part archive rejects extraction before running child processes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-extract-incomplete-'));
  try {
    const outputDir = path.join(root, 'task-output');
    fs.mkdirSync(outputDir);
    const part1 = path.join(outputDir, 'archive.part1.rar');
    const part2 = path.join(outputDir, 'archive.part2.rar');
    fs.writeFileSync(part1, Buffer.from('part 1 bytes'));
    fs.writeFileSync(part2, Buffer.from('part 2 bytes'));

    // Task specifies 2 parts, but only part 1 has completed status and size_verified
    const task = makeTask('incomplete-task', outputDir, [
      makeVerifiedFile('archive.part1.rar', part1, fs.statSync(part1).size),
      {
        id: 'part2-id',
        name: 'archive.part2.rar',
        fullLocalPath: part2,
        size: fs.statSync(part2).size,
        status: 'pending', // not completed
        ownership: 'owned',
        verification: 'unknown',
      },
    ]);

    await assert.rejects(
      extractTaskArchives(task, false),
      (err) => {
        assert.match(err.message, /Incomplete archive set/);
        return true;
      },
      'must reject incomplete volume set',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('multi-part rar extracts via UnRAR/7z when available and publishes cleanly', async () => {
  const tools = discoverAvailableTools();
  if (!tools.unrar && !tools.sevenZip) {
    // Skip if neither WinRAR nor 7-Zip is installed in test environment
    return;
  }

  // Check if Rar.exe is available to build a fixture
  const rarCreator = [
    'C:\\Program Files\\WinRAR\\Rar.exe',
    'C:\\Program Files (x86)\\WinRAR\\Rar.exe',
  ].find((p) => fs.existsSync(p));

  if (!rarCreator) return;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-extract-multipart-'));
  try {
    const outputDir = path.join(root, 'task-output');
    fs.mkdirSync(outputDir);

    // Create a payload file to compress into parts
    const fixtureDir = fs.mkdtempSync(path.join(root, 'fix-'));
    const payloadFile = path.join(fixtureDir, 'secret_payload.txt');
    fs.writeFileSync(payloadFile, 'A'.repeat(5000));

    // Create split volume archive using Rar.exe with 500 byte uncompressed volumes
    execFileSync(rarCreator, ['a', '-v500b', '-m0', path.join(outputDir, 'multi.rar'), path.basename(payloadFile)], {
      cwd: fixtureDir,
    });

    const createdParts = fs.readdirSync(outputDir).filter((name) => /\.part\d+\.rar$/i.test(name));
    assert.ok(createdParts.length >= 2, `Expected at least 2 part files, got ${createdParts.length}`);

    const taskFiles = createdParts.map((name) => {
      const fullPath = path.join(outputDir, name);
      return makeVerifiedFile(name, fullPath, fs.statSync(fullPath).size);
    });

    const task = makeTask('multipart-test', outputDir, taskFiles);
    const result = await extractTaskArchives(task, true);

    const extractedTarget = path.join(outputDir, 'secret_payload.txt');
    assert.ok(fs.existsSync(extractedTarget), 'Extracted payload file must exist');
    assert.equal(fs.readFileSync(extractedTarget, 'utf8'), 'A'.repeat(5000));
    assert.ok(result.extracted.length >= 1);
    assert.equal(result.deleted.length, createdParts.length, 'All part files must be cleaned up when deleteParts is true');
    for (const part of createdParts) {
      assert.ok(!fs.existsSync(path.join(outputDir, part)), `Part file ${part} must be deleted`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
