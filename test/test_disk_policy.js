/**
 * Stage C disk policy: per-volume reservation accounting, floor enforcement,
 * and unknown-capacity reporting. Fully offline with injected statVolume.
 *
 * Run: node --test test/test_disk_policy.js
 */

import os from 'os';
import path from 'path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { DiskPolicy } = await import('../server/planning/disk-policy.js');

test('reserve accounts for outstanding reservations on the same volume', () => {
  const dir = 'D:\\data';
  let free = 100;
  const policy = new DiskPolicy({ statVolume: () => free });

  const first = policy.reserve(dir, 'r1', 60);
  assert.equal(first.ok, true);
  assert.equal(policy.outstandingFor('D:'), 60);

  const second = policy.reserve(dir, 'r2', 60);
  assert.equal(second.ok, false, '60 outstanding + 60 new > 100 free');
  assert.equal(second.shortageBytes, 20);

  policy.release(dir, 'r1');
  assert.equal(policy.outstandingFor('D:'), 0);
  const retry = policy.reserve(dir, 'r3', 60);
  assert.equal(retry.ok, true);
});

test('reservations on different volumes are independent', () => {
  const policy = new DiskPolicy({
    statVolume: (dir) => (dir.startsWith('C:') ? 100 : 100),
  });

  assert.equal(policy.reserve('C:\\a', 'r1', 90).ok, true);
  assert.equal(policy.reserve('D:\\b', 'r2', 90).ok, true, 'other volume unaffected');
  assert.equal(policy.reserve('C:\\c', 'r3', 20).ok, false, 'C: is full via reservations');
  assert.equal(policy.outstandingFor('C:'), 90);
  assert.equal(policy.outstandingFor('D:'), 90);
});

test('minFreeBytes floor is enforced against projected free space', () => {
  const policy = new DiskPolicy({ minFreeBytes: 10, statVolume: () => 100 });
  assert.equal(policy.reserve('D:\\x', 'r1', 95).ok, false, '95 leaves -5 < 10 floor');
  assert.equal(policy.reserve('D:\\x', 'r1', 90).ok, true, '90 leaves exactly 10');
});

test('check aggregates outstanding bytes excluding the caller reservation', () => {
  const policy = new DiskPolicy({ minFreeBytes: 30, statVolume: () => 100 });
  policy.reserve('D:\\x', 'r1', 70);

  assert.equal(policy.check('D:\\x', 5, { excludeReservationId: 'other' }).ok, false, '70 outstanding + 5 new leaves -5 < 30 floor');
  assert.equal(policy.check('D:\\x', 5, { excludeReservationId: 'r1' }).ok, true, 'own reservation is excluded from projection');
});

test('unknown volume and unknown capacity are visible-unknown, not false', () => {
  const policy = new DiskPolicy({ statVolume: () => 100 });

  const unknownVolume = policy.reserve('relative/dir', 'r1', 50);
  assert.equal(unknownVolume.ok, true);
  assert.equal(unknownVolume.unknownVolume, true);

  const noStat = new DiskPolicy({ statVolume: () => null });
  const unknownCapacity = noStat.reserve('D:\\x', 'r2', 50);
  assert.equal(unknownCapacity.ok, true);
  assert.equal(unknownCapacity.unknownCapacity, true);
});

test('volume keys fold drive case and separate UNC roots', () => {
  const policy = new DiskPolicy({ statVolume: () => 100 });
  policy.reserve('d:\\share', 'r1', 10);
  assert.equal(policy.outstandingFor('D:'), 10, 'lowercase drive folds to same volume key');
  policy.reserve('\\\\server\\share\\dir', 'r2', 10);
  assert.equal(policy.outstandingFor('\\\\SERVER\\SHARE'), 10);
});
