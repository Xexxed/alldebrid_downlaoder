/**
 * Automated Verification Script for Parser, Folder Structure Preservation, and Sanitization
 */

import { parseDownloadInput, flattenFileTree, sanitizePathSegment } from '../server/alldebrid.js';
import assert from 'assert';

console.log('--- Running Tests for AllDebrid Downloader ---');

// Test 1: Sanitization
console.log('Test 1: Sanitization');
assert.strictEqual(sanitizePathSegment('Valid_Folder Name 123'), 'Valid_Folder Name 123');
assert.strictEqual(sanitizePathSegment('Bad:Folder/Name*With?Invalid<Chars>|'), 'Bad_Folder_Name_With_Invalid_Chars_');
assert.strictEqual(sanitizePathSegment('...'), '_');
console.log('✅ Sanitization passed');

// Test 2: Parsing Inputs
console.log('Test 2: Input Parsing');
const rawInput = `
https://alldebrid.com/getMagnet/685554127
http://alldebrid.com/getMagnet/99887766
getMagnet/11223344
magnet:?xt=urn:btih:842783e3005495d5d1637f5364b59343c7844707&dn=Ubuntu
842783e3005495d5d1637f5364b59343c7844707
5544332211
https://rapidgator.net/file/12345/test.zip
`;

const parsed = parseDownloadInput(rawInput);
assert.strictEqual(parsed.length, 7);

assert.strictEqual(parsed[0].type, 'getMagnet');
assert.strictEqual(parsed[0].id, 685554127);

assert.strictEqual(parsed[1].type, 'getMagnet');
assert.strictEqual(parsed[1].id, 99887766);

assert.strictEqual(parsed[2].type, 'getMagnet');
assert.strictEqual(parsed[2].id, 11223344);

assert.strictEqual(parsed[3].type, 'magnet');
assert.ok(parsed[3].uri.includes('842783e3005495d5d1637f5364b59343c7844707'));

assert.strictEqual(parsed[4].type, 'magnet');
assert.ok(parsed[4].uri.includes('842783e3005495d5d1637f5364b59343c7844707'));

assert.strictEqual(parsed[5].type, 'magnetId');
assert.strictEqual(parsed[5].id, 5544332211);

assert.strictEqual(parsed[6].type, 'directLink');
assert.strictEqual(parsed[6].url, 'https://rapidgator.net/file/12345/test.zip');

console.log('✅ Input parsing passed');

// Test 3: Recursive Folder Tree Flattening & Subfolder Preservation
console.log('Test 3: Recursive Folder Tree Flattening');

const sampleFilesTree = [
  {
    n: 'Season 01',
    e: [
      {
        n: 'Episode 01 - Pilot.mkv',
        s: 104857600,
        l: 'https://alldebrid.com/f/ep01',
      },
      {
        n: 'Episode 02 - The Story.mkv',
        s: 104857600,
        l: 'https://alldebrid.com/f/ep02',
      },
      {
        n: 'Subtitles',
        e: [
          {
            n: 'ep01.en.srt',
            s: 20480,
            l: 'https://alldebrid.com/f/sub01',
          },
          {
            n: 'ep02.en.srt',
            s: 20480,
            l: 'https://alldebrid.com/f/sub02',
          },
        ],
      },
    ],
  },
  {
    n: 'Extras',
    e: [
      {
        n: 'Bonus Feature.mp4',
        s: 52428800,
        l: 'https://alldebrid.com/f/bonus',
      },
    ],
  },
  {
    n: 'readme.txt',
    s: 1024,
    l: 'https://alldebrid.com/f/readme',
  },
];

const flattened = flattenFileTree(sampleFilesTree);
assert.strictEqual(flattened.length, 6);

assert.strictEqual(flattened[0].name, 'Episode 01 - Pilot.mkv');
assert.strictEqual(flattened[0].relativePath, 'Season 01/Episode 01 - Pilot.mkv');
assert.strictEqual(flattened[0].size, 104857600);
assert.strictEqual(flattened[0].link, 'https://alldebrid.com/f/ep01');

assert.strictEqual(flattened[2].name, 'ep01.en.srt');
assert.strictEqual(flattened[2].relativePath, 'Season 01/Subtitles/ep01.en.srt');

assert.strictEqual(flattened[4].name, 'Bonus Feature.mp4');
assert.strictEqual(flattened[4].relativePath, 'Extras/Bonus Feature.mp4');

assert.strictEqual(flattened[5].name, 'readme.txt');
assert.strictEqual(flattened[5].relativePath, 'readme.txt');

console.log('✅ Recursive Folder Tree flattening & path preservation passed');
console.log('--- ALL UNIT TESTS PASSED SUCCESSFULLY! ---');
