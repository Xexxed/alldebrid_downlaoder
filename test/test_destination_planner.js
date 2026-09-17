/**
 * Stage C destination planner: path containment, sanitization, reserved
 * names, and case-folded collision detection. Fully offline with unique
 * temp directories.
 *
 * Run: node --test test/test_destination_planner.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';

const {
  resolveBaseDestination,
  sanitizeRelativePath,
  planFileInDestination,
  assertContained,
  DestinationError,
} = await import('../server/planning/destination-planner.js');

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

test('resolveBaseDestination accepts absolute paths and rejects relative input', () => {
  const tmp = makeTempDir('adc-dest-');
  const resolved = resolveBaseDestination(tmp);
  assert.equal(path.isAbsolute(resolved), true);

  assert.throws(() => resolveBaseDestination('relative/dir'), DestinationError);
  assert.throws(() => resolveBaseDestination(''), DestinationError);
  assert.throws(() => resolveBaseDestination('   '), DestinationError);
  assert.throws(() => resolveBaseDestination(null), DestinationError);
});

test('resolveBaseDestination rejects non-existent directories when mustExist', () => {
  const missing = path.join(os.tmpdir(), 'adc-dest-missing-' + Date.now());
  assert.throws(() => resolveBaseDestination(missing, { mustExist: true }), DestinationError);
});

test('sanitizeRelativePath rejects traversal, absolute, and reserved names', () => {
  assert.throws(() => sanitizeRelativePath('../escape.bin'), DestinationError);
  assert.throws(() => sanitizeRelativePath('ok/../../escape.bin'), DestinationError);
  assert.throws(() => sanitizeRelativePath('..\\escape.bin'), DestinationError);
  assert.throws(() => sanitizeRelativePath('C:\\abs.bin'), DestinationError);
  assert.throws(() => sanitizeRelativePath('/abs.bin'), DestinationError);
  assert.throws(() => sanitizeRelativePath('CON.txt'), DestinationError);
  assert.throws(() => sanitizeRelativePath('nul'), DestinationError);
  assert.throws(() => sanitizeRelativePath('folder/name.bin '), /Trailing/);
  assert.throws(() => sanitizeRelativePath('folder/name.'), /Trailing/);
  assert.throws(() => sanitizeRelativePath('bad<name.bin'), DestinationError);
  assert.throws(() => sanitizeRelativePath(''), DestinationError);
  assert.throws(() => sanitizeRelativePath('..'), DestinationError);
});

test('sanitizeRelativePath normalizes forward slashes and preserves nesting', () => {
  assert.equal(sanitizeRelativePath('a/b/c.bin'), path.join('a', 'b', 'c.bin'));
  assert.equal(sanitizeRelativePath('single.bin'), 'single.bin');
  assert.equal(sanitizeRelativePath('a.b.c/d.bin'), path.join('a.b.c', 'd.bin'));
});

test('planFileInDestination detects case-folded collisions without merging', () => {
  const tmp = makeTempDir('adc-dest2-');
  fs.writeFileSync(path.join(tmp, 'Movie.Bin'), 'existing');

  const planned = planFileInDestination(tmp, 'movie.bin');
  assert.equal(planned.collision, true, 'case-folded collision detected');
  assert.equal(planned.fullPath, path.join(tmp, 'movie.bin'), 'planned path stays distinct');
});

test('planFileInDestination reports no collision for new names', () => {
  const tmp = makeTempDir('adc-dest3-');
  const planned = planFileInDestination(tmp, 'unique.bin');
  assert.equal(planned.collision, false);
  assert.equal(planned.fullPath, path.join(tmp, 'unique.bin'));
});

test('assertContained rejects paths escaping their base destination', () => {
  const tmp = makeTempDir('adc-dest4-');
  assertContained(tmp, path.join(tmp, 'sub', 'file.bin'));

  assert.throws(() => assertContained(tmp, path.join(tmp, '..', 'elsewhere.bin')), /escapes/);
  assert.throws(() => assertContained(path.join(tmp, 'sub'), path.join(tmp, 'file.bin')), /escapes/);
});

test('planFileInDestination rejects traversal payloads before touching disk', () => {
  const tmp = makeTempDir('adc-dest5-');
  assert.throws(() => planFileInDestination(tmp, '../../host.bin'), DestinationError);
  assert.throws(() => planFileInDestination(tmp, 'C:\\host.bin'), DestinationError);
  assert.equal(fs.readdirSync(tmp).length, 0, 'no files created by rejected plans');
});
