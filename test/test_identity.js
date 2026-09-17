/**
 * Stage C identity normalization: base32/hex canonical magnet hashing.
 * Known-answer tests via round-trip conversion and malformed-input guards.
 *
 * Run: node --test test/test_identity.js
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { normalizeMagnetHash, base32ToHex, canonicalIdentity } = await import('../server/search/identity.js');

const HEX = '842783e3005495d5d1637f5364b59343c7844707';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function hexToBase32(hex) {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

test('40-char hex hash normalizes to lowercase hex', () => {
  const result = normalizeMagnetHash('842783E3005495D5D1637F5364B59343C7844707');
  assert.equal(result.hash, HEX);
  assert.equal(result.encoding, 'hex');
});

test('magnet URL hash is extracted and canonicalized', () => {
  const result = normalizeMagnetHash(`magnet:?xt=urn:btih:842783E3005495D5D1637F5364B59343C7844707&dn=name`);
  assert.equal(result.hash, HEX);
  assert.equal(result.encoding, 'hex');
});

test('base32 magnet identity converts to the same hex as its hex twin', () => {
  const base32 = hexToBase32(HEX);
  assert.equal(base32.length, 32);
  const fromB32 = normalizeMagnetHash(`magnet:?xt=urn:btih:${base32}`);
  assert.equal(fromB32.encoding, 'base32');
  assert.equal(fromB32.hash, HEX, 'base32 and hex forms of one infohash are identical canonically');
});

test('base32ToHex output is 40-char lowercase hex or null', () => {
  const hex = base32ToHex(hexToBase32(HEX));
  assert.equal(hex, HEX);
  assert.equal(base32ToHex('!!!!'), null, 'invalid alphabet rejected');
  assert.equal(base32ToHex('A'), null, 'too short rejected');
});

test('malformed inputs return null, never a guessed hash', () => {
  assert.equal(normalizeMagnetHash('not-a-hash'), null);
  assert.equal(normalizeMagnetHash(''), null);
  assert.equal(normalizeMagnetHash('magnet:?dn=only-name'), null);
  assert.equal(normalizeMagnetHash('842783e3005495d5d1637f5364b59343c78447'), null, '39 chars rejected');
  assert.equal(normalizeMagnetHash('01890189018901890189018901890189'), null, 'chars outside RFC4648 alphabet rejected');
  assert.equal(normalizeMagnetHash(null), null);
  assert.equal(normalizeMagnetHash(42), null);
});

test('canonicalIdentity wrapper returns hash only', () => {
  assert.equal(canonicalIdentity('magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 'a'.repeat(40));
  assert.equal(canonicalIdentity('garbage'), null);
});
