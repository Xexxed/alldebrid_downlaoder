import assert from 'node:assert/strict';
import test from 'node:test';
import { AllDebridClient, fetchRapidgatorFolder } from '../server/alldebrid.js';
import { searchAggregator } from '../server/search.js';

async function withFixtureFetch(fixtures, run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const calls = [];
  const unexpected = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    calls.push(url);
    if (!fixtures.has(url) || (options.method && options.method !== 'GET')) {
      unexpected.push(url);
      throw new Error('Unexpected fixture request');
    }
    const body = fixtures.get(url);
    return {
      ok: true,
      status: 200,
      json: async () => structuredClone(body),
      text: async () => body,
    };
  };
  try {
    await run(calls);
    assert.deepEqual(unexpected, []);
  } finally {
    if (original) Object.defineProperty(globalThis, 'fetch', original);
    else delete globalThis.fetch;
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'fetch'), original);
  }
}

function assertUnknown(result) {
  assert.equal(result.availability, 'unknown');
  assert.equal(result.checkedAt, null);
  assert.equal(result.provider, 'alldebrid');
  assert.equal(result.reason, 'read_only_availability_unavailable');
}

test('availability returns one unknown per input without uploads or API requests', async () => {
  const hash = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
  const magnet = `magnet:?xt=urn:btih:${hash}&dn=fixture`;
  const client = new AllDebridClient('fixture-only');
  let uploads = 0;
  let requests = 0;
  client.uploadMagnet = async () => {
    uploads++;
    return { magnets: [] };
  };
  client._request = async () => {
    requests++;
    throw new Error('API requests forbidden');
  };
  await withFixtureFetch(new Map(), async (calls) => {
    for (const input of [hash, magnet, [hash, magnet, hash], []]) {
      const expected = Array.isArray(input) ? input : [input];
      const results = await client.checkInstantAvailability(input);
      assert.equal(results.length, expected.length);
      assert.deepEqual(results.map((result) => result.magnet), expected);
      for (const result of results) {
        assertUnknown(result);
        assert.equal(result.hash, hash.toLowerCase());
        assert.equal(result.ready, null);
        assert.equal(result.name, null);
        assert.equal(result.size, null);
        assert.equal(result.id, undefined);
      }
    }
    const unconfigured = await new AllDebridClient('').checkInstantAvailability(hash);
    assert.equal(unconfigured.length, 1);
    assertUnknown(unconfigured[0]);
    assert.equal(uploads, 0);
    assert.equal(requests, 0);
    assert.deepEqual(calls, []);
  });
});

test('search never invokes legacy availability or uploads and preserves unknown beyond 60 results', async () => {
  const items = Array.from({ length: 65 }, (_, index) => ({
    name: `Fixture ${index}`,
    info_hash: (index + 1).toString(16).padStart(40, '0'),
    size: '1024',
    seeders: String(index),
    category: '401',
  }));
  let uploads = 0;
  let checks = 0;
  const client = {
    async uploadMagnet() {
      uploads++;
      return { magnets: [] };
    },
    async checkInstantAvailability() {
      checks++;
      return this.uploadMagnet();
    },
  };
  const fixtures = new Map([
    ['https://apibay.org/q.php?q=fixture', [...items, items[0]]],
  ]);
  await withFixtureFetch(fixtures, async (calls) => {
    for (const alldebridClient of [client, null]) {
      for (const onlyCached of [false, true]) {
        const result = await searchAggregator(' fixture ', {
          category: 'games',
          alldebridClient,
          onlyCached,
          jackettUrl: '',
          jackettApiKey: '',
        });
        assert.equal(result.query, 'fixture');
        assert.equal(result.total, onlyCached ? 0 : 65);
        assert.equal(result.results.length, result.total);
        assert.equal(result.instantCount, 0);
        assert.equal(result.unknownCount, 65);
        for (const item of result.results) {
          assertUnknown(item);
          assert.equal(item.instant, null);
          assert.equal(item.alldebridReady, null);
          assert.equal(item.alldebridId, null);
        }
        if (!onlyCached) assert.equal(result.results[0].seeders, 64);
      }
    }
    assert.equal(calls.length, 4);
    assert.equal(uploads, 0);
    assert.equal(checks, 0);
  });
});

test('search without a hash and empty search never report a cache miss', async () => {
  const fixtures = new Map([
    ['https://nyaa.si/?f=0&c=0_0&q=fixture&page=rss', '<rss><channel><item><title>Fixture</title><link>https://fixture.invalid/torrent/1</link></item></channel></rss>'],
  ]);
  await withFixtureFetch(fixtures, async (calls) => {
    const options = { category: 'anime', jackettUrl: '', jackettApiKey: '' };
    const result = await searchAggregator('fixture', options);
    assert.equal(result.total, 1);
    assert.equal(result.unknownCount, 1);
    assert.equal(result.results[0].infoHash, null);
    assert.equal(result.results[0].instant, null);
    assertUnknown(result.results[0]);
    assert.deepEqual(await searchAggregator(' ', options), {
      results: [], total: 0, query: '', instantCount: 0, unknownCount: 0,
    });
    assert.equal(calls.length, 1);
  });
});

test('Rapidgator empty table names and fallback links use the imported path helper', async () => {
  const fixtures = new Map([
    ['https://fixture.invalid/folder/table.html', '<table><tr><td><a href="/file/abc/table.bin.html"><img src="icon.png"></a></td><td>2 KB</td></tr></table>'],
    ['https://fixture.invalid/folder/fallback.html', '<a href="/file/def/fallback.bin.html">Download</a>'],
  ]);
  await withFixtureFetch(fixtures, async (calls) => {
    const table = await fetchRapidgatorFolder('https://fixture.invalid/folder/table.html');
    assert.equal(table.files.length, 1);
    assert.equal(table.files[0].name, 'table.bin');
    assert.equal(table.files[0].relativePath, 'table.bin');
    assert.equal(table.totalSize, 2048);
    const fallback = await fetchRapidgatorFolder('https://fixture.invalid/folder/fallback.html');
    assert.equal(fallback.files.length, 1);
    assert.equal(fallback.files[0].name, 'fallback.bin');
    assert.equal(fallback.files[0].relativePath, 'fallback.bin');
    assert.equal(fallback.files[0].sizeStr, 'Unknown');
    assert.equal(fallback.totalSize, 0);
    assert.equal(calls.length, 2);
  });
});

test('fixture fetch restores the global patch after an assertion failure', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  await assert.rejects(withFixtureFetch(new Map(), async () => {
    assert.fail('fixture failure');
  }), /fixture failure/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'fetch'), original);
});
